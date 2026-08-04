import { randomUUID } from "node:crypto";

import {
  queuedJobRequestSchema,
  type DispatcherLease,
  type QueueItem,
} from "../contracts/queue.js";
import type { RunJobResult } from "../orchestrator/conductor.js";
import { Conductor, ProposalLineageError } from "../orchestrator/conductor.js";
import { QueueStore } from "./queue-store.js";
import { projectQueueCompletion } from "./completion.js";

export interface DispatcherOptions {
  maxConcurrent?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  ownerId?: string;
  failpoint?: DispatchFailpoint;
}

export type DispatchFailpointName =
  | "after-queue-dispatching"
  | "after-attempt-reserved"
  | "after-queue-bound"
  | "after-attempt-claimed";

export type DispatchFailpoint = (
  point: DispatchFailpointName,
  context: {
    jobId: string;
    dispatchOperationId: string;
    attemptId?: string;
  },
) => void | Promise<void>;

export class DispatchFailpointError extends Error {
  constructor(
    readonly point: DispatchFailpointName,
    cause: unknown,
  ) {
    super(
      `Dispatch failpoint ${point}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "DispatchFailpointError";
  }
}

export class DurableDispatcher {
  readonly maxConcurrent: number;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly ownerId: string;
  readonly failpoint?: DispatchFailpoint;
  private readonly active = new Map<string, Promise<void>>();
  private stateMutation: Promise<void> = Promise.resolve();
  private stopped = true;
  private loop?: Promise<void>;
  private lease?: DispatcherLease;

  constructor(
    readonly conductor: Conductor,
    readonly queue: QueueStore,
    options: DispatcherOptions = {},
  ) {
    this.maxConcurrent = boundedInteger(options.maxConcurrent ?? 1, 1, 32);
    this.pollIntervalMs = boundedInteger(
      options.pollIntervalMs ?? 2_000,
      25,
      60_000,
    );
    this.leaseMs = boundedInteger(options.leaseMs ?? 30_000, 1_000, 300_000);
    if (this.leaseMs < this.pollIntervalMs * 3) {
      throw new Error(
        "Dispatcher lease must span at least three poll intervals",
      );
    }
    this.ownerId = options.ownerId ?? `dispatcher_${randomUUID()}`;
    this.failpoint = options.failpoint;
  }

  async enqueue(input: unknown): Promise<{
    item: QueueItem;
    idempotentReplay: boolean;
  }> {
    const parsed = queuedJobRequestSchema.parse(input);
    const { queue, ...request } = parsed;
    const contract = await this.conductor.prepareJob(request);
    if (queue.dependsOnJobIds.includes(contract.jobId)) {
      throw new Error(`Queue item ${contract.jobId} cannot depend on itself`);
    }
    const reservation = await this.queue.enqueue(contract, queue);
    return {
      item: reservation.item,
      idempotentReplay: !reservation.created,
    };
  }

  async submit(input: unknown): Promise<{
    item: QueueItem;
    idempotentReplay: boolean;
  }> {
    if (!this.lease) {
      throw new Error("The dispatcher must own the queue before submission");
    }
    const submission = await this.enqueue(input);
    await this.dispatchAvailable();
    let item = await this.queue.read(submission.item.jobId);
    if (item.status === "running" && item.attemptId) {
      await this.waitForLaunchHandoff(item.attemptId);
      item = await this.queue.read(submission.item.jobId);
    }
    return {
      item,
      idempotentReplay: submission.idempotentReplay,
    };
  }

  async start(): Promise<void> {
    if (this.loop) return;
    await this.acquireLease();
    try {
      this.stopped = false;
      await this.recoverInterruptedItems();
    } catch (error) {
      this.stopped = true;
      await this.releaseLease();
      throw error;
    }
    this.loop = this.runLoop(false)
      .catch(async (error) => {
        await this.cancelActiveAttempts();
        await Promise.allSettled(this.active.values());
        throw error;
      })
      .finally(async () => {
        this.loop = undefined;
        await this.releaseLease();
      });
    void this.loop.catch(() => undefined);
  }

  async stop(options: { cancelActive?: boolean } = {}): Promise<void> {
    this.stopped = true;
    if (options.cancelActive) {
      for (const item of await this.queue.list()) {
        if (["running", "cancelling"].includes(item.status) && item.attemptId) {
          this.conductor.cancelAttempt(item.attemptId);
        }
      }
    }
    await this.loop;
  }

  async runUntilIdle(): Promise<QueueItem[]> {
    if (this.loop) throw new Error("Dispatcher loop is already running");
    await this.acquireLease();
    this.stopped = false;
    try {
      await this.recoverInterruptedItems();
      await this.runLoop(true);
      return this.queue.list();
    } catch (error) {
      await this.cancelActiveAttempts();
      await Promise.allSettled(this.active.values());
      throw error;
    } finally {
      this.stopped = true;
      await this.releaseLease();
    }
  }

  async get(jobId: string): Promise<QueueItem> {
    return this.queue.read(jobId);
  }

  async list(): Promise<QueueItem[]> {
    return this.queue.list();
  }

  async cancel(jobId: string): Promise<QueueItem> {
    return this.withStateLock(async () => {
      const item = await this.queue.read(jobId);
      if (isTerminal(item)) return item;
      if (item.status === "running" && item.attemptId) {
        const cancelling = await this.queue.update(item, {
          status: "cancelling",
          message: "Cancellation requested; awaiting terminal attempt evidence",
        });
        const requested = this.conductor.cancelAttempt(item.attemptId);
        if (!requested) {
          const attempt = await this.conductor.cancelReservedAttempt(
            item.attemptId,
          );
          if (isAttemptTerminal(attempt.status)) {
            return this.queue.update(cancelling, {
              status: "cancelled",
              message: "Cancelled before worker execution",
            });
          }
        }
        return cancelling;
      }
      if (item.status === "cancelling") return item;
      if (item.status === "dispatching" && item.attemptId) {
        await this.conductor.cancelReservedAttempt(item.attemptId);
      }
      return this.queue.update(item, {
        status: "cancelled",
        message: "Cancellation requested",
      });
    });
  }

  async retry(jobId: string): Promise<QueueItem> {
    return this.withStateLock(async () => {
      const item = await this.queue.read(jobId);
      if (!isTerminal(item)) {
        throw new Error(`Queue item ${jobId} is not terminal`);
      }
      if (item.attemptId) {
        const attempt = await this.conductor.getAttempt(item.attemptId);
        if (!isAttemptTerminal(attempt.status)) {
          throw new Error(
            `Attempt ${item.attemptId} is still ${attempt.status}; retry would duplicate active work`,
          );
        }
        await this.conductor.releaseAttemptExternalResources(item.attemptId);
      }
      return this.queue.update(item, {
        status: "queued",
        dispatchOperationId: undefined,
        attemptId: undefined,
        completion: undefined,
        message: undefined,
      });
    });
  }

  private async runLoop(exitWhenIdle: boolean): Promise<void> {
    while (!this.stopped) {
      if (!this.lease) throw new Error("Dispatcher lease is unavailable");
      this.lease = await this.queue.renewLease(this.lease, this.leaseMs);
      const dispatched = await this.dispatchAvailable();
      if (exitWhenIdle && this.active.size === 0 && dispatched === 0) return;
      if (this.active.size > 0) {
        await Promise.race([
          ...this.active.values(),
          delay(this.pollIntervalMs),
        ]);
      } else {
        await delay(this.pollIntervalMs);
      }
    }
    await Promise.allSettled(this.active.values());
  }

  private async dispatchAvailable(): Promise<number> {
    return this.withStateLock(async () => {
      if (!this.lease) throw new Error("Dispatcher lease is unavailable");
      const items = await this.queue.list();
      const byId = new Map(items.map((item) => [item.jobId, item]));
      let dispatched = 0;

      for (const item of items) {
        if (item.status !== "queued" || this.active.has(item.jobId)) continue;
        const dependencies = item.dependsOnJobIds.map((jobId) =>
          byId.get(jobId),
        );
        const failedDependency = dependencies.find(
          (dependency) =>
            dependency &&
            isTerminal(dependency) &&
            dependency.status !== "completed",
        );
        if (failedDependency) {
          await this.queue.update(item, {
            status: "needs-input",
            message: `Dependency ${failedDependency.jobId} ended ${failedDependency.status}`,
          });
          continue;
        }
        if (
          dependencies.some(
            (dependency) => !dependency || dependency.status !== "completed",
          )
        ) {
          continue;
        }
        if (this.active.size >= this.maxConcurrent) break;
        const parentAttemptIds = dependencies.map((dependency) => {
          const attemptId = dependency?.completion?.attemptId;
          if (!attemptId) {
            throw new Error(
              `Completed dependency ${dependency?.jobId ?? "unknown"} lacks attempt evidence`,
            );
          }
          return attemptId;
        });
        const dispatchOperationId = randomUUID();
        const dispatching = await this.queue.update(item, {
          status: "dispatching",
          dispatchOperationId,
          attemptId: undefined,
          message: undefined,
        });
        await this.reachFailpoint("after-queue-dispatching", {
          jobId: item.jobId,
          dispatchOperationId,
        });
        let reserved: RunJobResult;
        try {
          reserved = await this.conductor.reservePreparedAttempt(
            item.jobId,
            parentAttemptIds,
            dispatchOperationId,
          );
        } catch (error) {
          if (error instanceof ProposalLineageError) {
            await this.queue.update(dispatching, {
              status: "needs-input",
              message: `Proposal lineage rejected before reservation: ${error.message}`,
            });
            continue;
          }
          throw error;
        }
        await this.reachFailpoint("after-attempt-reserved", {
          jobId: item.jobId,
          dispatchOperationId,
          attemptId: reserved.attemptId,
        });
        const running = await this.queue.update(dispatching, {
          status: "running",
          attemptId: reserved.attemptId,
        });
        await this.reachFailpoint("after-queue-bound", {
          jobId: item.jobId,
          dispatchOperationId,
          attemptId: reserved.attemptId,
        });
        const execution = this.executeItem(running).finally(() => {
          this.active.delete(item.jobId);
        });
        this.active.set(item.jobId, execution);
        void execution.catch(() => undefined);
        dispatched += 1;
      }
      return dispatched;
    });
  }

  private async executeItem(item: QueueItem): Promise<void> {
    try {
      const started = await this.withStateLock(async () => {
        const current = await this.queue.read(item.jobId);
        if (
          current.status !== "running" ||
          !current.attemptId ||
          !current.dispatchOperationId
        )
          return undefined;
        await this.conductor.claimReservedAttempt(
          current.attemptId,
          current.dispatchOperationId,
        );
        await this.reachFailpoint("after-attempt-claimed", {
          jobId: current.jobId,
          dispatchOperationId: current.dispatchOperationId,
          attemptId: current.attemptId,
        });
        await this.conductor.launchClaimedAttempt(
          current.attemptId,
          current.dispatchOperationId,
        );
        return current;
      });
      if (!started?.attemptId) return;
      const result = await this.conductor.waitForAttempt(started.attemptId);
      await this.withStateLock(() => this.finishItem(started, result));
    } catch (error) {
      if (error instanceof DispatchFailpointError) throw error;
      await this.withStateLock(async () => {
        const current = await this.queue.read(item.jobId);
        if (current.status === "cancelled") return;
        await this.queue.update(current, {
          status: "failed",
          message: errorMessage(error),
        });
      });
    }
  }

  private async finishItem(
    item: QueueItem,
    result: RunJobResult,
  ): Promise<void> {
    await this.queue.update(
      await this.queue.read(item.jobId),
      projectQueueCompletion(result),
    );
  }

  private async recoverInterruptedItems(): Promise<void> {
    const attempts = await this.conductor.listAttempts();
    const byOperation = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      if (!attempt.dispatchOperationId) continue;
      const key = dispatchKey(attempt.jobId, attempt.dispatchOperationId);
      const matching = byOperation.get(key) ?? [];
      matching.push(attempt);
      byOperation.set(key, matching);
    }

    for (const item of await this.queue.list()) {
      if (item.status !== "dispatching") continue;
      if (!item.dispatchOperationId) {
        await this.queue.update(item, {
          status: "needs-input",
          message: "Dispatching item lacks a durable operation identity",
        });
        continue;
      }
      const matching =
        byOperation.get(dispatchKey(item.jobId, item.dispatchOperationId)) ??
        [];
      if (matching.length === 0) {
        await this.queue.update(item, {
          status: "queued",
          dispatchOperationId: undefined,
          attemptId: undefined,
          message:
            "Recovered dispatch intent written before attempt reservation",
        });
        continue;
      }
      if (matching.length !== 1) {
        await this.queue.update(item, {
          status: "needs-input",
          message: `Dispatch operation ${item.dispatchOperationId} owns ${matching.length} attempts; automatic launch is prohibited`,
        });
        continue;
      }
      await this.queue.update(item, {
        status: "running",
        attemptId: matching[0]!.attemptId,
        message: "Recovered queue-to-attempt binding from dispatch operation",
      });
    }

    for (const item of await this.queue.list()) {
      if (!["running", "cancelling"].includes(item.status)) continue;
      if (!item.attemptId) {
        await this.queue.update(item, {
          status: "needs-input",
          message: `${item.status} item lacks an attempt identity`,
        });
        continue;
      }
      const manifest = await this.conductor.getAttempt(item.attemptId);
      if (isAttemptTerminal(manifest.status)) {
        await this.finishItem(
          item,
          await this.conductor.waitForAttempt(item.attemptId),
        );
        continue;
      }
      const recovery = await this.conductor.recoverInterruptedAttempt(
        item.attemptId,
      );
      if (recovery.disposition === "safe-to-retry") {
        const contract = await this.conductor.store.readJob(item.jobId);
        if (
          item.status !== "cancelling" &&
          item.automaticRetryCount >= contract.resources.maxAutomaticRetries
        ) {
          await this.queue.update(item, {
            status: "needs-input",
            message: `Automatic retry budget exhausted after ${item.automaticRetryCount} retries; owner review is required`,
          });
          continue;
        }
        await this.queue.update(item, {
          status: item.status === "cancelling" ? "cancelled" : "queued",
          dispatchOperationId: undefined,
          attemptId: item.status === "cancelling" ? item.attemptId : undefined,
          completion: undefined,
          automaticRetryCount:
            item.status === "cancelling"
              ? item.automaticRetryCount
              : item.automaticRetryCount + 1,
          message:
            item.status === "cancelling"
              ? `Recovered and cancelled orphan ${item.attemptId}`
              : `Recovered orphan ${item.attemptId}; a new attempt is safe`,
        });
      } else {
        const cleanupStatus = await this.conductor
          .getAttemptCleanup(item.attemptId)
          .then((cleanup) => cleanup.status)
          .catch(() => "unknown" as const);
        await this.queue.update(item, {
          status: "needs-input",
          message:
            recovery.disposition === "still-running"
              ? `Guardian ${recovery.manifest.guardian?.guardianPid} for ${item.attemptId} is still alive; automatic duplication is prohibited`
              : `Attempt ${item.attemptId} cleanup is ${cleanupStatus}; automatic duplication is prohibited`,
        });
      }
    }

    const referenced = new Set(
      (await this.queue.list())
        .map((item) => item.attemptId)
        .filter((attemptId): attemptId is string => Boolean(attemptId)),
    );
    for (const attempt of attempts) {
      if (
        isAttemptTerminal(attempt.status) ||
        referenced.has(attempt.attemptId)
      )
        continue;
      await this.conductor.recoverInterruptedAttempt(attempt.attemptId);
    }
  }

  private async acquireLease(): Promise<void> {
    const lease = await this.queue.acquireLease(this.ownerId, this.leaseMs);
    if (!lease) throw new Error("Another Conductor dispatcher owns the queue");
    this.lease = lease;
  }

  private async releaseLease(): Promise<void> {
    if (!this.lease) return;
    const lease = this.lease;
    this.lease = undefined;
    await this.queue.releaseLease(lease);
  }

  private async cancelActiveAttempts(): Promise<void> {
    for (const item of await this.queue.list()) {
      if (["running", "cancelling"].includes(item.status) && item.attemptId) {
        this.conductor.cancelAttempt(item.attemptId);
      }
    }
  }

  private async reachFailpoint(
    point: DispatchFailpointName,
    context: {
      jobId: string;
      dispatchOperationId: string;
      attemptId?: string;
    },
  ): Promise<void> {
    if (!this.failpoint) return;
    try {
      await this.failpoint(point, context);
    } catch (error) {
      throw new DispatchFailpointError(point, error);
    }
  }

  private async waitForLaunchHandoff(attemptId: string): Promise<void> {
    const deadline = Date.now() + Math.min(this.leaseMs, 5_000);
    while (Date.now() < deadline) {
      const attempt = await this.conductor.getAttempt(attemptId);
      if (!["reserved", "claimed"].includes(attempt.status)) return;
      await delay(5);
    }
    throw new Error(`Attempt ${attemptId} did not complete its launch handoff`);
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateMutation;
    let release!: () => void;
    this.stateMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isTerminal(item: QueueItem): boolean {
  return ["completed", "failed", "needs-input", "cancelled"].includes(
    item.status,
  );
}

function isAttemptTerminal(status: string): boolean {
  return ["completed", "failed", "needs-input", "cancelled"].includes(status);
}

function dispatchKey(jobId: string, dispatchOperationId: string): string {
  return `${jobId}\0${dispatchOperationId}`;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
