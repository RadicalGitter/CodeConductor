import type { JobContract } from "../contracts/job.js";
import type { ProcessInvocation } from "../runtime/process-runner.js";
import { selectRequestedEnvironment } from "../runtime/environment.js";
import { resolveExecutablePath } from "../runtime/executable.js";
import {
  buildWorkerPrompt,
  type WorkerAdapter,
  type WorkerAttemptContext,
} from "./adapter.js";

export class CodexAdapter implements WorkerAdapter {
  readonly description;
  private readonly environmentKeys: readonly string[];
  private readonly executable?: string;

  constructor(
    executable = process.env.CONDUCTOR_CODEX_BIN ?? "codex",
    environmentKeys: readonly string[] = [],
  ) {
    this.environmentKeys = environmentKeys;
    this.executable = resolveExecutablePath(executable);
    this.description = {
      id: "codex",
      label: "Codex CLI",
      executable: this.executable ?? executable,
      mutationMode: "worktree" as const,
      outputFormat: "jsonl" as const,
      safetyMode: "codex-workspace-write",
      available: this.executable !== undefined,
      hostExecution: "command-capable" as const,
    };
  }

  buildInvocation(
    contract: JobContract,
    workspacePath: string,
    attemptContext?: WorkerAttemptContext,
  ): ProcessInvocation {
    if (!this.executable) {
      throw new Error(
        `Codex executable is unavailable or requires a shell shim: ${this.description.executable}`,
      );
    }
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "--cd",
      workspacePath,
    ];
    const model = contract.worker.options.model;
    if (typeof model === "string" && model) args.push("--model", model);
    const profile = contract.worker.options.profile;
    if (typeof profile === "string" && profile) args.push("--profile", profile);
    args.push(buildWorkerPrompt(contract, attemptContext));

    return {
      executable: this.executable,
      args,
      cwd: workspacePath,
      env: selectRequestedEnvironment(this.environmentKeys),
    };
  }
}
