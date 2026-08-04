import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  dispatcherLeaseSchema,
  queueItemSchema,
  type DispatcherLease,
  type QueueItem,
  type QueueItemStatus,
} from "../contracts/queue.js";
import type { JobContract } from "../contracts/job.js";
import { isProcessAlive } from "../runtime/process-runner.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import {
  commitTransition,
  readLatestTransition,
  TransitionConflictError,
  type TransitionFailpoint,
} from "../storage/transitions.js";

export class QueueStore {
  readonly root: string;

  constructor(
    readonly artifacts: ArtifactStore,
    root = path.join(artifacts.root, "queue"),
    private readonly options: {
      transitionFailpoint?: TransitionFailpoint;
    } = {},
  ) {
    this.root = path.resolve(root);
    if (this.root.startsWith("\\\\")) {
      throw new Error(
        "Conductor queue data must use a local filesystem; UNC roots are unsupported",
      );
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.itemsRoot(), { recursive: true });
  }

  async enqueue(
    contract: JobContract,
    options: { priority: number; dependsOnJobIds: string[] },
  ): Promise<{ item: QueueItem; created: boolean }> {
    await this.initialize();
    const directory = this.itemDirectory(contract.jobId);
    const staging = `${directory}.reserve-${process.pid}-${randomUUID()}`;
    const now = new Date().toISOString();
    const item = queueItemSchema.parse({
      schema: "conductor.queue-item/v2",
      jobId: contract.jobId,
      status: "queued",
      revision: 0,
      priority: options.priority,
      dependsOnJobIds: [...new Set(options.dependsOnJobIds)].sort(),
      createdAt: now,
      updatedAt: now,
    });

    try {
      await mkdir(staging);
      await this.artifacts.writeJsonAtomic(
        path.join(staging, "queue.json"),
        item,
      );
      await rename(staging, directory);
      return { item, created: true };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      try {
        const existing = await this.read(contract.jobId);
        if (
          existing.priority !== item.priority ||
          JSON.stringify(existing.dependsOnJobIds) !==
            JSON.stringify(item.dependsOnJobIds)
        ) {
          throw new Error(
            `Queue options conflict with existing item ${contract.jobId}`,
          );
        }
        return { item: existing, created: false };
      } catch (readError) {
        if (
          readError instanceof Error &&
          readError.message.startsWith("Queue options conflict")
        ) {
          throw readError;
        }
        throw error;
      }
    }
  }

  async read(jobId: string): Promise<QueueItem> {
    const projection = queueItemSchema.parse(
      JSON.parse(await readFile(this.itemPath(jobId), "utf8")),
    );
    const latest = await readLatestTransition({
      recordKind: "queue-item",
      recordId: jobId,
      transitionsRoot: this.itemTransitionsRoot(jobId),
      snapshotName: "queue.json",
      parse: (value) => queueItemSchema.parse(value),
      revisionOf: (value) => value.revision,
    });
    if (!latest) return projection;
    if (latest.revision < projection.revision) {
      throw new Error(
        `Queue item ${jobId} projection revision ${projection.revision} is ahead of its transition journal ${latest.revision}`,
      );
    }
    return latest;
  }

