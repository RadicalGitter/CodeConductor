import { ContractSourceService } from "./service.js";
import { SourceWatchStore } from "./watch-store.js";

export class ContractSourcePoller {
  private stopped = true;
  private loop?: Promise<void>;
  private polling?: Promise<void>;
  private wake?: () => void;

  constructor(
    readonly sources: ContractSourceService,
    readonly watches: SourceWatchStore,
    readonly pollIntervalMs = 30_000,
  ) {
    if (
      !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs < 1_000 ||
      pollIntervalMs > 3_600_000
    ) {
      throw new Error("Source poll interval must be 1000..3600000 ms");
    }
  }

  async start(): Promise<void> {
    if (this.loop) return;
    this.stopped = false;
    this.loop = this.runLoop().finally(() => {
      this.loop = undefined;
    });
    void this.loop.catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.pollAll().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async pollAll(): Promise<void> {
    for (const watch of await this.watches.list()) {
      if (!watch.enabled) continue;
      const lastScanAt = new Date().toISOString();
      try {
        const batch = await this.sources.compile(watch.scan);
        if (batch.revision === watch.lastRevision) {
          await this.watches.update(watch, {
            lastScanAt,
            lastError: undefined,
          });
          continue;
        }
        const run = await this.sources.compileAndEnqueue({
          ...watch.scan,
          baseRef: batch.revision,
        });
        await this.watches.update(watch, {
          lastScanAt,
          lastRevision: run.revision,
          lastRunId: run.runId,
          lastError: undefined,
        });
      } catch (error) {
        await this.watches.update(watch, {
          lastScanAt,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      await this.pollOnce();
      if (!this.stopped) await this.waitInterval();
    }
  }

  private waitInterval(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, this.pollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
