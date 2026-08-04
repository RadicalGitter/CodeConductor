import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { randomUUID } from "node:crypto";
import { fingerprint } from "../contracts/job.js";
import {
  sourceScanRequestSchema,
  sourceWatchRequestSchema,
  sourceWatchSchema,
  type SourceWatch,
} from "../contracts/source.js";
import { ArtifactStore } from "../storage/artifact-store.js";

export class SourceWatchStore {
  readonly root: string;

  constructor(readonly artifacts: ArtifactStore) {
    this.root = path.join(artifacts.root, "source-watches");
  }

  async register(
    input: unknown,
  ): Promise<{ watch: SourceWatch; created: boolean }> {
    const request = sourceWatchRequestSchema.parse(input);
    const { watchId: requestedId, enabled, ...scanInput } = request;
    const scan = sourceScanRequestSchema.parse(scanInput);
    const watchId =
      requestedId ??
      `watch_${fingerprint({
        repositoryPath: path.resolve(scan.repositoryPath),
        baseRef: scan.baseRef,
      }).slice(0, 20)}`;
    const now = new Date().toISOString();
    const watch = sourceWatchSchema.parse({
      schema: "conductor.source-watch/v1",
      watchId,
      enabled,
      scan,
      createdAt: now,
      updatedAt: now,
    });
    await mkdir(this.root, { recursive: true });
    const directory = this.directory(watchId);
    const staging = `${directory}.reserve-${process.pid}-${randomUUID()}`;
    try {
      await mkdir(staging);
      await this.artifacts.writeJsonAtomic(
        path.join(staging, "watch.json"),
        watch,
      );
      await rename(staging, directory);
      return { watch, created: true };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      try {
        const existing = await this.read(watchId);
        if (JSON.stringify(existing.scan) !== JSON.stringify(scan)) {
          throw new Error(
            `Watch ${watchId} already exists with different scan policy`,
          );
        }
        return { watch: existing, created: false };
      } catch (readError) {
        if (
          readError instanceof Error &&
          readError.message.startsWith("Watch ")
        ) {
          throw readError;
        }
        throw error;
      }
    }
  }

  async read(watchId: string): Promise<SourceWatch> {
    return sourceWatchSchema.parse(
      JSON.parse(await readFile(this.path(watchId), "utf8")),
    );
  }

  async list(): Promise<SourceWatch[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    return Promise.all(
      entries
        .filter(
          (entry) => entry.isDirectory() && !entry.name.includes(".reserve-"),
        )
        .map((entry) => this.read(entry.name)),
    );
  }

  async update(
    watch: SourceWatch,
    patch: Partial<SourceWatch>,
  ): Promise<SourceWatch> {
    const updated = sourceWatchSchema.parse({
      ...watch,
      ...patch,
      watchId: watch.watchId,
      scan: watch.scan,
      updatedAt: new Date().toISOString(),
    });
    await this.artifacts.writeJsonAtomic(this.path(watch.watchId), updated);
    return updated;
  }

  private directory(watchId: string): string {
    if (!/^[a-zA-Z0-9_.-]+$/.test(watchId)) {
      throw new Error(`Unsafe source watch id: ${watchId}`);
    }
    return path.join(this.root, watchId);
  }

  private path(watchId: string): string {
    return path.join(this.directory(watchId), "watch.json");
  }
}
