import path from "node:path";
import { readFile } from "node:fs/promises";

import { fingerprint } from "../contracts/job.js";
import type { CompiledSourceContract } from "../contracts/source.js";
import type { DurableDispatcher } from "../queue/dispatcher.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import {
  ContractSourceCompiler,
  type CompiledSourceBatch,
} from "./compiler.js";

export interface SourceEnqueueRecord {
  contractId: string;
  jobId: string;
  queueStatus: string;
  idempotentReplay: boolean;
  dependsOnJobIds: string[];
}

export interface SourceRunManifest {
  schema: "conductor.source-run/v1";
  runId: string;
  createdAt: string;
  repositoryRoot: string;
  revision: string;
  contracts: Array<{
    id: string;
    fingerprint: string;
    sourcePath: string;
    sourceLine: number;
  }>;
  enqueued: SourceEnqueueRecord[];
}

export class ContractSourceService {
  constructor(
    readonly compiler: ContractSourceCompiler,
    readonly dispatcher: DurableDispatcher,
    readonly artifacts: ArtifactStore,
  ) {}

  compile(input: unknown): Promise<CompiledSourceBatch> {
    return this.compiler.compile(input);
  }

  async compileAndEnqueue(input: unknown): Promise<SourceRunManifest> {
    const batch = await this.compiler.compile(input);
    const runId = `source_${fingerprint({
      repositoryRoot: batch.repositoryRoot,
      revision: batch.revision,
      contracts: batch.contracts.map((contract) => contract.fingerprint),
    }).slice(0, 20)}`;
    const manifestPath = path.join(
      this.artifacts.root,
      "source-runs",
      runId,
      "manifest.json",
    );
    const existing = await readExistingManifest(manifestPath, runId);
    if (existing) return existing;

    const ordered = topologicalOrder(batch.contracts);
    const jobsByContract = new Map<string, string>();
    const enqueued: SourceEnqueueRecord[] = [];

    for (const compiled of ordered) {
      const dependsOnJobIds = compiled.contract.dependsOn.map((dependency) => {
        const jobId = jobsByContract.get(dependency);
        if (!jobId) {
          throw new Error(
            `Dependency ${dependency} for ${compiled.id} was not compiled first`,
          );
        }
        return jobId;
      });
      const result = await this.dispatcher.enqueue({
        ...this.compiler.toJobRequest(compiled),
        queue: {
          priority: compiled.contract.priority,
          dependsOnJobIds,
        },
      });
      jobsByContract.set(compiled.id, result.item.jobId);
      enqueued.push({
        contractId: compiled.id,
        jobId: result.item.jobId,
        queueStatus: result.item.status,
        idempotentReplay: result.idempotentReplay,
        dependsOnJobIds,
      });
    }

    const manifest: SourceRunManifest = {
      schema: "conductor.source-run/v1",
      runId,
      createdAt: new Date().toISOString(),
      repositoryRoot: batch.repositoryRoot,
      revision: batch.revision,
      contracts: batch.contracts.map((contract) => ({
        id: contract.id,
        fingerprint: contract.fingerprint,
        sourcePath: contract.source.path,
        sourceLine: contract.source.line,
      })),
      enqueued,
    };
    await this.artifacts.writeJsonAtomic(manifestPath, manifest);
    return manifest;
  }
}

async function readExistingManifest(
  target: string,
  runId: string,
): Promise<SourceRunManifest | undefined> {
  try {
    const value = JSON.parse(
      await readFile(target, "utf8"),
    ) as SourceRunManifest;
    if (value.schema !== "conductor.source-run/v1" || value.runId !== runId) {
      throw new Error(`Invalid existing source-run manifest: ${target}`);
    }
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function topologicalOrder(
  contracts: CompiledSourceContract[],
): CompiledSourceContract[] {
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  const visited = new Set<string>();
  const ordered: CompiledSourceContract[] = [];
  const visit = (contract: CompiledSourceContract): void => {
    if (visited.has(contract.id)) return;
    for (const dependency of contract.contract.dependsOn) {
      visit(byId.get(dependency)!);
    }
    visited.add(contract.id);
    ordered.push(contract);
  };
  for (const contract of contracts) visit(contract);
  return ordered;
}
