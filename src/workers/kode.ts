import type { JobContract } from "../contracts/job.js";
import type { ProcessInvocation } from "../runtime/process-runner.js";
import { selectRequestedEnvironment } from "../runtime/environment.js";
import { resolveExecutablePath } from "../runtime/executable.js";
import { statSync } from "node:fs";
import path from "node:path";
import { buildWorkerPrompt, type WorkerAdapter } from "./adapter.js";

export class KodeAdapter implements WorkerAdapter {
  readonly description;
  private readonly entry?: string;
  private readonly environmentKeys: readonly string[];
  private readonly executable?: string;
  private readonly entryAvailable: boolean;

  constructor(
    executable = process.env.CONDUCTOR_KODE_ENTRY
      ? (process.env.CONDUCTOR_KODE_NODE_BIN ?? "node")
      : (process.env.CONDUCTOR_KODE_BIN ?? "kode"),
    entry = process.env.CONDUCTOR_KODE_ENTRY,
    environmentKeys: readonly string[] = [],
  ) {
    this.entry = entry;
    this.environmentKeys = environmentKeys;
    this.executable = resolveExecutablePath(executable);
    this.entryAvailable = entry === undefined || isAbsoluteFile(entry);
    this.description = {
      id: "kode",
      label: "Kode CLI",
      executable: this.executable ?? executable,
      mutationMode: "worktree" as const,
      outputFormat: "jsonl" as const,
      safetyMode: "kode-safe",
      available: this.executable !== undefined && this.entryAvailable,
    };
  }

  buildInvocation(
    contract: JobContract,
    workspacePath: string,
  ): ProcessInvocation {
    const model = contract.worker.options.model;
    if (!this.executable || !this.entryAvailable) {
      throw new Error(
        `Kode executable is unavailable or requires a shell shim: ${this.description.executable}`,
      );
    }
    return {
      executable: this.executable,
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
      env: selectRequestedEnvironment(this.environmentKeys),
    };
  }
}

function isAbsoluteFile(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
