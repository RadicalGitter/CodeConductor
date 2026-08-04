import type { JobContract } from "../contracts/job.js";
import type { ProcessInvocation } from "../runtime/process-runner.js";
import { buildWorkerPrompt, type WorkerAdapter } from "./adapter.js";

export class CodexAdapter implements WorkerAdapter {
  readonly description;

  constructor(executable = process.env.CONDUCTOR_CODEX_BIN ?? "codex") {
    this.description = {
      id: "codex",
      label: "Codex CLI",
      executable,
      mutationMode: "worktree" as const,
      outputFormat: "jsonl" as const,
      safetyMode: "codex-workspace-write",
    };
  }

  buildInvocation(
    contract: JobContract,
    workspacePath: string,
  ): ProcessInvocation {
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
    args.push(buildWorkerPrompt(contract));

    return {
      executable: this.description.executable,
      args,
      cwd: workspacePath,
    };
  }
}
