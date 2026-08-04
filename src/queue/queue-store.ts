import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  dispatcherLeaseSchema,
  queueItemSchema,
  type DispatcherLease,
  type QueueItem,
} from "../contracts/queue.js";
import type { JobContract } from "../contracts/job.js";
import { ArtifactStore } from "../storage/artifact-store.js";

export class QueueStore {
  readonly root: string;

  constructor(
    readonly artifacts: ArtifactStore,
    root = path.join(artifacts.root, "queue"),
  ) {
    this.root = path.resolve(root);
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
      schema: "conductor.queue-item/v1",
      jobId: contract.jobId,
      status: "queued",
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
    return queueItemSchema.parse(
      JSON.parse(await readFile(this.itemPath(jobId), "utf8")),
    );
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
    const updated = queueItemSchema.parse({
      ...item,
      ...patch,
      jobId: item.jobId,
      updatedAt: new Date().toISOString(),
    });
    await this.artifacts.writeJsonAtomic(this.itemPath(item.jobId), updated);
    return updated;
  }

  async acquireLease(
    ownerId: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<DispatcherLease | undefined> {
    await this.initialize();
    const directory = this.leaseDirectory();
    const lease = createLease(ownerId, leaseMs, now);
    try {
      await mkdir(directory);
      await this.artifacts.writeJsonAtomic(this.leasePath(), lease);
      return lease;
    } catch {
      let existing: DispatcherLease;
      try {
        existing = await this.readLease();
      } catch {
        const lockAge = now.getTime() - (await stat(directory)).mtimeMs;
        if (lockAge <= leaseMs) return undefined;
        return this.stealLease(directory, ownerId, leaseMs, now);
      }
      if (Date.parse(existing.expiresAt) > now.getTime()) return undefined;
      return this.stealLease(directory, ownerId, leaseMs, now);
    }
  }

  async renewLease(
    ownerId: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<DispatcherLease> {
    const current = await this.readLease();
    if (current.ownerId !== ownerId) {
      throw new Error(`Dispatcher lease is owned by ${current.ownerId}`);
    }
    const renewed = dispatcherLeaseSchema.parse({
      ...current,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    });
    await this.artifacts.writeJsonAtomic(this.leasePath(), renewed);
    return renewed;
  }

  async releaseLease(ownerId: string): Promise<void> {
    let current: DispatcherLease;
    try {
      current = await this.readLease();
    } catch {
      return;
    }
    if (current.ownerId !== ownerId) return;
    await rm(this.leaseDirectory(), { recursive: true, force: true });
  }

  itemPath(jobId: string): string {
    return path.join(this.itemDirectory(jobId), "queue.json");
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
}

function createLease(
  ownerId: string,
  leaseMs: number,
  now: Date,
): DispatcherLease {
  return dispatcherLeaseSchema.parse({
    schema: "conductor.dispatcher-lease/v1",
    ownerId,
    processId: process.pid,
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  });
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new Error(`Unsafe queue path segment: ${value}`);
  }
  return value;
}
