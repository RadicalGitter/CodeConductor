import { spawn } from "node:child_process";
import path from "node:path";

import { fingerprint, type JobRequest } from "../contracts/job.js";
import {
  compiledSourceContractSchema,
  sourceContractSchema,
  sourceScanRequestSchema,
  type CompiledSourceContract,
} from "../contracts/source.js";
import { selectParentEnvironment } from "../runtime/environment.js";
import { GitWorkspaceManager } from "../workspaces/git-workspace.js";
import { CommandProfiles } from "./command-profiles.js";

const START_MARKER = "@conductor-contract";
const END_MARKER = "@end-conductor-contract";

export interface CompiledSourceBatch {
  schema: "conductor.compiled-source-batch/v1";
  repositoryRoot: string;
  revision: string;
  contracts: CompiledSourceContract[];
}

export class ContractSourceCompiler {
  constructor(
    readonly workspaces: GitWorkspaceManager,
    readonly profiles = new CommandProfiles(),
  ) {}

  async compile(input: unknown): Promise<CompiledSourceBatch> {
    const request = sourceScanRequestSchema.parse(input);
    const repository = await this.workspaces.inspectRepository(
      request.repositoryPath,
      request.baseRef,
    );
    const listed = await captureGit(
      repository.root,
      ["ls-tree", "-r", "--name-only", "-z", repository.revision],
      8_000_000,
    );
    const extensions = new Set(
      request.includeExtensions.map((extension) => extension.toLowerCase()),
    );
    const files = listed
      .split("\0")
      .filter(Boolean)
      .filter((file) => extensions.has(path.posix.extname(file).toLowerCase()));
    const contracts: CompiledSourceContract[] = [];

    for (const file of files) {
      let source: string;
      try {
        source = await captureGit(
          repository.root,
          ["show", `${repository.revision}:${file}`],
          request.maxFileBytes,
        );
      } catch (error) {
        if (error instanceof OutputLimitError) continue;
        throw error;
      }
      for (const extracted of extractContracts(source, file)) {
        const contract = sourceContractSchema.parse(extracted.value);
        if (!contract.enabled) continue;
        if (!request.allowedAdapterIds.includes(contract.adapterId)) {
          throw new Error(
            `${file}:${extracted.line} requests adapter ${contract.adapterId}, which is not allowed by scan policy`,
          );
        }
        contracts.push(
          compiledSourceContractSchema.parse({
            schema: "conductor.compiled-source-contract/v1",
            id: contract.id,
            fingerprint: fingerprint({
              repositoryRoot: repository.root,
              revision: repository.revision,
              sourcePath: file,
              contract,
            }),
            source: {
              repositoryRoot: repository.root,
              revision: repository.revision,
              path: file,
              line: extracted.line,
            },
            contract,
          }),
        );
      }
    }

    validateGraph(contracts);
    return {
      schema: "conductor.compiled-source-batch/v1",
      repositoryRoot: repository.root,
      revision: repository.revision,
      contracts: contracts.sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    };
  }

  toJobRequest(compiled: CompiledSourceContract): JobRequest {
    const contract = compiled.contract;
    return {
      objective: contract.objective,
      taskClass: contract.taskClass,
      repositoryPath: compiled.source.repositoryRoot,
      baseRef: compiled.source.revision,
      adapterId: contract.adapterId,
      adapterOptions: contract.adapterOptions,
      scope: contract.scope,
      contextRefs: [
        ...new Set([compiled.source.path, ...contract.contextRefs]),
      ],
      constraints: contract.constraints,
      escalateWhen: contract.escalateWhen,
      setupCommands: this.profiles.resolve(contract.setup),
      acceptanceCommands: this.profiles.resolve(contract.acceptance),
      timeoutMs: contract.timeoutMs,
      retainWorkspace: contract.retainWorkspace,
      executionBoundary: contract.executionBoundary,
      idempotencyKey: `source_${compiled.fingerprint}`,
    };
  }
}

function extractContracts(
  source: string,
  file: string,
): Array<{ line: number; value: unknown }> {
  const extracted: Array<{ line: number; value: unknown }> = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(START_MARKER, cursor);
    if (start < 0) break;
    if (!isCommentStartMarker(source, start)) {
      cursor = start + START_MARKER.length;
      continue;
    }
    const bodyStart = start + START_MARKER.length;
    const end = findCommentEndMarker(source, bodyStart);
    const line = source.slice(0, start).split(/\r?\n/).length;
    if (end < 0) throw new Error(`${file}:${line} has no ${END_MARKER}`);
    const raw = source
      .slice(bodyStart, end)
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^\s*(?:\/\/|#|--|\*)?\s?/, ""))
      .join("\n")
      .trim();
    try {
      extracted.push({ line, value: JSON.parse(raw) as unknown });
    } catch (error) {
      throw new Error(
        `${file}:${line} contains invalid Conductor JSON: ${errorMessage(error)}`,
      );
    }
    cursor = end + END_MARKER.length;
  }
  return extracted;
}

function isCommentStartMarker(source: string, marker: number): boolean {
  const lineStart = source.lastIndexOf("\n", marker - 1) + 1;
  const lineEnd = source.indexOf("\n", marker);
  const prefix = source.slice(lineStart, marker);
  const suffix = source.slice(
    marker + START_MARKER.length,
    lineEnd < 0 ? source.length : lineEnd,
  );
  return (
    /^\s*(?:\/\*+|\/\/+|#+|--+|\*)\s*$/.test(prefix) && /^\s*$/.test(suffix)
  );
}

function findCommentEndMarker(source: string, from: number): number {
  let cursor = from;
  while (cursor < source.length) {
    const marker = source.indexOf(END_MARKER, cursor);
    if (marker < 0) return -1;
    const lineStart = source.lastIndexOf("\n", marker - 1) + 1;
    const lineEnd = source.indexOf("\n", marker);
    const prefix = source.slice(lineStart, marker);
    const suffix = source.slice(
      marker + END_MARKER.length,
      lineEnd < 0 ? source.length : lineEnd,
    );
    if (
      /^\s*(?:(?:\/\/+|#+|--+|\*)\s*)?$/.test(prefix) &&
      /^\s*(?:\*\/|-->)?\s*$/.test(suffix)
    ) {
      return marker;
    }
    cursor = marker + END_MARKER.length;
  }
  return -1;
}

function validateGraph(contracts: CompiledSourceContract[]): void {
  const byId = new Map<string, CompiledSourceContract>();
  for (const contract of contracts) {
    const existing = byId.get(contract.id);
    if (existing) {
      throw new Error(
        `Duplicate contract id ${contract.id} at ${existing.source.path}:${existing.source.line} and ${contract.source.path}:${contract.source.line}`,
      );
    }
    byId.set(contract.id, contract);
  }
  for (const contract of contracts) {
    for (const dependency of contract.contract.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(
          `Contract ${contract.id} depends on missing ${dependency}`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new Error(`Contract dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)!.contract.dependsOn)
      visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

class OutputLimitError extends Error {}

function captureGit(
  cwd: string,
  args: string[],
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
      env: selectParentEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (bytes > maxBytes) {
        reject(new OutputLimitError(`Git output exceeded ${maxBytes} bytes`));
      } else if (code === 0) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } else {
        reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
      }
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
