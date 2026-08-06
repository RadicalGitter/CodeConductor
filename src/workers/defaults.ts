import { CodexAdapter } from "./codex.js";
import { KodeAdapter } from "./kode.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";
import { WorkerRegistry } from "./adapter.js";
import { parseEnvironmentList } from "../runtime/environment.js";

export function createDefaultWorkerRegistry(): WorkerRegistry {
  const inheritedEnvironment = parseEnvironmentList(
    process.env.CONDUCTOR_WORKER_ENV_ALLOWLIST,
  );
  return new WorkerRegistry([
    new KodeAdapter(undefined, undefined, inheritedEnvironment),
    new CodexAdapter(undefined, inheritedEnvironment),
    new OpenAIResponsesAdapter({
      executable: process.env.CONDUCTOR_OPENAI_RESPONSES_BUN_BIN,
      runnerPath: process.env.CONDUCTOR_OPENAI_RESPONSES_RUNNER,
      profilesFile: process.env.CONDUCTOR_PROVIDER_PROFILES_FILE,
      environment: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
    }),
  ]);
}
