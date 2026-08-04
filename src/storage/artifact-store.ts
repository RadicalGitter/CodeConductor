import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import {
  attemptManifestSchema,
  createReservedAttempt,
  type AttemptManifest,
  type ProposalLineage,
} from "../contracts/attempt.js";
import { jobContractSchema, type JobContract } from "../contracts/job.js";

export class IdempotencyConflictError extends Error {
  constructor(jobId: string) {
    super(
      `Idempotency key for ${jobId} was already used with a different request`,
    );
    this.name = "IdempotencyConflictError";
  }
}

export interface AttemptReservation {
  manifest: AttemptManifest;
  directory: string;
  created: boolean;
}

export class ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.jobsRoot(), { recursive: true });
  }

  async reserveJob(
    contract: JobContract,
  ): Promise<{ contract: JobContract; created: boolean }> {
    await this.initialize();
    const jobDirectory = this.jobDirectory(contract.jobId);
    const stagingDirectory = `${jobDirectory}.reserve-${process.pid}-${randomUUID()}`;

    try {
      await mkdir(stagingDirectory);
      await this.writeJsonAtomic(
        path.join(stagingDirectory, "job.json"),
        contract,
      );
      await rename(stagingDirectory, jobDirectory);
      return { contract, created: true };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });

      let existing: JobContract;
      try {
        existing = await this.readJob(contract.jobId);
      } catch {
        throw error;
      }
      if (existing.requestFingerprint !== contract.requestFingerprint) {
        throw new IdempotencyConflictError(contract.jobId);
      }
      return { contract: existing, created: false };
    }
  }

  async readJob(jobId: string): Promise<JobContract> {
    return jobContractSchema.parse(await this.readJson(this.jobPath(jobId)));
  }

  async reserveAttempt(
    contract: JobContract,
    lineage?: ProposalLineage,
  ): Promise<AttemptReservation> {
    const attemptsRoot = this.attemptsRoot(contract.jobId);
    await mkdir(attemptsRoot, { recursive: true });

    for (let ordinal = 1; ordinal <= 999_999; ordinal += 1) {
      const reservation = await this.reserveAttemptAt(
        contract,
        ordinal,
        lineage,
      );
      if (reservation.created) return reservation;
    }

    throw new Error(`Attempt space exhausted for ${contract.jobId}`);
  }

  async reserveInitialAttempt(
    contract: JobContract,
  ): Promise<AttemptReservation> {
    await mkdir(this.attemptsRoot(contract.jobId), { recursive: true });
    return this.reserveAttemptAt(contract, 1);
  }

  async writeAttempt(manifest: AttemptManifest): Promise<void> {
    const parsed = attemptManifestSchema.parse(manifest);
    await this.writeJsonAtomic(
      this.attemptManifestPath(parsed.jobId, parsed.attemptId),
      parsed,
    );
  }

  async readAttempt(
    jobId: string,
    attemptId: string,
  ): Promise<AttemptManifest> {
    return attemptManifestSchema.parse(
      await this.readJson(this.attemptManifestPath(jobId, attemptId)),
    );
  }

  async findAttempt(attemptId: string): Promise<AttemptManifest> {
    const separator = attemptId.lastIndexOf("_a");
    if (separator < 1) throw new Error(`Invalid attempt id: ${attemptId}`);
    return this.readAttempt(attemptId.slice(0, separator), attemptId);
  }

  async latestAttempt(jobId: string): Promise<AttemptManifest | undefined> {
    const root = this.attemptsRoot(jobId);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    }
    const latest = entries
      .filter((entry) => entry.startsWith(`${jobId}_a`))
      .sort()
      .at(-1);
    return latest ? this.readAttempt(jobId, latest) : undefined;
  }

  async writeJsonAtomic(target: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  jobDirectory(jobId: string): string {
    return path.join(this.jobsRoot(), safeSegment(jobId));
  }

  jobPath(jobId: string): string {
    return path.join(this.jobDirectory(jobId), "job.json");
  }

  attemptsRoot(jobId: string): string {
    return path.join(this.jobDirectory(jobId), "attempts");
  }

  attemptDirectory(jobId: string, attemptId: string): string {
    return path.join(this.attemptsRoot(jobId), safeSegment(attemptId));
  }

  attemptManifestPath(jobId: string, attemptId: string): string {
    return path.join(this.attemptDirectory(jobId, attemptId), "attempt.json");
  }

  workspaceRoot(): string {
    return path.join(this.root, "workspaces");
  }

  workspacePath(attemptId: string): string {
    return path.join(this.workspaceRoot(), safeSegment(attemptId));
  }

  private jobsRoot(): string {
    return path.join(this.root, "jobs");
  }

  private async readJson(target: string): Promise<unknown> {
    return JSON.parse(await readFile(target, "utf8")) as unknown;
  }

  private async reserveAttemptAt(
    contract: JobContract,
    ordinal: number,
    lineage?: ProposalLineage,
  ): Promise<AttemptReservation> {
    const attemptId = `${contract.jobId}_a${ordinal.toString().padStart(4, "0")}`;
    const directory = this.attemptDirectory(contract.jobId, attemptId);
    const stagingDirectory = `${directory}.reserve-${process.pid}-${randomUUID()}`;
    await mkdir(stagingDirectory);

    const manifest = createReservedAttempt({
      jobId: contract.jobId,
      attemptId,
      ordinal,
      adapterId: contract.worker.adapterId,
      artifacts: {
        job: this.jobPath(contract.jobId),
        manifest: this.attemptManifestPath(contract.jobId, attemptId),
        stdout: path.join(directory, "stdout.log"),
        stderr: path.join(directory, "stderr.log"),
        proposalPatch: path.join(directory, "proposal.patch"),
        repositoryStatus: path.join(directory, "repository-status.txt"),
        changedPaths: path.join(directory, "changed-paths.json"),
        verification: path.join(directory, "verification.json"),
      },
      lineage,
    });
    try {
      await this.writeJsonAtomic(
        path.join(stagingDirectory, "attempt.json"),
        manifest,
      );
      await rename(stagingDirectory, directory);
      return { manifest, directory, created: true };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      if (!(await exists(directory))) throw error;
      return {
        manifest: await this.readAttempt(contract.jobId, attemptId),
        directory,
        created: false,
      };
    }
  }
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new Error(`Unsafe artifact path segment: ${value}`);
  }
  return value;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
