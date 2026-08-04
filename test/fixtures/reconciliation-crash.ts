import { readFile } from "node:fs/promises";

import { reconciliationActionSchema } from "../../src/contracts/reconcile.js";
import { Conductor } from "../../src/orchestrator/conductor.js";
import { QueueStore } from "../../src/queue/queue-store.js";
import { RuntimeReconciler } from "../../src/reconcile/runtime-reconciler.js";
import { ArtifactStore } from "../../src/storage/artifact-store.js";
import { WorkerRegistry } from "../../src/workers/adapter.js";
import { GitWorkspaceManager } from "../../src/workspaces/git-workspace.js";

const [dataRoot, actionPath] = process.argv.slice(2);
if (!dataRoot || !actionPath)
  throw new Error("Missing crash fixture arguments");

const store = new ArtifactStore(dataRoot);
const queue = new QueueStore(store);
const conductor = new Conductor(
  store,
  new GitWorkspaceManager(store.workspaceRoot()),
  new WorkerRegistry([]),
);
const reconciler = new RuntimeReconciler(conductor, queue, 1_000, {
  actionFailpoint: () => process.exit(93),
});
const action = reconciliationActionSchema.parse(
  JSON.parse(await readFile(actionPath, "utf8")),
);
await reconciler.apply(action);
