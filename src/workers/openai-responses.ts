import type { JobContract } from "../contracts/job.js";
import type { ProcessInvocation } from "../runtime/process-runner.js";
import type {
  WorkerAdapter,
  WorkerAttemptContext,
  WorkerProfileEvidence,
} from "./adapter.js";

export interface OpenAIResponsesAdapterOptions {
  executable?: string;
  runnerPath?: string;
  profilesFile?: string;
  environment?: Record<string, string | undefined>;
}

export class OpenAIResponsesAdapter implements WorkerAdapter {
  readonly description = {
    id: "openai-responses",
    label: "OpenAI Responses API",
    executable: "unconfigured",
    mutationMode: "worktree" as const,
    outputFormat: "jsonl" as const,
    safetyMode: "strict-profiled-file-tools",
    available: false,
    hostExecution: "file-edit-only" as const,
    modelIdentity: "required" as const,
  };

  constructor(_options: OpenAIResponsesAdapterOptions = {}) {}

  buildInvocation(
    _contract: JobContract,
    _workspacePath: string,
    _attemptContext?: WorkerAttemptContext,
  ): ProcessInvocation {
    throw new Error("OpenAI Responses adapter is not implemented");
  }

  profileEvidence(
    _contract: JobContract,
    _invocation: ProcessInvocation,
  ): WorkerProfileEvidence {
    throw new Error("OpenAI Responses profile evidence is not implemented");
  }
}
