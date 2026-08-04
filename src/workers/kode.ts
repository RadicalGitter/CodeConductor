import type { JobContract } from "../contracts/job.js";
import type { ProcessInvocation } from "../runtime/process-runner.js";
import { selectRequestedEnvironment } from "../runtime/environment.js";
import { resolveExecutablePath } from "../runtime/executable.js";
import { statSync } from "node:fs";
import path from "node:path";
import {
  buildWorkerPrompt,
  type WorkerAdapter,
  type WorkerAttemptContext,
} from "./adapter.js";

export class KodeAdapter implements WorkerAdapter {
  readonly description;
  private readonly entry?: string;
  private readonly environmentKeys: readonly string[];
  private readonly executable?: string;
  private readonly entryAvailable: boolean;
  private readonly maxTurns: number;

  constructor(
    executable = process.env.CONDUCTOR_KODE_ENTRY
      ? (process.env.CONDUCTOR_KODE_NODE_BIN ?? "node")
      : (process.env.CONDUCTOR_KODE_BIN ?? "kode"),
    entry = process.env.CONDUCTOR_KODE_ENTRY,
    environmentKeys: readonly string[] = [],
    maxTurns = parseMaxTurns(process.env.CONDUCTOR_KODE_MAX_TURNS),
  ) {
    this.entry = entry;
    this.environmentKeys = environmentKeys;
    this.executable = resolveExecutablePath(executable);
    this.maxTurns = maxTurns;
    this.entryAvailable = entry === undefined || isAbsoluteFile(entry);
    this.description = {
      id: "kode",
      label: "Kode CLI",
      executable: this.executable ?? executable,
      mutationMode: "worktree" as const,
      outputFormat: "jsonl" as const,
      safetyMode: "kode-safe-accept-edits",
      available: this.executable !== undefined && this.entryAvailable,
    };
  }

  buildInvocation(
    contract: JobContract,
    workspacePath: string,
    attemptContext?: WorkerAttemptContext,
  ): ProcessInvocation {
    const model = contract.worker.options.model;
    const tools = kodeToolsForContract(contract, workspacePath);
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
        "--permission-mode",
        "acceptEdits",
        "--headless",
        "--verbose",
        "--output-format",
        "stream-json",
        "--tools",
        tools,
        "--max-turns",
        String(this.maxTurns),
        ...(typeof model === "string" && model ? ["--model", model] : []),
        "--print",
        buildWorkerPrompt(contract, attemptContext),
      ],
      cwd: workspacePath,
      env: selectRequestedEnvironment(this.environmentKeys),
    };
  }
}

function kodeToolsForContract(
  contract: JobContract,
  workspacePath: string,
): string {
  const canEditEveryTarget =
    contract.scope.allowedPaths.length > 0 &&
    contract.scope.allowedPaths.every((relative) => {
      try {
        return statSync(path.resolve(workspacePath, relative)).isFile();
      } catch {
        return false;
      }
    });
  return canEditEveryTarget
    ? "Read,Edit,LS,Glob,Grep"
    : "Read,Edit,Write,LS,Glob,Grep";
}

function parseMaxTurns(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 16;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(
      "CONDUCTOR_KODE_MAX_TURNS must be an integer from 1 to 100",
    );
  }
  return parsed;
}

function isAbsoluteFile(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
