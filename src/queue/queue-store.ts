import { createHash, randomUUID } from "node:crypto";
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
import {
  leaseEvidenceRecordSchema,
  leaseInspectionSchema,
  leaseReconciliationActionSchema,
  reconciliationMutexEvidenceSchema,
  reconciliationMutexSchema,
  type LeaseEvidenceRecord,
  type LeaseInspection,
  type LeaseReconciliationAction,
  type ReconciliationActionProposal,
  type ReconciliationMutex,
} from "../contracts/reconcile.js";
import { isProcessAlive } from "../runtime/process-runner.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import {
  commitTransition,
  readLatestTransition,
  TransitionConflictError,
  type TransitionFailpoint,
} from "../storage/transitions.js";

export class LeaseReconciliationRequiredError extends Error {
  constructor(readonly inspection: LeaseInspection) {
    super(
      `Dispatcher lease ${inspection.state} requires reconciliation: ${inspection.detail}`,
    );
    this.name = "LeaseReconciliationRequiredError";
  }
}

export class ReconciliationConflictError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ReconciliationConflictError";
  }
}

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
    return this.commitQueueUpdate(item, patch, (current, updated) =>
      assertQueueTransition(current.status, updated.status),
    );
  }

  async reconcile(
    item: QueueItem,
    patch: Partial<QueueItem>,
    actionKind:
      | "reset-abandoned-queue-item"
      | "quarantine-queue-item"
      | "bind-queue-to-attempt"
      | "synchronize-queue-from-terminal-attempt",
  ): Promise<QueueItem> {
    return this.commitQueueUpdate(item, patch, (current, updated) =>
      assertQueueReconciliationTransition(actionKind, current, updated),
    );
  }

  private async commitQueueUpdate(
    item: QueueItem,
    patch: Partial<QueueItem>,
    validateTransition: (current: QueueItem, updated: QueueItem) => void,
  ): Promise<QueueItem> {
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
    validateTransition(current, updated);
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
      const inspection = await this.inspectLease(leaseMs, now);
      if (inspection.state === "recoverable-dead-local") {
        return this.recoverDeadLease(inspection, ownerId, leaseMs, now);
      }
      if (["corrupt", "incomplete"].includes(inspection.state)) {
        throw new LeaseReconciliationRequiredError(inspection);
      }
      return undefined;
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

  async inspectLease(
    leaseMs: number,
    now = new Date(),
  ): Promise<LeaseInspection> {
    const observedAt = now.toISOString();
    const lockDirectory = this.leaseDirectory();
    let directoryStat;
    try {
      directoryStat = await stat(lockDirectory);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return leaseInspectionSchema.parse({
          schema: "conductor.lease-inspection/v1",
          state: "absent",
          observedAt,
          lockDirectory,
          automaticAction: "create",
          detail: "No dispatcher lease directory exists",
        });
      }
      throw error;
    }

    const ageMs = Math.max(
      0,
      Math.round(now.getTime() - directoryStat.mtimeMs),
    );
    let raw: string;
    try {
      raw = await readFile(this.leasePath(), "utf8");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const evidenceToken = leaseEvidenceToken({
        raw: undefined,
        directoryStat,
      });
      const state = ageMs <= leaseMs ? "initializing" : "incomplete";
      return leaseInspectionSchema.parse({
        schema: "conductor.lease-inspection/v1",
        state,
        observedAt,
        lockDirectory,
        ageMs,
        evidenceToken,
        automaticAction: state === "initializing" ? "wait" : "none",
        detail:
          state === "initializing"
            ? "Lease directory is still within its initialization grace period"
            : "Lease directory outlived its grace period without lease.json",
        ownerAction:
          state === "incomplete"
            ? createLeaseQuarantineAction(
                state,
                evidenceToken,
                "Quarantine the incomplete dispatcher lease after the owner verifies that no active dispatcher is initializing it",
              )
            : undefined,
      });
    }

    const evidenceToken = leaseEvidenceToken({ raw, directoryStat });
    let lease: DispatcherLease;
    try {
      lease = dispatcherLeaseSchema.parse(JSON.parse(raw));
    } catch (error) {
      return leaseInspectionSchema.parse({
        schema: "conductor.lease-inspection/v1",
        state: "corrupt",
        observedAt,
        lockDirectory,
        ageMs,
        evidenceToken,
        automaticAction: "none",
        detail: `lease.json is not a valid dispatcher lease: ${errorMessage(error)}`,
        ownerAction:
          ageMs > leaseMs
            ? createLeaseQuarantineAction(
                "corrupt",
                evidenceToken,
                "Quarantine the unreadable dispatcher lease after the owner verifies that it does not represent an active dispatcher",
              )
            : undefined,
      });
    }

    if (lease.hostname !== os.hostname()) {
      return leaseInspectionSchema.parse({
        schema: "conductor.lease-inspection/v1",
        state: "active-remote",
        observedAt,
        lockDirectory,
        ageMs,
        evidenceToken,
        lease,
        automaticAction: "wait",
        detail:
          "Lease belongs to another host; local PID evidence cannot authorize recovery",
      });
    }
    if (isProcessAlive(lease.processId)) {
      const expired = Date.parse(lease.expiresAt) <= now.getTime();
      return leaseInspectionSchema.parse({
        schema: "conductor.lease-inspection/v1",
        state: expired ? "expired-live-local" : "active-local",
        observedAt,
        lockDirectory,
        ageMs,
        evidenceToken,
        lease,
        automaticAction: "wait",
        detail: expired
          ? "Lease heartbeat expired but its same-host owner process is alive; suspend-safe recovery refuses to steal it"
          : "Lease has a live same-host owner",
      });
    }
    return leaseInspectionSchema.parse({
      schema: "conductor.lease-inspection/v1",
      state: "recoverable-dead-local",
      observedAt,
      lockDirectory,
      ageMs,
      evidenceToken,
      lease,
      automaticAction: "recover-dead-owner",
      detail:
        "Lease owner process is absent on this host; expiry time cannot override direct absence evidence",
    });
  }

  async quarantineUnreadableLease(
    input: LeaseReconciliationAction,
    leaseMs: number,
    now = new Date(),
  ): Promise<LeaseEvidenceRecord> {
    const action = leaseReconciliationActionSchema.parse(input);
    return this.withLeaseRecoveryLock(async () => {
      const current = await this.inspectLease(leaseMs, now);
      if (
        current.state !== action.proposal.observedState ||
        current.evidenceToken !== action.proposal.evidenceToken ||
        !current.ownerAction
      ) {
        throw new ReconciliationConflictError(
          "Dispatcher lease evidence changed or is not old enough for the requested quarantine",
        );
      }
      return this.preserveLeaseDirectory({
        inspection: current,
        disposition: "owner-quarantined-unreadable",
        recordedAt: now,
        ownerReason: action.approval.reason,
        ownerApprovedBy: action.approval.approvedBy,
        ownerApprovedAt: action.approval.approvedAt,
      });
    });
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

  private async recoverDeadLease(
    expected: LeaseInspection,
    ownerId: string,
    leaseMs: number,
    now: Date,
  ): Promise<DispatcherLease | undefined> {
    try {
      const recovered = await this.withLeaseRecoveryLock(async () => {
        const current = await this.inspectLease(leaseMs, now);
        if (
          current.state !== "recoverable-dead-local" ||
          current.evidenceToken !== expected.evidenceToken
        ) {
          return false;
        }
        await this.preserveLeaseDirectory({
          inspection: current,
          disposition: "recovered-dead-owner",
          recordedAt: now,
        });
        return true;
      });
      if (!recovered) return undefined;
    } catch (error) {
      if (error instanceof ReconciliationConflictError && error.retryable) {
        return undefined;
      }
      throw error;
    }
    return this.acquireLease(ownerId, leaseMs, now);
  }

  private async withLeaseRecoveryLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const mutex = await this.acquireReconciliationMutex();
    try {
      return await operation();
    } finally {
      await this.releaseReconciliationMutex(mutex);
    }
  }

  private async acquireReconciliationMutex(): Promise<ReconciliationMutex> {
    await mkdir(this.root, { recursive: true });
    const mutex = reconciliationMutexSchema.parse({
      schema: "conductor.reconciliation-mutex/v1",
      instanceId: randomUUID(),
      hostname: os.hostname(),
      processId: process.pid,
      acquiredAt: new Date().toISOString(),
    });
    const staging = `${this.leaseRecoveryLockDirectory()}.reserve-${mutex.instanceId}`;
    await mkdir(staging);
    try {
      await this.artifacts.writeJsonAtomic(
        path.join(staging, "owner.json"),
        mutex,
      );
      try {
        await rename(staging, this.leaseRecoveryLockDirectory());
        return mutex;
      } catch (error) {
        if (
          !hasCode(error, "EEXIST") &&
          !hasCode(error, "ENOTEMPTY") &&
          !hasCode(error, "EPERM")
        ) {
          throw error;
        }
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    const existing = await this.readReconciliationMutex();
    if (
      existing.hostname === os.hostname() &&
      !isProcessAlive(existing.processId)
    ) {
      await this.preserveDeadReconciliationMutex(existing);
      return this.acquireReconciliationMutex();
    }
    throw new ReconciliationConflictError(
      existing.hostname === os.hostname()
        ? "Another live lease reconciliation operation is in progress"
        : "A lease reconciliation operation belongs to another host and requires owner review",
      existing.hostname === os.hostname(),
    );
  }

  private async readReconciliationMutex(): Promise<ReconciliationMutex> {
    try {
      return reconciliationMutexSchema.parse(
        JSON.parse(
          await readFile(
            path.join(this.leaseRecoveryLockDirectory(), "owner.json"),
            "utf8",
          ),
        ),
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new ReconciliationConflictError(
          "Reconciliation ownership changed before it could be read",
          true,
        );
      }
      throw new ReconciliationConflictError(
        `Reconciliation ownership evidence is unreadable and requires owner review: ${errorMessage(error)}`,
      );
    }
  }

  private async preserveDeadReconciliationMutex(
    mutex: ReconciliationMutex,
  ): Promise<void> {
    const root = path.join(this.leaseEvidenceRoot(), "reconciliation-locks");
    await mkdir(root, { recursive: true });
    const evidencePath = path.join(root, mutex.instanceId);
    try {
      await rename(this.leaseRecoveryLockDirectory(), evidencePath);
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "EEXIST")) {
        throw new ReconciliationConflictError(
          "Reconciliation ownership changed while recovering its dead owner",
          true,
        );
      }
      throw error;
    }
    const evidence = reconciliationMutexEvidenceSchema.parse({
      schema: "conductor.reconciliation-mutex-evidence/v1",
      disposition: "recovered-dead-owner",
      recordedAt: new Date().toISOString(),
      mutex,
    });
    await this.artifacts.writeJsonAtomic(
      path.join(evidencePath, "reconciliation.json"),
      evidence,
    );
  }

  private async releaseReconciliationMutex(
    mutex: ReconciliationMutex,
  ): Promise<void> {
    let current: ReconciliationMutex;
    try {
      current = await this.readReconciliationMutex();
    } catch (error) {
      if (error instanceof ReconciliationConflictError && error.retryable) {
        return;
      }
      throw error;
    }
    if (current.instanceId !== mutex.instanceId) return;
    const releasing = `${this.leaseRecoveryLockDirectory()}.release-${mutex.instanceId}`;
    try {
      await rename(this.leaseRecoveryLockDirectory(), releasing);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    const moved = reconciliationMutexSchema.parse(
      JSON.parse(await readFile(path.join(releasing, "owner.json"), "utf8")),
    );
    if (moved.instanceId !== mutex.instanceId) {
      throw new ReconciliationConflictError(
        "Reconciliation ownership changed during release",
      );
    }
    await rm(releasing, { recursive: true, force: true });
  }

  private async preserveLeaseDirectory(input: {
    inspection: LeaseInspection;
    disposition: LeaseEvidenceRecord["disposition"];
    recordedAt: Date;
    ownerReason?: string;
    ownerApprovedBy?: string;
    ownerApprovedAt?: string;
  }): Promise<LeaseEvidenceRecord> {
    if (!input.inspection.evidenceToken) {
      throw new ReconciliationConflictError(
        "Lease inspection lacks an evidence token",
      );
    }
    await mkdir(this.leaseEvidenceRoot(), { recursive: true });
    const evidenceId = randomUUID();
    const evidencePath = path.join(
      this.leaseEvidenceRoot(),
      input.inspection.evidenceToken,
    );
    try {
      await rename(this.leaseDirectory(), evidencePath);
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "EEXIST")) {
        throw new ReconciliationConflictError(
          "Dispatcher lease changed before it could be preserved",
        );
      }
      throw error;
    }
    const record = leaseEvidenceRecordSchema.parse({
      schema: "conductor.lease-evidence/v1",
      evidenceId,
      disposition: input.disposition,
      recordedAt: input.recordedAt.toISOString(),
      originalState: input.inspection.state,
      evidenceToken: input.inspection.evidenceToken,
      sourcePath: this.leaseDirectory(),
      evidencePath,
      ownerReason: input.ownerReason,
      ownerApprovedBy: input.ownerApprovedBy,
      ownerApprovedAt: input.ownerApprovedAt,
      lease: input.inspection.lease,
    });
    await this.artifacts.writeJsonAtomic(
      path.join(evidencePath, "reconciliation.json"),
      record,
    );
    return record;
  }

  private leaseEvidenceRoot(): string {
    return path.join(this.root, "lease-evidence");
  }

  private leaseRecoveryLockDirectory(): string {
    return path.join(this.root, "dispatcher.reconcile.lock");
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

function assertQueueReconciliationTransition(
  actionKind:
    | "reset-abandoned-queue-item"
    | "quarantine-queue-item"
    | "bind-queue-to-attempt"
    | "synchronize-queue-from-terminal-attempt",
  current: QueueItem,
  next: QueueItem,
): void {
  const allowed =
    actionKind === "reset-abandoned-queue-item"
      ? ["queued", "dispatching"].includes(current.status) &&
        next.status === "queued" &&
        !next.dispatchOperationId &&
        !next.attemptId &&
        !next.completion
      : actionKind === "quarantine-queue-item"
        ? next.status === "needs-input" &&
          !next.dispatchOperationId &&
          !next.attemptId &&
          !next.completion
        : actionKind === "bind-queue-to-attempt"
          ? current.status === "dispatching" &&
            next.status === "running" &&
            Boolean(next.dispatchOperationId) &&
            Boolean(next.attemptId) &&
            !next.completion
          : ["completed", "failed", "needs-input", "cancelled"].includes(
              next.status,
            ) &&
            Boolean(next.attemptId) &&
            next.completion?.attemptId === next.attemptId;
  if (!allowed) {
    throw new Error(
      `Illegal ${actionKind} queue reconciliation transition: ${current.status} -> ${next.status}`,
    );
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

function leaseEvidenceToken(input: {
  raw?: string;
  directoryStat: { birthtimeMs: number; mtimeMs: number };
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        raw: input.raw ?? null,
        birthtimeMs: input.directoryStat.birthtimeMs,
        mtimeMs: input.directoryStat.mtimeMs,
      }),
    )
    .digest("hex");
}

function createLeaseQuarantineAction(
  observedState: "incomplete" | "corrupt",
  evidenceToken: string,
  description: string,
): ReconciliationActionProposal {
  return {
    schema: "conductor.reconciliation-action-proposal/v1",
    kind: "quarantine-unreadable-dispatcher-lease",
    observedState,
    evidenceToken,
    requiredAuthority: "owner",
    description,
  };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
