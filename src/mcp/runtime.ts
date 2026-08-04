import os from "node:os";
import path from "node:path";

import { Conductor } from "../orchestrator/conductor.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import { createDefaultWorkerRegistry } from "../workers/defaults.js";
import { GitWorkspaceManager } from "../workspaces/git-workspace.js";
import { ExecutionPolicy } from "../verification/command-executor.js";

export function createConductorFromEnvironment(): Conductor {
  const dataRoot = path.resolve(
    process.env.CONDUCTOR_DATA_DIR ?? path.join(os.homedir(), ".conductor"),
  );
  const store = new ArtifactStore(dataRoot);
  return new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    createDefaultWorkerRegistry(),
    ExecutionPolicy.fromEnvironment(),
  );
}
