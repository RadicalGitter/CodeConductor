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
  type AttemptStatus,
  type ProposalLineage,
} from "../contracts/attempt.js";
import {
  attemptCleanupRecordSchema,
  cleanupEvidenceSchema,
  cleanupRequirementSchema,
  createAttemptCleanupRecord,
  deriveCleanupStatus,
  sameCleanupSubject,
  type AttemptCleanupRecord,
  type CleanupEvidence,
  type CleanupRequirement,
} from "../contracts/cleanup.js";
import { jobContractSchema, type JobContract } from "../contracts/job.js";
import {
  commitTransition,
  readLatestTransition,
  TransitionConflictError,
  type TransitionFailpoint,
} from "./transitions.js";

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

  constructor(
    root: string,
    private readonly options: {
      transitionFailpoint?: TransitionFailpoint;
    } = {},
  ) {
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
    dispatchOperationId?: string,
  ): Promise<AttemptReservation> {
    const attemptsRoot = this.attemptsRoot(contract.jobId);
    await mkdir(attemptsRoot, { recursive: true });

    for (let ordinal = 1; ordinal <= 999_999; ordinal += 1) {
      const reservation = await this.reserveAttemptAt(
        contract,
        ordinal,
        lineage,
        dispatchOperationId,
      );
      if (reservation.created) return reservation;
    }

    throw new Error(`Attempt space exhausted for ${contract.jobId}`);
  }

  async reserveInitialAttempt(
    contract: JobContract,
    dispatchOperationId?: string,
  ): Promise<AttemptReservation> {
    await mkdir(this.attemptsRoot(contract.jobId), { recursive: true });
    return this.reserveAttemptAt(contract, 1, undefined, dispatchOperationId);
  }

  async transitionAttempt(
    expected: AttemptManifest,
    patch: Partial<AttemptManifest>,
  ): Promise<AttemptManifest> {
    const current = await this.readAttempt(expected.jobId, expected.attemptId);
    if (
      current.revision !== expected.revision ||
      JSON.stringify(current) !== JSON.stringify(expected)
    ) {
      throw new TransitionConflictError(
        "attempt",
        expected.attemptId,
        expected.revision,
        current.revision,
      );
    }
    const updated = attemptManifestSchema.parse({
      ...current,
      ...patch,
      schema: "conductor.attempt/v2",
      attemptId: current.attemptId,
      jobId: current.jobId,
      revision: current.revision + 1,
    });
    assertAttemptTransition(current.status, updated.status);
    await commitTransition({
      recordKind: "attempt",
      recordId: current.attemptId,
      expectedRevision: current.revision,
      value: updated,
      transitionsRoot: this.attemptTransitionsRoot(
        current.jobId,
        current.attemptId,
      ),
      snapshotName: "attempt.json",
      projectionPath: this.attemptManifestPath(
        current.jobId,
        current.attemptId,
      ),
      writeJsonAtomic: (target, value) => this.writeJsonAtomic(target, value),
      failpoint: this.options.transitionFailpoint,
    });
    return updated;
  }

  async readAttemptCleanup(
    jobId: string,
    attemptId: string,
  ): Promise<AttemptCleanupRecord> {
    const projection = attemptCleanupRecordSchema.parse(
      await this.readJson(this.attemptCleanupPath(jobId, attemptId)),
    );
    const latest = await readLatestTransition({
      recordKind: "attempt-cleanup",
      recordId: attemptId,
      transitionsRoot: this.attemptCleanupTransitionsRoot(jobId, attemptId),
      snapshotName: "cleanup.json",
      parse: (value) => attemptCleanupRecordSchema.parse(value),
      revisionOf: (value) => value.revision,
    });
    if (!latest) return projection;
    if (latest.revision < projection.revision) {
      throw new Error(
        `Attempt cleanup ${attemptId} projection revision ${projection.revision} is ahead of its transition journal ${latest.revision}`,
      );
    }
    return latest;
  }

  async registerAttemptCleanupRequirement(
    jobId: string,
    attemptId: string,
    input: Omit<CleanupRequirement, "schema" | "registeredAt"> & {
      registeredAt?: string;
    },
  ): Promise<AttemptCleanupRecord> {
    const requirement = cleanupRequirementSchema.parse({
      schema: "conductor.cleanup-requirement/v1",
      ...input,
      registeredAt: input.registeredAt ?? new Date().toISOString(),
    });
    const current = await this.readAttemptCleanup(jobId, attemptId);
    const existing = current.requirements.find((candidate) =>
      sameCleanupSubject(candidate.subject, requirement.subject),
    );
    const requirements = existing
      ? current.requirements.map((candidate) =>
          sameCleanupSubject(candidate.subject, requirement.subject)
            ? {
                ...candidate,
                deadlineMs: requirement.deadlineMs,
                guardian: requirement.guardian ?? candidate.guardian,
              }
            : candidate,
        )
      : [...current.requirements, requirement];
    if (JSON.stringify(requirements) === JSON.stringify(current.requirements)) {
      return current;
    }
    return this.transitionAttemptCleanup(current, { requirements });
  }

  async appendAttemptCleanupEvidence(
    jobId: string,
    attemptId: string,
    input: CleanupEvidence,
  ): Promise<AttemptCleanupRecord> {
    const evidence = cleanupEvidenceSchema.parse(input);
    const current = await this.readAttemptCleanup(jobId, attemptId);
    if (
      !current.requirements.some((requirement) =>
        sameCleanupSubject(requirement.subject, evidence.subject),
      )
    ) {
      throw new Error(
        `Cleanup evidence for unregistered subject ${evidence.subject.kind}:${evidence.subject.id}`,
      );
    }
    if (
      current.evidence.some(
        (observation) => observation.evidenceId === evidence.evidenceId,
      )
    ) {
      return current;
    }
    return this.transitionAttemptCleanup(current, {
      evidence: [...current.evidence, evidence],
    });
  }

  private async transitionAttemptCleanup(
    expected: AttemptCleanupRecord,
    patch: Partial<AttemptCleanupRecord>,
  ): Promise<AttemptCleanupRecord> {
    const current = await this.readAttemptCleanup(
      expected.jobId,
      expected.attemptId,
    );
    if (
      current.revision !== expected.revision ||
      JSON.stringify(current) !== JSON.stringify(expected)
    ) {
      throw new TransitionConflictError(
        "attempt-cleanup",
        expected.attemptId,
        expected.revision,
        current.revision,
      );
    }
    const requirements = patch.requirements ?? current.requirements;
    const evidence = patch.evidence ?? current.evidence;
    const updated = attemptCleanupRecordSchema.parse({
      ...current,
      ...patch,
      schema: "conductor.attempt-cleanup/v1",
      attemptId: current.attemptId,
      jobId: current.jobId,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      status: deriveCleanupStatus(requirements, evidence),
      requirements,
      evidence,
    });
    await commitTransition({
      recordKind: "attempt-cleanup",
      recordId: current.attemptId,
      expectedRevision: current.revision,
      value: updated,
      transitionsRoot: this.attemptCleanupTransitionsRoot(
        current.jobId,
        current.attemptId,
      ),
      snapshotName: "cleanup.json",
      projectionPath: this.attemptCleanupPath(current.jobId, current.attemptId),
      writeJsonAtomic: (target, value) => this.writeJsonAtomic(target, value),
      failpoint: this.options.transitionFailpoint,
    });
    return updated;
  }

  async readAttempt(
    jobId: string,
    attemptId: string,
  ): Promise<AttemptManifest> {
    const projection = attemptManifestSchema.parse(
      await this.readJson(this.attemptManifestPath(jobId, attemptId)),
    );
    const latest = await readLatestTransition({
      recordKind: "attempt",
      recordId: attemptId,
      transitionsRoot: this.attemptTransitionsRoot(jobId, attemptId),
      snapshotName: "attempt.json",
      parse: (value) => attemptManifestSchema.parse(value),
      revisionOf: (value) => value.revision,
    });
    if (!latest) return projection;
    if (latest.revision < projection.revision) {
      throw new Error(
        `Attempt ${attemptId} projection revision ${projection.revision} is ahead of its transition journal ${latest.revision}`,
      );
    }
    return latest;
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

  async listAttempts(): Promise<AttemptManifest[]> {
    await this.initialize();
    const jobs = await readdir(this.jobsRoot(), { withFileTypes: true });
    const attempts: AttemptManifest[] = [];
    for (const job of jobs) {
      if (!job.isDirectory() || job.name.includes(".reserve-")) continue;
      let entries;
      try {
        entries = await readdir(this.attemptsRoot(job.name), {
          withFileTypes: true,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
      for (const attempt of entries) {
        if (!attempt.isDirectory() || attempt.name.includes(".reserve-"))
          continue;
        attempts.push(await this.readAttempt(job.name, attempt.name));
      }
    }
    return attempts.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.attemptId.localeCompare(right.attemptId),
    );
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

  attemptTransitionsRoot(jobId: string, attemptId: string): string {
    return path.join(this.attemptDirectory(jobId, attemptId), "transitions");
  }

  attemptCleanupPath(jobId: string, attemptId: string): string {
    return path.join(this.attemptDirectory(jobId, attemptId), "cleanup.json");
  }

  attemptCleanupTransitionsRoot(jobId: string, attemptId: string): string {
    return path.join(
      this.attemptDirectory(jobId, attemptId),
      "cleanup-transitions",
    );
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
    dispatchOperationId?: string,
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
        cleanup: path.join(directory, "cleanup.json"),
      },
      lineage,
      dispatchOperationId,
    });
    try {
      await this.writeJsonAtomic(
        path.join(stagingDirectory, "attempt.json"),
        manifest,
      );
      await this.writeJsonAtomic(
        path.join(stagingDirectory, "cleanup.json"),
        createAttemptCleanupRecord({ attemptId, jobId: contract.jobId }),
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

const allowedAttemptTransitions: Record<AttemptStatus, AttemptStatus[]> = {
  reserved: ["reserved", "claimed", "cancelled"],
  claimed: ["claimed", "preparing", "cancelled", "failed"],
  preparing: ["preparing", "running", "needs-input", "failed", "cancelled"],
  running: ["running", "verifying", "failed", "cancelled"],
  verifying: ["verifying", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  "needs-input": [],
  cancelled: [],
};

function assertAttemptTransition(
  current: AttemptStatus,
  next: AttemptStatus,
): void {
  if (!allowedAttemptTransitions[current].includes(next)) {
    throw new Error(`Illegal attempt transition: ${current} -> ${next}`);
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