  async list(): Promise<QueueItem[]> {
    await this.initialize();
    const entries = await readdir(this.itemsRoot(), { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter(
          (entry) => entry.isDirectory() && !entry.name.includes(".reserve-"),
        )
        .map((entry) => this.read(entry.name)),
    );
    return items.sort(
      (left, right) =>
        right.priority - left.priority ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.jobId.localeCompare(right.jobId),
    );
  }

  async update(item: QueueItem, patch: Partial<QueueItem>): Promise<QueueItem> {
    const current = await this.read(item.jobId);
    if (
      current.revision !== item.revision ||
      JSON.stringify(current) !== JSON.stringify(item)
    ) {
      throw new TransitionConflictError(
        "queue-item",
        item.jobId,
        item.revision,
        current.revision,
      );
    }
    const updated = queueItemSchema.parse({
      ...current,
      ...patch,
      schema: "conductor.queue-item/v2",
      jobId: current.jobId,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    assertQueueTransition(current.status, updated.status);
    await commitTransition({
      recordKind: "queue-item",
      recordId: current.jobId,
      expectedRevision: current.revision,
      value: updated,
      transitionsRoot: this.itemTransitionsRoot(current.jobId),
      snapshotName: "queue.json",
      projectionPath: this.itemPath(current.jobId),
      writeJsonAtomic: (target, value) =>
        this.artifacts.writeJsonAtomic(target, value),
      failpoint: this.options.transitionFailpoint,
    });
    return updated;
  }

  async acquireLease(
    ownerId: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<DispatcherLease | undefined> {
    await this.initialize();
    const directory = this.leaseDirectory();
    try {
      await mkdir(directory);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      )) {
        throw error;
      }
      let existing: DispatcherLease;
      try {
        existing = await this.readLease();
      } catch {
        const lockAge = now.getTime() - (await stat(directory)).mtimeMs;
        if (lockAge <= leaseMs) return undefined;
        return undefined;
      }
      if (Date.parse(existing.expiresAt) > now.getTime()) return undefined;
      if (existing.hostname !== os.hostname()) return undefined;
      if (isProcessAlive(existing.processId)) return undefined;
      return this.stealLease(directory, ownerId, leaseMs, now);
    }
    try {
      const generation = await this.nextLeaseGeneration();
      const lease = createLease(ownerId, generation, leaseMs, now);
      await this.artifacts.writeJsonAtomic(this.leasePath(), lease);
      return lease;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async renewLease(
    lease: DispatcherLease,
    leaseMs: number,
    now = new Date(),
  ): Promise<DispatcherLease> {
    const current = await this.readLease();
    if (!sameLease(current, lease)) {
      throw new Error(
        `Dispatcher lease generation ${lease.generation} is no longer current`,
      );
    }
    if (
      current.hostname !== os.hostname() ||
      current.processId !== process.pid
    ) {
      throw new Error("Dispatcher lease cannot be renewed by another process");
    }
    const renewed = dispatcherLeaseSchema.parse({
      ...current,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    });
    await this.artifacts.writeJsonAtomic(this.leasePath(), renewed);
    return renewed;
  }

  async releaseLease(lease: DispatcherLease): Promise<void> {
    let current: DispatcherLease;
    try {
      current = await this.readLease();
    } catch {
      return;
    }
    if (!sameLease(current, lease)) return;
    const releasing = `${this.leaseDirectory()}.release-${lease.instanceId}`;
    try {
      await rename(this.leaseDirectory(), releasing);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    const moved = dispatcherLeaseSchema.parse(
      JSON.parse(await readFile(path.join(releasing, "lease.json"), "utf8")),
    );
    if (!sameLease(moved, lease)) {
      throw new Error("Lease identity changed during release");
    }
    await rm(releasing, { recursive: true, force: true });
  }

  itemPath(jobId: string): string {
    return path.join(this.itemDirectory(jobId), "queue.json");
  }

  itemTransitionsRoot(jobId: string): string {
    return path.join(this.itemDirectory(jobId), "transitions");
  }

  private itemDirectory(jobId: string): string {
    return path.join(this.itemsRoot(), safeSegment(jobId));
  }

  private itemsRoot(): string {
    return path.join(this.root, "items");
  }

  private leaseDirectory(): string {
    return path.join(this.root, "dispatcher.lock");
  }

  private leasePath(): string {
    return path.join(this.leaseDirectory(), "lease.json");
  }

  private generationPath(): string {
    return path.join(this.root, "lease-generation.json");
  }

  private async readLease(): Promise<DispatcherLease> {
    return dispatcherLeaseSchema.parse(
      JSON.parse(await readFile(this.leasePath(), "utf8")),
    );
  }

  private async stealLease(
    directory: string,
    ownerId: string,
    leaseMs: number,
    now: Date,
  ): Promise<DispatcherLease | undefined> {
    const stale = `${directory}.stale-${randomUUID()}`;
    try {
      await rename(directory, stale);
    } catch {
      return undefined;
    }
    await rm(stale, { recursive: true, force: true });
    return this.acquireLease(ownerId, leaseMs, now);
  }

  private async nextLeaseGeneration(): Promise<number> {
    let generation = 0;
    try {
      const current = JSON.parse(
        await readFile(this.generationPath(), "utf8"),
      ) as { generation?: unknown };
      if (
        !Number.isSafeInteger(current.generation) ||
        Number(current.generation) < 1
      ) {
        throw new Error("Invalid lease generation record");
      }
      generation = Number(current.generation);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
    const next = generation + 1;
    await this.artifacts.writeJsonAtomic(this.generationPath(), {
      schema: "conductor.lease-generation/v1",
      generation: next,
    });
    return next;
  }
}

const allowedQueueTransitions: Record<QueueItemStatus, QueueItemStatus[]> = {
  queued: ["queued", "dispatching", "cancelled", "needs-input"],
  dispatching: ["dispatching", "queued", "running", "cancelled", "needs-input"],
  running: [
    "running",
    "queued",
    "cancelling",
    "completed",
    "failed",
    "needs-input",
    "cancelled",
  ],
  cancelling: ["cancelling", "completed", "failed", "needs-input", "cancelled"],
  completed: ["completed", "queued"],
  failed: ["failed", "queued"],
  "needs-input": ["needs-input", "queued"],
  cancelled: ["cancelled", "queued"],
};

function assertQueueTransition(
  current: QueueItemStatus,
  next: QueueItemStatus,
): void {
  if (!allowedQueueTransitions[current].includes(next)) {
    throw new Error(`Illegal queue transition: ${current} -> ${next}`);
  }
}

function createLease(
  ownerId: string,
  generation: number,
  leaseMs: number,
  now: Date,
): DispatcherLease {
  return dispatcherLeaseSchema.parse({
    schema: "conductor.dispatcher-lease/v2",
    ownerId,
    instanceId: randomUUID(),
    generation,
    hostname: os.hostname(),
    processId: process.pid,
    processStartedAt: new Date(
      Date.now() - Math.round(process.uptime() * 1_000),
    ).toISOString(),
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  });
}

function sameLease(left: DispatcherLease, right: DispatcherLease): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.instanceId === right.instanceId &&
    left.generation === right.generation
  );
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new Error(`Unsafe queue path segment: ${value}`);
  }
  return value;
}
