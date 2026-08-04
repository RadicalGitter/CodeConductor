import os from "node:os";
import path from "node:path";

import { Conductor } from "../orchestrator/conductor.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { createDefaultWorkerRegistry } from "../workers/defaults.js";
import { GitWorkspaceManager } from "../workspaces/git-workspace.js";
import { ExecutionPolicy } from "../verification/command-executor.js";
import { DurableDispatcher } from "../queue/dispatcher.js";
import { QueueStore } from "../queue/queue-store.js";
import { CommandProfiles } from "../sources/command-profiles.js";
import { ContractSourceCompiler } from "../sources/compiler.js";
import { ContractSourceService } from "../sources/service.js";
import { ContractSourcePoller } from "../sources/poller.js";
import { SourceWatchStore } from "../sources/watch-store.js";
import { SandboxProfiles } from "../sandbox/docker.js";
import { RuntimeReconciler } from "../reconcile/runtime-reconciler.js";

export function createConductorFromEnvironment(): Conductor {
  return createConductorRuntimeFromEnvironment().conductor;
}

export function createConductorRuntimeFromEnvironment(): {
  conductor: Conductor;
  queue: QueueStore;
  dispatcher: DurableDispatcher;
  sources: ContractSourceService;
  watches: SourceWatchStore;
  poller: ContractSourcePoller;
  reconciler: RuntimeReconciler;
} {
  const dataRoot = path.resolve(
    process.env.CONDUCTOR_DATA_DIR ?? path.join(os.homedir(), ".conductor"),
  );
  const store = new ArtifactStore(dataRoot);
  const profiles = CommandProfiles.fromEnvironment();
  const sandboxProfiles = SandboxProfiles.fromEnvironment();
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    createDefaultWorkerRegistry(),
    ExecutionPolicy.fromEnvironment({
      allowedExecutables: profiles.executablePaths(),
      allowedEnvironmentNames: profiles.environmentNames(),
    }),
    sandboxProfiles,
  );
  const queue = new QueueStore(store);
  const dispatcher = new DurableDispatcher(conductor, queue, {
    maxConcurrent: environmentInteger("CONDUCTOR_MAX_CONCURRENT", 1),
    pollIntervalMs: environmentInteger("CONDUCTOR_POLL_INTERVAL_MS", 2_000),
    leaseMs: environmentInteger("CONDUCTOR_LEASE_MS", 30_000),
  });
  const sources = new ContractSourceService(
    new ContractSourceCompiler(conductor.workspaces, profiles),
    dispatcher,
    store,
  );
  const watches = new SourceWatchStore(store);
  const poller = new ContractSourcePoller(
    sources,
    watches,
    environmentInteger("CONDUCTOR_SOURCE_POLL_INTERVAL_MS", 30_000),
  );
  const reconciler = new RuntimeReconciler(
    conductor,
    queue,
    dispatcher.leaseMs,
  );
  return {
    conductor,
    queue,
    dispatcher,
    sources,
    watches,
    poller,
    reconciler,
  };
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
