import { randomUUID } from "node:crypto";

import {
  queuedJobRequestSchema,
  type DispatcherLease,
  type QueueItem,
} from "../contracts/queue.js";
import type { RunJobResult } from "../orchestrator/conductor.js";
import { Conductor, ProposalLineageError } from "../orchestrator/conductor.js";
import { QueueStore } from "./queue-store.js";

export interface DispatcherOptions {
  maxConcurrent?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  ownerId?: string;
}

export class DurableDispatcher {
  readonly maxConcurrent: number;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly ownerId: string;
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
        if (item.status === "running" && item.attemptId) {
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
        const requested = this.conductor.cancelAttempt(item.attemptId);
        if (!requested) {
          await this.conductor.cancelReservedAttempt(item.attemptId);
        }
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
        let reserved: RunJobResult;
        try {
          reserved = await this.conductor.reservePreparedAttempt(
            item.jobId,
            parentAttemptIds,
          );
        } catch (error) {
          if (error instanceof ProposalLineageError) {
            await this.queue.update(item, {
              status: "needs-input",
              message: `Proposal lineage rejected before reservation: ${error.message}`,
            });
            continue;
          }
          throw error;
        }
        const running = await this.queue.update(item, {
          status: "running",
          attemptId: reserved.attemptId,
          message: undefined,
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
        if (current.status !== "running" || !current.attemptId)
          return undefined;
        await this.conductor.startReservedAttempt(current.attemptId);
        return current;
      });
      if (!started?.attemptId) return;
      const result = await this.conductor.waitForAttempt(started.attemptId);
      await this.withStateLock(() => this.finishItem(started, result));
    } catch (error) {
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
    const eligible =
      result.status === "completed" && result.verificationStatus === "eligible";
    const needsInput =
      result.status === "needs-input" ||
      (result.status === "completed" && !eligible);
    const queueStatus =
      result.status === "cancelled"
        ? "cancelled"
        : eligible
          ? "completed"
          : needsInput
            ? "needs-input"
            : "failed";
    await this.queue.update(await this.queue.read(item.jobId), {
      status: queueStatus,
      attemptId: result.attemptId,
      completion: {
        attemptId: result.attemptId,
        attemptStatus: result.status,
        verificationStatus: result.verificationStatus,
        finishedAt: new Date().toISOString(),
        artifacts: {
          manifest: result.artifacts.manifest,
          proposalPatch: result.artifacts.proposalPatch,
          changedPaths: result.artifacts.changedPaths,
          verification: result.artifacts.verification,
        },
      },
      message:
        result.failure?.message ??
        (needsInput
          ? "Deterministic verification marked proposal ineligible"
          : undefined),
    });
  }

  private async recoverInterruptedItems(): Promise<void> {
    for (const item of await this.queue.list()) {
      if (item.status !== "running") continue;
      if (!item.attemptId) {
        await this.queue.update(item, {
          status: "needs-input",
          message:
            "Dispatcher stopped after recording execution intent but before reserving an attempt",
        });
        continue;
      }
      const manifest = await this.conductor.getAttempt(item.attemptId);
      if (
        ["completed", "failed", "needs-input", "cancelled"].includes(
          manifest.status,
        )
      ) {
        await this.finishItem(item, {
          jobId: manifest.jobId,
          attemptId: manifest.attemptId,
          status: manifest.status,
          idempotentReplay: false,
          workspacePath: manifest.workspace?.path,
          workspaceRetained: manifest.workspace?.retained,
          artifacts: manifest.artifacts,
          failure: manifest.failure,
          verificationStatus: manifest.verificationStatus,
        });
      } else {
        const recovery = await this.conductor.recoverInterruptedAttempt(
          item.attemptId,
        );
        if (recovery.disposition === "safe-to-retry") {
          await this.queue.update(item, {
            status: "queued",
            attemptId: undefined,
            completion: undefined,
            message: `Recovered orphan ${item.attemptId}; recorded guardian is gone and a new attempt is safe`,
          });
        } else {
          await this.queue.update(item, {
            status: "needs-input",
            message:
              recovery.disposition === "still-running"
                ? `Guardian ${recovery.manifest.guardian?.guardianPid} for ${item.attemptId} is still alive; automatic duplication is prohibited`
                : `Attempt ${item.attemptId} lacks verifiable guardian identity; automatic duplication is prohibited`,
          });
        }
      }
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
      if (item.status === "running" && item.attemptId) {
        this.conductor.cancelAttempt(item.attemptId);
      }
    }
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
