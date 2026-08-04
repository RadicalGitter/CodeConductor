import { CodexAdapter } from "./codex.js";
import { KodeAdapter } from "./kode.js";
import { WorkerRegistry } from "./adapter.js";

export function createDefaultWorkerRegistry(): WorkerRegistry {
  return new WorkerRegistry([new KodeAdapter(), new CodexAdapter()]);
}
