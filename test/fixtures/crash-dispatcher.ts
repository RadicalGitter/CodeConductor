import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JobContract } from "../../src/contracts/job.js";
import { Conductor } from "../../src/orchestrator/conductor.js";
import {
  DurableDispatcher,
  type DispatchFailpointName,
} from "../../src/queue/dispatcher.js";
import { QueueStore } from "../../src/queue/queue-store.js";
import { ArtifactStore } from "../../src/storage/artifact-store.js";
import type { WorkerAdapter } from "../../src/workers/adapter.js";
import { WorkerRegistry } from "../../src/workers/adapter.js";
import { GitWorkspaceManager } from "../../src/workspaces/git-workspace.js";

class CrashFixtureAdapter implements WorkerAdapter {
  readonly description = {
    id: "crash-fixture",
    label: "Crash fixture",
    executable: process.execPath,
    mutationMode: "worktree" as const,
    outputFormat: "jsonl" as const,
    safetyMode: "test-fixture",
    available: true,
    modelIdentity: "not-applicable" as const,
  };

  buildInvocation(contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./delayed-worker.ts", import.meta.url)),
        workspacePath,
        String(contract.worker.options.delayMs),
      ],
      cwd: path.resolve(workspacePath),
    };
  }
}

const [dataRoot, repositoryPath, key, crashPoint] = process.argv.slice(2);
if (!dataRoot || !repositoryPath || !key || !crashPoint) {
  throw new Error("data root, repository, key, and crash point are required");
}

const store = new ArtifactStore(dataRoot);
const conductor = new Conductor(
  store,
  new GitWorkspaceManager(store.workspaceRoot()),
  new WorkerRegistry([new CrashFixtureAdapter()]),
);
const queue = new QueueStore(store);
const dispatcher = new DurableDispatcher(conductor, queue, {
  pollIntervalMs: 25,
  leaseMs: 1_000,
  ownerId: `abrupt-${key}`,
  failpoint(point) {
    if (point === (crashPoint as DispatchFailpointName)) process.exit(91);
  },
});

await dispatcher.enqueue({
  objective: `Crash dispatch at ${crashPoint}`,
  repositoryPath,
  adapterId: "crash-fixture",
  adapterOptions: { delayMs: 5 },
  idempotencyKey: key,
  scope: { allowedPaths: ["generated.txt"] },
});
await dispatcher.runUntilIdle();
throw new Error(`Failpoint was not reached: ${crashPoint}`);
