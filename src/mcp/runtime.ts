import os from "node:os";
import path from "node:path";

import { Conductor } from "../orchestrator/conductor.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { createDefaultWorkerRegistry } from "../workers/defaults.js";
import { GitWorkspaceManager } from "../workspaces/git-workspace.js";
import { ExecutionPolicy } from "../verification/command-executor.js";
import { DurableDispatcher } from "../queue/dispatcher.js";
import { QueueStore } from "../queue/queue-store.js";

export function createConductorFromEnvironment(): Conductor {
  return createConductorRuntimeFromEnvironment().conductor;
}

export function createConductorRuntimeFromEnvironment(): {
  conductor: Conductor;
  queue: QueueStore;
  dispatcher: DurableDispatcher;
} {
  const dataRoot = path.resolve(
    process.env.CONDUCTOR_DATA_DIR ?? path.join(os.homedir(), ".conductor"),
  );
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    createDefaultWorkerRegistry(),
    ExecutionPolicy.fromEnvironment(),
  );
  const queue = new QueueStore(store);
  const dispatcher = new DurableDispatcher(conductor, queue, {
    maxConcurrent: environmentInteger("CONDUCTOR_MAX_CONCURRENT", 1),
    pollIntervalMs: environmentInteger("CONDUCTOR_POLL_INTERVAL_MS", 2_000),
    leaseMs: environmentInteger("CONDUCTOR_LEASE_MS", 30_000),
  });
  return { conductor, queue, dispatcher };
}

function environmentInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}
