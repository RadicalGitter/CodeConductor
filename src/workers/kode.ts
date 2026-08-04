import type { JobContract } from "../contracts/job.js";
import type { ProcessInvocation } from "../runtime/process-runner.js";
import { buildWorkerPrompt, type WorkerAdapter } from "./adapter.js";

export class KodeAdapter implements WorkerAdapter {
  readonly description;
  private readonly entry?: string;

  constructor(
    executable = process.env.CONDUCTOR_KODE_ENTRY
      ? (process.env.CONDUCTOR_KODE_NODE_BIN ?? "node")
      : (process.env.CONDUCTOR_KODE_BIN ?? "kode"),
    entry = process.env.CONDUCTOR_KODE_ENTRY,
  ) {
    this.entry = entry;
    this.description = {
      id: "kode",
      label: "Kode CLI",
      executable,
      mutationMode: "worktree" as const,
      outputFormat: "jsonl" as const,
      safetyMode: "kode-safe",
    };
  }

  buildInvocation(
    contract: JobContract,
    workspacePath: string,
  ): ProcessInvocation {
    const model = contract.worker.options.model;
    return {
      executable: this.description.executable,
      args: [
        ...(this.entry ? [this.entry] : []),
        "--cwd",
        workspacePath,
        "--safe",
        "--headless",
        "--output-format",
        "stream-json",
        ...(typeof model === "string" && model ? ["--model", model] : []),
        "--print",
        buildWorkerPrompt(contract),
      ],
      cwd: workspacePath,
    };
  }
}
