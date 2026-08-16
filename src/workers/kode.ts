import type { JobContract } from "../contracts/job.js";
import type { ProcessInvocation } from "../runtime/process-runner.js";
import { selectRequestedEnvironment } from "../runtime/environment.js";
import { resolveExecutablePath } from "../runtime/executable.js";
import { realpathSync, statSync } from "node:fs";
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
      hostExecution: "file-edit-only" as const,
      modelIdentity: "required" as const,
    };
  }

  buildInvocation(
    contract: JobContract,
    workspacePath: string,
    attemptContext?: WorkerAttemptContext,
  ): ProcessInvocation {
    const options = parseKodeAdapterOptions(contract.worker.options);
    const model = options.model;
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
        ...(options.readOnlyPaths.length > 0
          ? [
              "--allowed-tools",
              ...kodeReadRules(options.readOnlyPaths),
              "--disallowed-tools",
              ...kodeWriteDenyRules(options.readOnlyPaths),
            ]
          : []),
        "--max-turns",
        String(this.maxTurns),
        ...(typeof model === "string" && model ? ["--model", model] : []),
        "--print",
        appendReadOnlyRoots(
          buildWorkerPrompt(contract, attemptContext),
          options.readOnlyPaths,
        ),
      ],
      cwd: workspacePath,
      env: {
        ...selectRequestedEnvironment(this.environmentKeys),
        ...(options.readOnlyPaths.length > 0
          ? {
              KODE_READ_ONLY_ROOTS_JSON: JSON.stringify(options.readOnlyPaths),
            }
          : {}),
      },
    };
  }

  profileEvidence(contract: JobContract, invocation: ProcessInvocation) {
    const options = parseKodeAdapterOptions(contract.worker.options);
    const files: Array<{
      role: "harness" | "configuration";
      path: string;
    }> = [];
    if (this.entry) files.push({ role: "harness", path: this.entry });
    const configDirectory =
      invocation.env?.KODE_CONFIG_DIR ?? process.env.KODE_CONFIG_DIR;
    const unresolvedReasons: string[] = [];
    if (configDirectory) {
      files.push({
        role: "configuration",
        path: path.join(configDirectory, "config.json"),
      });
    } else {
      unresolvedReasons.push("KODE_CONFIG_DIR is not explicitly bound");
    }
    return {
      files,
      attributes: {
        maxTurns: String(this.maxTurns),
        modelSelector: String(options.model ?? ""),
        externalReadOnlyRoots: JSON.stringify(options.readOnlyPaths),
      },
      unresolvedReasons,
    };
  }
}

interface KodeAdapterOptions {
  readonly model?: string;
  readonly readOnlyPaths: readonly string[];
}

function parseKodeAdapterOptions(
  raw: Readonly<Record<string, unknown>>,
): KodeAdapterOptions {
  const unknown = Object.keys(raw).filter(
    (key) => key !== "model" && key !== "readOnlyPaths",
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unsupported Kode adapter option(s): ${unknown.sort().join(", ")}`,
    );
  }

  const model = raw.model;
  if (
    model !== undefined &&
    (typeof model !== "string" || model.trim() === "")
  ) {
    throw new Error("Kode adapter option model must be a non-empty string");
  }

  const requestedPaths = raw.readOnlyPaths ?? [];
  if (!Array.isArray(requestedPaths)) {
    throw new Error("Kode adapter option readOnlyPaths must be an array");
  }

  const readOnlyPaths: string[] = [];
  const seen = new Set<string>();
  for (const candidate of requestedPaths) {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      throw new Error(
        "Every Kode readOnlyPaths entry must be a non-empty string",
      );
    }
    if (!path.isAbsolute(candidate) || isUncPath(candidate)) {
      throw new Error(
        `Kode read-only path must be an absolute local path: ${candidate}`,
      );
    }

    let resolved: string;
    try {
      resolved = realpathSync.native(candidate);
      const resolvedType = statSync(resolved);
      if (!resolvedType.isDirectory() && !resolvedType.isFile()) {
        throw new Error("not a file or directory");
      }
    } catch {
      throw new Error(
        `Kode read-only path must identify an existing file or directory: ${candidate}`,
      );
    }

    const identity =
      process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(identity)) {
      throw new Error(`Duplicate Kode read-only path: ${candidate}`);
    }
    seen.add(identity);
    readOnlyPaths.push(resolved);
  }

  return {
    ...(typeof model === "string" ? { model } : {}),
    readOnlyPaths,
  };
}

function kodeReadRules(readOnlyPaths: readonly string[]): string[] {
  return kodePathRules(["Read", "LS", "Glob", "Grep"], readOnlyPaths);
}

function kodeWriteDenyRules(readOnlyPaths: readonly string[]): string[] {
  return kodePathRules(["Edit", "Write", "NotebookEdit"], readOnlyPaths);
}

function kodePathRules(
  tools: readonly string[],
  readOnlyPaths: readonly string[],
): string[] {
  return readOnlyPaths.flatMap((root) => {
    const pattern = kodeAbsolutePathPattern(root);
    return tools.map((tool) => `${tool}(${pattern})`);
  });
}

function kodeAbsolutePathPattern(root: string): string {
  const portable = root
    .replace(
      /^([A-Za-z]):[\\/]/,
      (_match, drive: string) => `/${drive.toLowerCase()}/`,
    )
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  return statSync(root).isDirectory() ? `/${portable}/**` : `/${portable}`;
}

function appendReadOnlyRoots(
  prompt: string,
  readOnlyPaths: readonly string[],
): string {
  if (readOnlyPaths.length === 0) return prompt;
  return `${prompt}\n\nExternal read-only evidence roots:\n${readOnlyPaths
    .map((root) => `- ${root}`)
    .join(
      "\n",
    )}\nYou may inspect these roots with read-only tools. Writing anywhere beneath them is mechanically denied.`;
}

function isUncPath(candidate: string): boolean {
  return candidate.startsWith("\\\\") || candidate.startsWith("//");
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
