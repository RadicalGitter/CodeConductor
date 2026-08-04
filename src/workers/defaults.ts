import { CodexAdapter } from "./codex.js";
import { KodeAdapter } from "./kode.js";
import { WorkerRegistry } from "./adapter.js";
import { parseEnvironmentList } from "../runtime/environment.js";

export function createDefaultWorkerRegistry(): WorkerRegistry {
  const inheritedEnvironment = parseEnvironmentList(
    process.env.CONDUCTOR_WORKER_ENV_ALLOWLIST,
  );
  return new WorkerRegistry([
    new KodeAdapter(undefined, undefined, inheritedEnvironment),
    new CodexAdapter(undefined, inheritedEnvironment),
  ]);
}
