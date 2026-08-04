import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  readdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  proposalLineageSchema,
  type AttemptManifest,
  type ExternalResource,
  type ProposalContribution,
  type ProposalLineage,
} from "../contracts/attempt.js";
import type {
  AttemptCleanupRecord,
  CleanupEvidence,
  CleanupRequirement,
  CleanupSubject,
} from "../contracts/cleanup.js";
import { latestCleanupEvidence } from "../contracts/cleanup.js";
import {
  fingerprint,
  freezeJobRequest,
  jobRequestSchema,
  type JobContract,
} from "../contracts/job.js";
import {
  DEFAULT_OWNER_RESOURCE_PROFILE,
  type OwnerResourceProfile,
} from "../contracts/resources.js";
import {
  isProcessAlive,
  runProcess,
  type ProcessExecutionResult,
  type ProcessGuardianIdentity,
  type ProcessResult,
} from "../runtime/process-runner.js";
import { runBoundedGit } from "../runtime/git.js";
import { SandboxProfiles, validateSandboxCommand } from "../sandbox/docker.js";
import {
  buildReviewPacket,
  assertReviewArtifactPaths,
  ReviewEvidenceError,
  reviewPacketSchema,
  sha256File,
  validateReviewPacket,
  type ReviewPacket,
  type ReviewEvidenceState,
} from "../review/packet.js";
import {
  captureWorkerExecutionProfile,
  validateWorkerExecutionProfile,
} from "../review/worker-profile.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import {
  GitWorkspaceManager,
  type GitWorkspace,
} from "../workspaces/git-workspace.js";
import { WorkerRegistry } from "../workers/adapter.js";
import {
  ExecutionPolicy,
  executeCommand,
} from "../verification/command-executor.js";
import { evaluatePathScope } from "../verification/scope.js";
import {
  createVerificationRecord,
  verificationRecordSchema,
  type CommandEvidence,
  type VerificationRecord,
} from "../verification/types.js";

export interface RunJobResult {
  jobId: string;
  attemptId: string;
  status: AttemptManifest["status"];
  idempotentReplay: boolean;
  workspacePath?: string;
  workspaceRetained?: boolean;
  artifacts: AttemptManifest["artifacts"];
  failure?: AttemptManifest["failure"];
  verificationStatus: AttemptManifest["verificationStatus"];
  cleanupStatus: AttemptCleanupRecord["status"];
}

export type AttemptArtifactName = keyof AttemptManifest["artifacts"];

export class ProposalLineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalLineageError";
  }
}

export type DiskFreeProbe = (target: string) => Promise<number>;

export class Conductor {
  private readonly activeAttempts = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<AttemptManifest>>();
  private readonly reviewPacketCreations = new Map<
    string,
    Promise<ReviewPacket>
  >();
  private readonly launcherInstanceId = randomUUID();

  constructor(
    readonly store: ArtifactStore,
    readonly workspaces: GitWorkspaceManager,
    readonly workers: WorkerRegistry,
    readonly executionPolicy = new ExecutionPolicy(),
    readonly sandboxProfiles = new SandboxProfiles(),
    readonly resourceProfile: OwnerResourceProfile = DEFAULT_OWNER_RESOURCE_PROFILE,
    readonly diskFreeProbe: DiskFreeProbe = availableDiskBytes,
  ) {}

  async prepareJob(input: unknown): Promise<JobContract> {
    const request = jobRequestSchema.parse(input);
    const commandCount =
      request.setupCommands.length + request.acceptanceCommands.length;
    if (commandCount > this.resourceProfile.limits.maxCommands) {
      throw new Error(
        `Job declares ${commandCount} commands; owner profile allows ${this.resourceProfile.limits.maxCommands}`,
      );
    }
    const requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
    if (requestBytes > this.resourceProfile.limits.maxArtifactBytes) {
      throw new Error(
        `Job request is ${requestBytes} bytes; owner profile allows ${this.resourceProfile.limits.maxArtifactBytes} artifact bytes`,
      );
    }
    const requestedAdapter = this.workers.get(request.adapterId);
    if (!requestedAdapter.description.available) {
      throw new Error(`Worker adapter is not available: ${request.adapterId}`);
    }
    const sandboxBinding =
      request.executionBoundary.kind === "external-sandbox"
        ? this.sandboxProfiles.resolve(request.executionBoundary.profileId)
        : undefined;
    if (sandboxBinding) {
      await this.sandboxProfiles.verify(sandboxBinding);
      if (requestedAdapter.description.hostExecution !== "file-edit-only") {
        throw new Error(
          `External sandbox jobs require a file-edit-only host adapter: ${request.adapterId}`,
        );
      }
      for (const command of [
        ...request.setupCommands,
        ...request.acceptanceCommands,
      ]) {
        validateSandboxCommand(sandboxBinding, command);
      }
    }
    const repository = await this.workspaces.inspectRepository(
      request.repositoryPath,
      request.baseRef,
      {
        gitTimeoutMs: this.resourceProfile.limits.gitTimeoutMs,
        maxGitOutputBytes: this.resourceProfile.limits.maxLogBytes,
      },
    );
    const candidate = freezeJobRequest(request, {
      repositoryRoot: repository.root,
      baseRevision: repository.revision,
      sandboxBinding,
      resourceProfile: this.resourceProfile,
    });
    await assertDiskHeadroom(
      this.store.root,
      candidate.resources.minimumFreeDiskBytes,
      this.diskFreeProbe,
    );
    const reservation = await this.store.reserveJob(candidate);
    return reservation.contract;
  }

  async reservePreparedAttempt(
    jobId: string,
    parentAttemptIds: string[] = [],
    dispatchOperationId?: string,
  ): Promise<RunJobResult> {
    const contract = await this.store.readJob(jobId);
    if (parentAttemptIds.length > contract.resources.maxLineageContributions) {
      throw new ProposalLineageError(
        `Direct proposal lineage has ${parentAttemptIds.length} parents; budget allows ${contract.resources.maxLineageContributions}`,
      );
    }
    const adapter = this.workers.get(contract.worker.adapterId);
    if (!adapter.description.available) {
      throw new Error(
        `Worker adapter is not available: ${contract.worker.adapterId}`,
      );
    }
    let lineage: ProposalLineage | undefined;
    if (parentAttemptIds.length) {
      try {
        lineage = await this.buildProposalLineage(contract, parentAttemptIds);
      } catch (error) {
        throw new ProposalLineageError(errorMessage(error));
      }
    }
    const attemptReservation = await this.store.reserveAttempt(
      contract,
      lineage,
      dispatchOperationId,
    );
    return this.summarize(attemptReservation.manifest, false);
  }

  async startReservedAttempt(
    attemptId: string,
    dispatchOperationId: string,
  ): Promise<RunJobResult> {
    const claimed = await this.claimReservedAttempt(
      attemptId,
      dispatchOperationId,
    );
    await this.launchClaimedAttempt(attemptId, dispatchOperationId);
    return claimed;
  }

  async claimReservedAttempt(
    attemptId: string,
    dispatchOperationId: string,
  ): Promise<RunJobResult> {
    const manifest = await this.getAttempt(attemptId);
    if (manifest.status !== "reserved") {
      throw new Error(
        `Attempt ${attemptId} cannot start from status ${manifest.status}`,
      );
    }
    if (
      manifest.dispatchOperationId &&
      manifest.dispatchOperationId !== dispatchOperationId
    ) {
      throw new Error(
        `Attempt ${attemptId} belongs to dispatch operation ${manifest.dispatchOperationId}`,
      );
    }
    const contract = await this.store.readJob(manifest.jobId);
    if (contract.execution.boundary.kind === "external-sandbox") {
      await this.sandboxProfiles.verify(contract.execution.boundary);
    }
    const adapter = this.workers.get(contract.worker.adapterId);
    if (!adapter.description.available) {
      throw new Error(
        `Worker adapter is not available: ${contract.worker.adapterId}`,
      );
    }
    const claimed = await this.store.transitionAttempt(manifest, {
      status: "claimed",
      dispatchOperationId,
      launchOwner: {
        instanceId: this.launcherInstanceId,
        processId: process.pid,
        claimedAt: new Date().toISOString(),
      },
    });
    return this.summarize(claimed, false);
  }

  async launchClaimedAttempt(
    attemptId: string,
    dispatchOperationId: string,
  ): Promise<RunJobResult> {
    const manifest = await this.getAttempt(attemptId);
    if (
      manifest.status !== "claimed" ||
      manifest.dispatchOperationId !== dispatchOperationId
    ) {
      throw new Error(
        `Attempt ${attemptId} is not claimed by dispatch operation ${dispatchOperationId}`,
      );
    }
    if (manifest.launchOwner?.instanceId !== this.launcherInstanceId) {
      throw new Error(
        `Attempt ${attemptId} belongs to another launcher instance`,
      );
    }
    if (this.executions.has(attemptId)) {
      throw new Error(`Attempt ${attemptId} is already executing`);
    }
    const contract = await this.store.readJob(manifest.jobId);
    if (this.executions.has(attemptId)) {
      throw new Error(`Attempt ${attemptId} is already executing`);
    }
    this.launchAttempt(contract, manifest);
    return this.summarize(manifest, false);
  }

  async waitForAttempt(attemptId: string): Promise<RunJobResult> {
    const execution = this.executions.get(attemptId);
    const manifest = execution
      ? await execution
      : await this.getAttempt(attemptId);
    return this.summarize(manifest, false);
  }

  async getAttempt(attemptId: string): Promise<AttemptManifest> {
    return this.store.findAttempt(attemptId);
  }

  async listAttempts(): Promise<AttemptManifest[]> {
    return this.store.listAttempts();
  }

  async getAttemptCleanup(attemptId: string): Promise<AttemptCleanupRecord> {
    const manifest = await this.getAttempt(attemptId);
    return this.store.readAttemptCleanup(manifest.jobId, manifest.attemptId);
  }

  async getVerification(attemptId: string): Promise<VerificationRecord> {
    const manifest = await this.getAttempt(attemptId);
    return verificationRecordSchema.parse(
      JSON.parse(await readFile(manifest.artifacts.verification, "utf8")),
    );
  }

  async getReviewPacket(attemptId: string): Promise<ReviewPacket> {
    const existing = this.reviewPacketCreations.get(attemptId);
    if (existing) return existing;
    const creation = this.readOrCreateReviewPacket(attemptId);
    this.reviewPacketCreations.set(attemptId, creation);
    try {
      return await creation;
    } finally {
      if (this.reviewPacketCreations.get(attemptId) === creation) {
        this.reviewPacketCreations.delete(attemptId);
      }
    }
  }

  private async readOrCreateReviewPacket(
    attemptId: string,
  ): Promise<ReviewPacket> {
    const manifest = await this.getAttempt(attemptId);
    if (
      manifest.status !== "completed" ||
      manifest.verificationStatus !== "eligible"
    ) {
      throw new ReviewEvidenceError(
        "unavailable",
        `Attempt ${attemptId} is not eligible for review`,
      );
    }
    const contract = await this.store.readJob(manifest.jobId);
    if (manifest.lineage?.status === "composed") {
      await this.validateProposalLineage(contract, manifest.lineage);
    }
    const state = await this.readReviewEvidenceState(contract, manifest);
    const target = path.join(
      path.dirname(manifest.artifacts.manifest),
      "review-packet.json",
    );
    try {
      const raw = JSON.parse(await readFile(target, "utf8")) as {
        schema?: unknown;
      };
      if (raw.schema === "conductor.review-packet/v1") {
        throw new ReviewEvidenceError(
          "legacy-unsealed",
          `Attempt ${attemptId} has a legacy packet that cannot be upgraded without historical evidence`,
        );
      }
      const packet = reviewPacketSchema.parse(raw);
      await validateReviewPacket(packet, state);
      return packet;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
    const packet = await buildReviewPacket(state);
    try {
      await this.store.writeJsonAtomic(target, packet);
    } catch (error) {
      try {
        const winner = reviewPacketSchema.parse(
          JSON.parse(await readFile(target, "utf8")),
        );
        await validateReviewPacket(winner, state);
        return winner;
      } catch {
        throw error;
      }
    }
    await validateReviewPacket(
      packet,
      await this.readReviewEvidenceState(
        await this.store.readJob(manifest.jobId),
        await this.getAttempt(attemptId),
      ),
    );
    return packet;
  }

  async getReviewBundle(attemptId: string, maxPatchBytes = 500_000) {
    const packet = await this.getReviewPacket(attemptId);
    const patch = await this.readAttemptArtifact(
      attemptId,
      "proposalPatch",
      maxPatchBytes,
    );
    const manifest = await this.getAttempt(attemptId);
    await validateReviewPacket(
      packet,
      await this.readReviewEvidenceState(
        await this.store.readJob(manifest.jobId),
        manifest,
      ),
    );
    return { packet, patch };
  }

  private async readReviewEvidenceState(
    contract: JobContract,
    manifest: AttemptManifest,
  ): Promise<ReviewEvidenceState> {
    const attemptDirectory = this.store.attemptDirectory(
      manifest.jobId,
      manifest.attemptId,
    );
    const jobPath = this.store.jobPath(manifest.jobId);
    assertReviewArtifactPaths({ manifest, attemptDirectory, jobPath });
    const [cleanup, verification, changedPathsRaw] = await Promise.all([
      this.store.readAttemptCleanup(manifest.jobId, manifest.attemptId),
      this.getVerification(manifest.attemptId),
      readFile(manifest.artifacts.changedPaths, "utf8"),
    ]);
    const changedPaths = JSON.parse(changedPathsRaw) as unknown;
    if (
      !Array.isArray(changedPaths) ||
      !changedPaths.every((entry) => typeof entry === "string")
    ) {
      throw new ReviewEvidenceError(
        "corrupt",
        `Invalid changed-path evidence for ${manifest.attemptId}`,
      );
    }
    return {
      contract,
      manifest,
      cleanup,
      verification,
      changedPaths,
      attemptDirectory,
      jobPath,
    };
  }

  async readAttemptArtifact(
    attemptId: string,
    name: AttemptArtifactName,
    maxBytes = 200_000,
  ): Promise<{
    attemptId: string;
    name: AttemptArtifactName;
    path: string;
    size: number;
    truncated: boolean;
    text: string;
  }> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 1_000_000
    ) {
      throw new Error("maxBytes must be an integer between 1 and 1000000");
    }
    const manifest = await this.getAttempt(attemptId);
    const artifactPath = manifest.artifacts[name];
    if (!artifactPath) {
      throw new Error(
        `Artifact ${name} is unavailable for attempt ${attemptId}`,
      );
    }
    const size = (await stat(artifactPath)).size;
    const bytes = Buffer.alloc(Math.min(size, maxBytes));
    const handle = await open(artifactPath, "r");
    try {
      await handle.read(bytes, 0, bytes.length, 0);
    } finally {
      await handle.close();
    }
    return {
      attemptId,
      name,
      path: artifactPath,
      size,
      truncated: size > maxBytes,
      text: bytes.toString("utf8"),
    };
  }

  cancelAttempt(attemptId: string): boolean {
    const controller = this.activeAttempts.get(attemptId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async cancelReservedAttempt(
    attemptId: string,
    message = "Attempt cancelled before worker execution",
  ): Promise<AttemptManifest> {
    const manifest = await this.getAttempt(attemptId);
    if (!["reserved", "claimed"].includes(manifest.status)) return manifest;
    return this.update(manifest, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      verificationStatus: "ineligible",
      failure: { kind: "cancelled", message },
    });
  }

  private async buildProposalLineage(
    contract: JobContract,
    parentAttemptIds: string[],
  ): Promise<ProposalLineage> {
    const directParentAttemptIds = [...new Set(parentAttemptIds)];
    const contributions = new Map<string, ProposalContribution>();
    const add = (candidate: ProposalContribution): void => {
      const existing = contributions.get(candidate.attemptId);
      if (existing && fingerprint(existing) !== fingerprint(candidate)) {
        throw new Error(
          `Proposal lineage contains conflicting bindings for ${candidate.attemptId}`,
        );
      }
      if (!existing) contributions.set(candidate.attemptId, candidate);
    };

    for (const attemptId of directParentAttemptIds) {
      const parent = await this.getAttempt(attemptId);
      if (parent.lineage) {
        if (parent.lineage.status !== "composed") {
          throw new Error(
            `Parent attempt ${attemptId} has unresolved proposal lineage`,
          );
        }
        for (const contribution of parent.lineage.contributions) {
          add(contribution);
        }
      }
      add(await this.bindProposalContribution(contract, parent));
    }

    if (contributions.size > contract.resources.maxLineageContributions) {
      throw new Error(
        `Proposal lineage has ${contributions.size} contributions; budget allows ${contract.resources.maxLineageContributions}`,
      );
    }
    const lineageBytes = [...contributions.values()].reduce(
      (total, contribution) => total + contribution.patchBytes,
      0,
    );
    if (lineageBytes > contract.resources.maxArtifactBytes) {
      throw new Error(
        `Proposal lineage binds ${lineageBytes} patch bytes; budget allows ${contract.resources.maxArtifactBytes}`,
      );
    }

    const lineage = proposalLineageSchema.parse({
      schema: "conductor.proposal-lineage/v1",
      sourceBaseRevision: contract.repository.baseRevision,
      directParentAttemptIds,
      contributions: [...contributions.values()],
      status: "pending",
    });
    await this.validateProposalLineage(contract, lineage);
    return lineage;
  }

  private async bindProposalContribution(
    childContract: JobContract,
    parent: AttemptManifest,
  ): Promise<ProposalContribution> {
    const parentContract = await this.store.readJob(parent.jobId);
    if (
      !samePath(parentContract.repository.root, childContract.repository.root)
    ) {
      throw new Error(
        `Proposal ${parent.attemptId} belongs to a different repository`,
      );
    }
    if (
      parentContract.repository.baseRevision !==
      childContract.repository.baseRevision
    ) {
      throw new Error(
        `Proposal ${parent.attemptId} starts from ${parentContract.repository.baseRevision}, not ${childContract.repository.baseRevision}`,
      );
    }
    if (
      parent.status !== "completed" ||
      parent.verificationStatus !== "eligible" ||
      !parent.workspace
    ) {
      throw new Error(
        `Proposal ${parent.attemptId} is not a completed eligible workspace attempt`,
      );
    }
    if (["rejected", "superseded"].includes(parent.reviewDisposition)) {
      throw new Error(
        `Proposal ${parent.attemptId} was ${parent.reviewDisposition} by its review authority`,
      );
    }
    const verification = await this.getVerification(parent.attemptId);
    if (!verification.eligibleForReview) {
      throw new Error(
        `Proposal ${parent.attemptId} lacks eligible deterministic evidence`,
      );
    }
    const patchStat = await stat(parent.artifacts.proposalPatch);
    return {
      jobId: parent.jobId,
      attemptId: parent.attemptId,
      jobRequestFingerprint: parentContract.requestFingerprint,
      sourceBaseRevision: parentContract.repository.baseRevision,
      patchBaseRevision: parent.workspace.baseRevision,
      patchPath: parent.artifacts.proposalPatch,
      patchSha256: await sha256File(parent.artifacts.proposalPatch),
      patchBytes: patchStat.size,
      verificationPath: parent.artifacts.verification,
      verificationSha256: await sha256File(parent.artifacts.verification),
    };
  }

  private async validateProposalLineage(
    contract: JobContract,
    lineage: ProposalLineage,
  ): Promise<void> {
    if (lineage.sourceBaseRevision !== contract.repository.baseRevision) {
      throw new Error("Proposal lineage source revision changed");
    }
    for (const expected of lineage.contributions) {
      const actual = await this.bindProposalContribution(
        contract,
        await this.getAttempt(expected.attemptId),
      );
      if (fingerprint(actual) !== fingerprint(expected)) {
        throw new Error(
          `Proposal evidence binding changed for ${expected.attemptId}`,
        );
      }
    }
  }

  async recoverInterruptedAttempt(
    attemptId: string,
    guardianExitGraceMs = 5_000,
  ): Promise<{
    disposition: "terminal" | "safe-to-retry" | "still-running" | "unknown";
    manifest: AttemptManifest;
  }> {
    let manifest = await this.getAttempt(attemptId);
    if (isAttemptTerminal(manifest.status)) {
      return { disposition: "terminal", manifest };
    }
    if (["reserved", "claimed"].includes(manifest.status)) {
      manifest = await this.update(manifest, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        verificationStatus: "ineligible",
        failure: {
          kind: "orphaned",
          message: `${manifest.status === "claimed" ? "Claimed" : "Reserved"} attempt lost dispatcher ownership before execution`,
        },
      });
      return { disposition: "safe-to-retry", manifest };
    }
    let cleanup: AttemptCleanupRecord;
    try {
      cleanup = await this.getAttemptCleanup(attemptId);
    } catch {
      return { disposition: "unknown", manifest };
    }
    let processRequirements = cleanup.requirements.filter(
      (requirement) => requirement.subject.kind === "process-tree",
    );
    if (processRequirements.length === 0 && manifest.guardian) {
      await this.registerProcessCleanup(
        manifest,
        "legacy-interrupted-process",
        manifest.guardian,
      );
      cleanup = await this.getAttemptCleanup(attemptId);
      processRequirements = cleanup.requirements.filter(
        (requirement) => requirement.subject.kind === "process-tree",
      );
    }
    if (processRequirements.length === 0) {
      return { disposition: "unknown", manifest };
    }
    const unresolved = processRequirements.filter(
      (requirement) =>
        latestCleanupEvidence(cleanup, requirement.subject)?.status !==
        "proven",
    );
    if (
      unresolved.some(
        (requirement) =>
          requirement.guardian &&
          isProcessAlive(requirement.guardian.guardianPid),
      )
    ) {
      await delay(guardianExitGraceMs);
      manifest = await this.getAttempt(attemptId);
      if (
        unresolved.some(
          (requirement) =>
            requirement.guardian &&
            isProcessAlive(requirement.guardian.guardianPid),
        )
      ) {
        return { disposition: "still-running", manifest };
      }
    }
    for (const requirement of unresolved) {
      const guardian = requirement.guardian;
      const kernelClosure =
        guardian?.schema === "conductor.process-guardian/v2" &&
        guardian.containment.kind === "windows-job" &&
        guardian.containment.kernelEnforced &&
        guardian.containment.killOnOwnerClose &&
        !isProcessAlive(guardian.guardianPid);
      await this.appendCleanupEvidence(manifest, {
        subject: requirement.subject,
        status: kernelClosure ? "proven" : "unknown",
        method: kernelClosure ? "windows-job-owner-exit" : "legacy-unverified",
        detail: kernelClosure
          ? "Verified Windows Job owner is absent; kill-on-close enforces descendant termination"
          : "Guardian disappearance does not prove descendant absence on this containment record",
        termination: {
          schema: "conductor.process-termination/v1",
          status: kernelClosure ? "proven" : "unknown",
          method: kernelClosure
            ? "windows-job-owner-exit"
            : "guardian-exit-unverified",
          observedAt: new Date().toISOString(),
        },
      });
    }
    cleanup = await this.getAttemptCleanup(attemptId);
    if (
      cleanup.requirements
        .filter((requirement) => requirement.subject.kind === "process-tree")
        .some(
          (requirement) =>
            latestCleanupEvidence(cleanup, requirement.subject)?.status !==
            "proven",
        )
    ) {
      return { disposition: "unknown", manifest };
    }
    const externalCleanup = await this.cleanupExternalResources(manifest);
    manifest = externalCleanup.manifest;
    if (!externalCleanup.safe) return { disposition: "unknown", manifest };
    manifest = await this.update(manifest, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      verificationStatus: "ineligible",
      failure: {
        kind: "orphaned",
        message:
          "Recorded process guardian is no longer alive; its ownership pipe closed before retry",
      },
    });
    const contract = await this.store.readJob(manifest.jobId);
    if (manifest.workspace && !contract.execution.retainWorkspace) {
      try {
        await this.removeAttemptWorkspace(manifest.attemptId);
      } catch {
        return { disposition: "unknown", manifest };
      }
    }
    cleanup = await this.getAttemptCleanup(attemptId);
    if (!["not-required", "proven"].includes(cleanup.status)) {
      return { disposition: "unknown", manifest };
    }
    return { disposition: "safe-to-retry", manifest };
  }

  async releaseAttemptExternalResources(
    attemptId: string,
  ): Promise<AttemptManifest> {
    const manifest = await this.getAttempt(attemptId);
    if (!isAttemptTerminal(manifest.status)) {
      throw new Error(
        `Attempt ${attemptId} is still ${manifest.status}; its external resources may still be in use`,
      );
    }
    const cleanup = await this.cleanupExternalResources(manifest);
    if (!cleanup.safe) {
      throw new Error(
        `Attempt ${attemptId} still owns an external resource; retry or workspace removal is prohibited`,
      );
    }
    const evidence = await this.getAttemptCleanup(attemptId);
    if (!["not-required", "proven"].includes(evidence.status)) {
      throw new Error(
        `Attempt ${attemptId} cleanup is ${evidence.status}; retry or workspace removal is prohibited`,
      );
    }
    return cleanup.manifest;
  }

  async removeAttemptWorkspace(attemptId: string): Promise<{
    manifest: AttemptManifest;
    cleanup: AttemptCleanupRecord;
  }> {
    let manifest = await this.getAttempt(attemptId);
    if (
      ["reserved", "claimed", "preparing", "running", "verifying"].includes(
        manifest.status,
      )
    ) {
      throw new Error(
        `Cannot remove workspace for active attempt ${attemptId}`,
      );
    }
    const externalCleanup = await this.cleanupExternalResources(manifest);
    manifest = externalCleanup.manifest;
    if (!externalCleanup.safe) {
      throw new Error(
        `Attempt ${attemptId} still owns an external resource; workspace removal is prohibited`,
      );
    }
    if (!manifest.workspace || !manifest.workspace.retained) {
      return { manifest, cleanup: await this.getAttemptCleanup(attemptId) };
    }

    await this.assertWorkspaceRemovalSafe(manifest);

    const priorCleanup = await this.getAttemptCleanup(attemptId);
    if (
      latestCleanupEvidence(priorCleanup, {
        kind: "workspace",
        id: "worktree",
      })?.status === "proven"
    ) {
      return { manifest, cleanup: priorCleanup };
    }
    await this.registerCleanupRequirement(manifest, {
      kind: "workspace",
      id: "worktree",
    });

    const contract = await this.store.readJob(manifest.jobId);
    try {
      await this.workspaces.remove({
        path: manifest.workspace.path,
        repositoryRoot: contract.repository.root,
        baseRevision: manifest.workspace.baseRevision,
        gitTimeoutMs: contract.resources.gitTimeoutMs,
        maxGitOutputBytes: contract.resources.maxLogBytes,
        cleanupTimeoutMs: contract.resources.cleanupTimeoutMs,
        maxPatchBytes: contract.resources.maxPatchBytes,
      });
      const cleanup = await this.appendCleanupEvidence(manifest, {
        subject: { kind: "workspace", id: "worktree" },
        status: "proven",
        method: "workspace-remove",
        detail: "Recorded attempt worktree removed by owner request",
      });
      return { manifest, cleanup };
    } catch (error) {
      await this.appendCleanupEvidence(manifest, {
        subject: { kind: "workspace", id: "worktree" },
        status: "failed",
        method: "workspace-remove",
        detail: errorMessage(error),
      });
      throw error;
    }
  }

  private launchAttempt(
    contract: JobContract,
    manifest: AttemptManifest,
  ): void {
    const abortController = new AbortController();
    this.activeAttempts.set(manifest.attemptId, abortController);
    const execution = this.executeAttempt(
      contract,
      manifest,
      abortController,
    ).finally(() => {
      this.activeAttempts.delete(manifest.attemptId);
      this.executions.delete(manifest.attemptId);
    });
    this.executions.set(manifest.attemptId, execution);
    // Submission is intentionally fire-and-poll. Attach a rejection observer so
    // a catastrophic persistence failure cannot become an unhandled rejection;
    // explicit waiters still receive the original rejected promise.
    void execution.catch(() => undefined);
  }

  private async executeAttempt(
    contract: ReturnType<typeof freezeJobRequest>,
    initialManifest: AttemptManifest,
    abortController: AbortController,
  ): Promise<AttemptManifest> {
    const deadlineAt = Date.now() + contract.resources.attemptTimeoutMs;
    const deadlineSignal = AbortSignal.timeout(
      contract.resources.attemptTimeoutMs,
    );
    const budgetController = new AbortController();
    const attemptSignal = AbortSignal.any([
      abortController.signal,
      deadlineSignal,
      budgetController.signal,
    ]);
    let manifest = initialManifest;
    let workspace: GitWorkspace | undefined;
    let budgetMonitor: ResourceBudgetMonitor | undefined;
    let verification = createVerificationRecord({
      jobId: contract.jobId,
      attemptId: initialManifest.attemptId,
      hasSetup: contract.setupCommands.length > 0,
      hasAcceptance: contract.acceptanceCommands.length > 0,
    });

    try {
      manifest = await this.update(manifest, { status: "preparing" });
      if (!contract.execution.retainWorkspace) {
        await this.registerCleanupRequirement(manifest, {
          kind: "workspace",
          id: "worktree",
        });
      }
      workspace = await this.workspaces.create({
        repositoryRoot: contract.repository.root,
        baseRevision: contract.repository.baseRevision,
        attemptId: manifest.attemptId,
        gitTimeoutMs: contract.resources.gitTimeoutMs,
        maxGitOutputBytes: contract.resources.maxLogBytes,
        cleanupTimeoutMs: contract.resources.cleanupTimeoutMs,
        maxPatchBytes: contract.resources.maxPatchBytes,
      });
      budgetMonitor = new ResourceBudgetMonitor(
        workspace.path,
        path.dirname(manifest.artifacts.manifest),
        contract,
        budgetController,
        this.diskFreeProbe,
      );
      budgetMonitor.start();
      await budgetMonitor.assertWithinBudget();
      manifest = await this.update(manifest, {
        workspace: {
          path: workspace.path,
          baseRevision: workspace.baseRevision,
          retained: true,
        },
        startedAt: new Date().toISOString(),
        verificationStatus: "running",
      });
      await this.writeVerification(manifest, verification);

      if (manifest.lineage) {
        const lineage = manifest.lineage;
        try {
          await this.validateProposalLineage(contract, lineage);
          workspace = await this.workspaces.composeProposalBaseline(
            workspace,
            lineage.contributions,
          );
          manifest = await this.update(manifest, {
            workspace: {
              path: workspace.path,
              baseRevision: workspace.baseRevision,
              retained: true,
            },
            lineage: {
              ...lineage,
              status: "composed",
              derivedRevision: workspace.baseRevision,
              composedAt: new Date().toISOString(),
              failure: undefined,
            },
          });
        } catch (error) {
          const message = errorMessage(error);
          verification = { ...verification, eligibleForReview: false };
          await this.writeVerification(manifest, verification);
          manifest = await this.update(manifest, {
            status: "needs-input",
            finishedAt: new Date().toISOString(),
            verificationStatus: "ineligible",
            lineage: {
              ...lineage,
              status: "rejected",
              failure: message,
            },
            failure: { kind: "composition-failed", message },
          });
          throw new TerminalAttempt(manifest);
        }
      }

      if (contract.setupCommands.length > 0) {
        const commands = await runCommandSequence({
          commands: contract.setupCommands,
          phase: "setup",
          workspacePath: workspace.path,
          artifactDirectory: path.dirname(manifest.artifacts.manifest),
          defaultTimeoutMs: contract.execution.timeoutMs,
          deadlineAt,
          maxLogBytes: contract.resources.maxLogBytes,
          cleanupTimeoutMs: contract.resources.cleanupTimeoutMs,
          policy: this.executionPolicy,
          signal: attemptSignal,
          executionBoundary: contract.execution.boundary,
          attemptId: manifest.attemptId,
          onGuardianReady: async (operationId, identity) => {
            await this.registerProcessCleanup(manifest, operationId, identity);
            manifest = await this.update(manifest, { guardian: identity });
          },
          onProcessResult: async (operationId, result) => {
            await this.recordProcessCleanup(manifest, operationId, result);
            assertProcessCleanupProven(operationId, result);
          },
          onExternalResource: async (resource) => {
            manifest = await this.registerExternalResource(
              manifest,
              resource,
              contract.resources.maxExternalResources,
            );
          },
          onExternalResourceReleased: async (resourceId, cleanup) => {
            manifest = await this.releaseExternalResource(
              manifest,
              resourceId,
              cleanup,
            );
          },
        });
        await budgetMonitor.assertWithinBudget();
        const repositoryClean =
          (await captureGit(
            workspace.path,
            ["status", "--porcelain=v2", "--untracked-files=all"],
            contract,
          )) === "";
        verification = {
          ...verification,
          setup: {
            status: repositoryClean ? phaseStatus(commands) : "failed",
            commands,
            repositoryClean,
          },
        };
        await this.writeVerification(manifest, verification);
        if (verification.setup.status !== "passed") {
          const cancelled =
            verification.setup.status === "cancelled" &&
            !deadlineSignal.aborted;
          verification = {
            ...verification,
            acceptance: {
              ...verification.acceptance,
              status: "not-run",
              proposalStable: null,
            },
            eligibleForReview: false,
          };
          await this.writeVerification(manifest, verification);
          manifest = await this.update(manifest, {
            status: cancelled ? "cancelled" : "failed",
            finishedAt: new Date().toISOString(),
            verificationStatus: "ineligible",
            failure: {
              kind: deadlineSignal.aborted
                ? "timeout"
                : cancelled
                  ? "cancelled"
                  : "setup-failed",
              message: deadlineSignal.aborted
                ? "Total attempt deadline expired during setup"
                : repositoryClean
                  ? `Setup phase ended with ${verification.setup.status}`
                  : "Setup commands changed tracked or untracked repository state",
            },
          });
          throw new TerminalAttempt(manifest);
        }
      }

      const adapter = this.workers.get(contract.worker.adapterId);
      const invocation = adapter.buildInvocation(contract, workspace.path, {
        attemptId: manifest.attemptId,
        workspaceBaseRevision: workspace.baseRevision,
        sourceBaseRevision: contract.repository.baseRevision,
        proposalContributionAttemptIds:
          manifest.lineage?.contributions.map((entry) => entry.attemptId) ?? [],
      });
      const workerProfile = await captureWorkerExecutionProfile({
        adapter,
        contract,
        invocation,
      });
      manifest = await this.update(manifest, {
        status: "running",
        invocation: {
          executable: invocation.executable,
          args: invocation.args,
          cwd: invocation.cwd,
          environmentKeys: Object.keys(invocation.env ?? {}).sort(),
        },
        workerProfile,
      });

      if (workerProfile.status === "complete") {
        await validateWorkerExecutionProfile(workerProfile);
      }

      const processResult = await runProcess(invocation, {
        stdoutPath: manifest.artifacts.stdout,
        stderrPath: manifest.artifacts.stderr,
        timeoutMs: remainingTimeout(deadlineAt),
        signal: attemptSignal,
        maxStdoutBytes: contract.resources.maxLogBytes,
        maxStderrBytes: contract.resources.maxLogBytes,
        onGuardianReady: async (identity) => {
          await this.registerProcessCleanup(manifest, "worker", identity);
          manifest = await this.update(manifest, { guardian: identity });
        },
        onSpawn: async (workerPid) => {
          if (!manifest.guardian) return;
          manifest = await this.update(manifest, {
            guardian: { ...manifest.guardian, workerPid },
          });
        },
      });
      await budgetMonitor.assertWithinBudget();
      await this.recordProcessCleanup(manifest, "worker", processResult);
      assertProcessCleanupProven("worker", processResult);
      if (processResult.outputLimit) {
        throw new ResourceLimitError(
          `${processResult.outputLimit.stream} exceeded ${processResult.outputLimit.limitBytes} bytes`,
        );
      }
      let proposal: ProposalCapture;
      try {
        proposal = await captureProposal(workspace, manifest, contract);
        await budgetMonitor.assertWithinBudget();
      } catch (error) {
        let captureError = error;
        try {
          await budgetMonitor.assertWithinBudget();
        } catch (budgetError) {
          captureError = budgetError;
        }
        verification = {
          ...verification,
          acceptance: {
            ...verification.acceptance,
            status: "not-run",
            proposalStable: null,
          },
          eligibleForReview: false,
        };
        await this.writeVerification(manifest, verification);
        manifest = await this.update(manifest, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          process: processResult,
          verificationStatus: "ineligible",
          failure: {
            kind:
              captureError instanceof ResourceLimitError
                ? "resource-limit"
                : "proposal-capture-failed",
            message: errorMessage(captureError),
          },
        });
        throw new TerminalAttempt(manifest);
      }

      verification = {
        ...verification,
        scope: evaluatePathScope(proposal.changedPaths, contract.scope),
      };

      if (
        processResult.cancelled ||
        processResult.timedOut ||
        processResult.exitCode !== 0
      ) {
        verification = {
          ...verification,
          acceptance: {
            ...verification.acceptance,
            status: "not-run",
            proposalStable: null,
          },
          eligibleForReview: false,
        };
        await this.writeVerification(manifest, verification);
      }

      if (processResult.cancelled) {
        manifest = await this.update(manifest, {
          status: deadlineSignal.aborted ? "failed" : "cancelled",
          finishedAt: new Date().toISOString(),
          process: processResult,
          verificationStatus: "ineligible",
          failure: {
            kind: deadlineSignal.aborted ? "timeout" : "cancelled",
            message: deadlineSignal.aborted
              ? "Total attempt deadline expired during worker execution"
              : "Attempt cancelled by Conductor",
          },
        });
      } else if (processResult.timedOut) {
        manifest = await this.update(manifest, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          process: processResult,
          verificationStatus: "ineligible",
          failure: {
            kind: "timeout",
            message: "Worker exceeded its job timeout",
          },
        });
      } else if (processResult.exitCode !== 0) {
        manifest = await this.update(manifest, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          process: processResult,
          verificationStatus: "ineligible",
          failure: {
            kind: "worker-exit",
            message: `Worker exited with code ${processResult.exitCode}`,
          },
        });
      } else {
        manifest = await this.update(manifest, {
          status: "verifying",
          process: processResult,
        });
        if (verification.scope.status === "failed") {
          verification = {
            ...verification,
            acceptance: {
              ...verification.acceptance,
              status: "not-run",
              proposalStable: null,
            },
            eligibleForReview: false,
          };
        } else if (contract.acceptanceCommands.length > 0) {
          const commands = await runCommandSequence({
            commands: contract.acceptanceCommands,
            phase: "acceptance",
            workspacePath: workspace.path,
            artifactDirectory: path.dirname(manifest.artifacts.manifest),
            defaultTimeoutMs: contract.execution.timeoutMs,
            deadlineAt,
            maxLogBytes: contract.resources.maxLogBytes,
            cleanupTimeoutMs: contract.resources.cleanupTimeoutMs,
            policy: this.executionPolicy,
            signal: attemptSignal,
            executionBoundary: contract.execution.boundary,
            attemptId: manifest.attemptId,
            onGuardianReady: async (operationId, identity) => {
              await this.registerProcessCleanup(
                manifest,
                operationId,
                identity,
              );
              manifest = await this.update(manifest, { guardian: identity });
            },
            onProcessResult: async (operationId, result) => {
              await this.recordProcessCleanup(manifest, operationId, result);
              assertProcessCleanupProven(operationId, result);
            },
            onExternalResource: async (resource) => {
              manifest = await this.registerExternalResource(
                manifest,
                resource,
                contract.resources.maxExternalResources,
              );
            },
            onExternalResourceReleased: async (resourceId, cleanup) => {
              manifest = await this.releaseExternalResource(
                manifest,
                resourceId,
                cleanup,
              );
            },
          });
          await budgetMonitor.assertWithinBudget();
          const finalPatch = await captureCurrentPatch(workspace, contract);
          await budgetMonitor.assertWithinBudget();
          const proposalStable = finalPatch === proposal.patch;
          verification = {
            ...verification,
            acceptance: {
              status: phaseStatus(commands),
              commands,
              proposalStable,
            },
          };
          verification = {
            ...verification,
            eligibleForReview:
              verification.acceptance.status === "passed" &&
              proposalStable &&
              workerProfile.status === "complete",
          };
        } else {
          verification = {
            ...verification,
            acceptance: {
              status: "not-configured",
              commands: [],
              proposalStable: true,
            },
            eligibleForReview: workerProfile.status === "complete",
          };
        }
        await this.writeVerification(manifest, verification);
        const verificationCancelled =
          verification.acceptance.status === "cancelled";
        const verificationTimedOut =
          verificationCancelled && deadlineSignal.aborted;
        manifest = await this.update(manifest, {
          status: verificationTimedOut
            ? "failed"
            : verificationCancelled
              ? "cancelled"
              : "completed",
          finishedAt: new Date().toISOString(),
          process: processResult,
          verificationStatus: verification.eligibleForReview
            ? "eligible"
            : "ineligible",
          failure: verificationTimedOut
            ? {
                kind: "timeout",
                message:
                  "Total attempt deadline expired during deterministic verification",
              }
            : verificationCancelled
              ? {
                  kind: "cancelled",
                  message:
                    "Attempt cancelled during deterministic verification",
                }
              : undefined,
        });
      }
    } catch (error) {
      if (error instanceof TerminalAttempt) {
        manifest = error.manifest;
      } else {
        manifest = await this.update(manifest, {
          status:
            abortController.signal.aborted && !deadlineSignal.aborted
              ? "cancelled"
              : "failed",
          finishedAt: new Date().toISOString(),
          failure: classifyFailure(
            error,
            manifest.status,
            abortController.signal.aborted && !deadlineSignal.aborted,
          ),
          verificationStatus: "ineligible",
        });
      }
    } finally {
      budgetMonitor?.stop();
      if (workspace && !contract.execution.retainWorkspace) {
        try {
          const externalCleanup = await this.cleanupExternalResources(manifest);
          manifest = externalCleanup.manifest;
          if (!externalCleanup.safe) {
            throw new Error(
              "External resource cleanup failed; its worktree must remain available",
            );
          }
          await this.assertWorkspaceRemovalSafe(manifest);
          await this.workspaces.remove(workspace);
          await this.appendCleanupEvidence(manifest, {
            subject: { kind: "workspace", id: "worktree" },
            status: "proven",
            method: "workspace-remove",
            detail: "Recorded attempt worktree removed",
          });
        } catch (error) {
          const cleanupError = `Workspace cleanup failed: ${errorMessage(error)}`;
          await this.appendCleanupEvidence(manifest, {
            subject: { kind: "workspace", id: "worktree" },
            status: "failed",
            method: "workspace-remove",
            detail: cleanupError,
          });
        }
      }
    }

    return manifest;
  }

  private async writeVerification(
    manifest: AttemptManifest,
    record: VerificationRecord,
  ): Promise<void> {
    const updated = verificationRecordSchema.parse({
      ...record,
      updatedAt: new Date().toISOString(),
    });
    await this.store.writeJsonAtomic(manifest.artifacts.verification, updated);
  }

  private async registerExternalResource(
    manifest: AttemptManifest,
    resource: ExternalResource,
    maximum: number,
  ): Promise<AttemptManifest> {
    const knownIds = new Set(
      manifest.externalResources.map((entry) => entry.resourceId),
    );
    if (!knownIds.has(resource.resourceId) && knownIds.size >= maximum) {
      throw new ResourceLimitError(
        `external resources exceed the frozen maximum of ${maximum}`,
      );
    }
    await this.registerCleanupRequirement(manifest, {
      kind: "external-resource",
      id: resource.resourceId,
    });
    const existing = manifest.externalResources.filter(
      (entry) => entry.resourceId !== resource.resourceId,
    );
    return this.update(manifest, {
      externalResources: [...existing, resource],
    });
  }

  private async releaseExternalResource(
    manifest: AttemptManifest,
    resourceId: string,
    cleanup: ProcessExecutionResult,
  ): Promise<AttemptManifest> {
    await this.appendCleanupEvidence(manifest, {
      subject: { kind: "external-resource", id: resourceId },
      status: cleanup.termination.status,
      method: "external-resource-command",
      detail: `External resource cleanup exited ${cleanup.exitCode}`,
      termination: cleanup.termination,
    });
    if (isAttemptTerminal(manifest.status)) return manifest;
    return this.update(manifest, {
      externalResources: manifest.externalResources.map((entry) =>
        entry.resourceId === resourceId
          ? {
              ...entry,
              status: "released" as const,
              releasedAt: new Date().toISOString(),
            }
          : entry,
      ),
    });
  }

  private async registerCleanupRequirement(
    manifest: AttemptManifest,
    subject: CleanupSubject,
    guardian?: CleanupRequirement["guardian"],
  ): Promise<AttemptCleanupRecord> {
    return this.store.registerAttemptCleanupRequirement(
      manifest.jobId,
      manifest.attemptId,
      {
        subject,
        deadlineMs: subject.kind === "process-tree" ? 5_000 : 30_000,
        guardian,
      },
    );
  }

  private async registerProcessCleanup(
    manifest: AttemptManifest,
    operationId: string,
    guardian: NonNullable<CleanupRequirement["guardian"]>,
  ): Promise<void> {
    await this.registerCleanupRequirement(
      manifest,
      { kind: "process-tree", id: operationId },
      guardian,
    );
  }

  private async recordProcessCleanup(
    manifest: AttemptManifest,
    operationId: string,
    result: ProcessResult,
  ): Promise<void> {
    await this.appendCleanupEvidence(manifest, {
      subject: { kind: "process-tree", id: operationId },
      status: result.termination.status,
      method: "process-runner",
      detail:
        result.termination.detail ??
        `Process cleanup reported ${result.termination.status}`,
      termination: result.termination,
    });
  }

  private async appendCleanupEvidence(
    manifest: AttemptManifest,
    input: Omit<CleanupEvidence, "schema" | "evidenceId" | "observedAt">,
  ): Promise<AttemptCleanupRecord> {
    return this.store.appendAttemptCleanupEvidence(
      manifest.jobId,
      manifest.attemptId,
      {
        schema: "conductor.cleanup-evidence/v1",
        evidenceId: randomUUID(),
        observedAt: new Date().toISOString(),
        ...input,
        detail: input.detail?.slice(0, 4_000),
      },
    );
  }

  private async cleanupExternalResources(
    initialManifest: AttemptManifest,
  ): Promise<{ manifest: AttemptManifest; safe: boolean }> {
    let manifest = initialManifest;
    const contract = await this.store.readJob(manifest.jobId);
    for (const resource of manifest.externalResources) {
      if (resource.status !== "active") continue;
      const existingCleanup = await this.getAttemptCleanup(manifest.attemptId);
      if (
        latestCleanupEvidence(existingCleanup, {
          kind: "external-resource",
          id: resource.resourceId,
        })?.status === "proven"
      ) {
        continue;
      }
      await this.registerCleanupRequirement(manifest, {
        kind: "external-resource",
        id: resource.resourceId,
      });
      const prefix = path.join(
        path.dirname(manifest.artifacts.manifest),
        `recovery-${resource.resourceId}`,
      );
      try {
        const cleanupInvocation = reconstructExternalCleanup(
          contract,
          manifest,
          resource,
        );
        const result = await runProcess(cleanupInvocation, {
          stdoutPath: `${prefix}.stdout.log`,
          stderrPath: `${prefix}.stderr.log`,
          timeoutMs: contract.resources.cleanupTimeoutMs,
          maxStdoutBytes: contract.resources.maxLogBytes,
          maxStderrBytes: contract.resources.maxLogBytes,
          onGuardianReady: (identity) =>
            this.registerProcessCleanup(
              manifest,
              `external-resource-cleanup:${resource.resourceId}`,
              identity,
            ),
        });
        await this.recordProcessCleanup(
          manifest,
          `external-resource-cleanup:${resource.resourceId}`,
          result,
        );
        const stderr = await readFile(`${prefix}.stderr.log`, "utf8");
        if (
          result.outputLimit ||
          result.termination.status !== "proven" ||
          (result.exitCode !== 0 && !/No such container/i.test(stderr))
        ) {
          await this.appendCleanupEvidence(manifest, {
            subject: {
              kind: "external-resource",
              id: resource.resourceId,
            },
            status:
              result.termination.status === "proven" ? "failed" : "unknown",
            method: "external-resource-command",
            detail: `External resource cleanup exited ${result.exitCode}`,
            termination: result.termination,
          });
          return { manifest, safe: false };
        }
        manifest = await this.releaseExternalResource(
          manifest,
          resource.resourceId,
          result,
        );
      } catch (error) {
        await this.appendCleanupEvidence(manifest, {
          subject: { kind: "external-resource", id: resource.resourceId },
          status: "failed",
          method: "external-resource-command",
          detail: errorMessage(error),
        });
        return { manifest, safe: false };
      }
    }
    return { manifest, safe: true };
  }

  private async assertWorkspaceRemovalSafe(
    manifest: AttemptManifest,
  ): Promise<void> {
    const cleanup = await this.getAttemptCleanup(manifest.attemptId);
    const unresolved = cleanup.requirements.filter(
      (requirement) =>
        requirement.subject.kind !== "workspace" &&
        latestCleanupEvidence(cleanup, requirement.subject)?.status !==
          "proven",
    );
    if (unresolved.length === 0) return;
    throw new Error(
      `Attempt ${manifest.attemptId} has unresolved cleanup for ${unresolved
        .map(
          (requirement) =>
            `${requirement.subject.kind}:${requirement.subject.id}`,
        )
        .join(", ")}; workspace removal is prohibited`,
    );
  }

  private async update(
    manifest: AttemptManifest,
    patch: Partial<AttemptManifest>,
  ): Promise<AttemptManifest> {
    return this.store.transitionAttempt(manifest, patch);
  }

  private async summarize(
    manifest: AttemptManifest,
    idempotentReplay: boolean,
  ): Promise<RunJobResult> {
    let cleanup: AttemptCleanupRecord | undefined;
    try {
      cleanup = await this.store.readAttemptCleanup(
        manifest.jobId,
        manifest.attemptId,
      );
    } catch {
      // Legacy or damaged cleanup evidence is surfaced as unknown. The
      // reconciliation report retains the read failure details.
    }
    const workspaceRemoved =
      cleanup &&
      latestCleanupEvidence(cleanup, {
        kind: "workspace",
        id: "worktree",
      })?.status === "proven";
    return {
      jobId: manifest.jobId,
      attemptId: manifest.attemptId,
      status: manifest.status,
      idempotentReplay,
      workspacePath: manifest.workspace?.path,
      workspaceRetained: workspaceRemoved
        ? false
        : manifest.workspace?.retained,
      artifacts: manifest.artifacts,
      failure: manifest.failure,
      verificationStatus: manifest.verificationStatus,
      cleanupStatus: cleanup?.status ?? "unknown",
    };
  }
}

class TerminalAttempt extends Error {
  constructor(readonly manifest: AttemptManifest) {
    super(`Attempt reached terminal state: ${manifest.attemptId}`);
  }
}

class ResourceLimitError extends Error {
  constructor(message: string) {
    super(`Resource budget exceeded: ${message}`);
    this.name = "ResourceLimitError";
  }
}

class ResourceBudgetMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private sampling = false;
  private failure?: ResourceLimitError;

  constructor(
    private readonly workspacePath: string,
    private readonly artifactDirectory: string,
    private readonly contract: JobContract,
    private readonly controller: AbortController,
    private readonly diskFreeProbe: DiskFreeProbe,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sample(), 250);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async assertWithinBudget(): Promise<void> {
    while (this.sampling) await delay(5);
    await this.sample();
    if (this.failure) throw this.failure;
  }

  private async sample(): Promise<void> {
    if (this.sampling || this.failure) return;
    this.sampling = true;
    try {
      const [worktreeBytes, artifactBytes, freeBytes] = await Promise.all([
        boundedDirectorySize(
          this.workspacePath,
          this.contract.resources.maxWorktreeBytes,
        ),
        boundedDirectorySize(
          this.artifactDirectory,
          this.contract.resources.maxArtifactBytes,
        ),
        this.diskFreeProbe(this.workspacePath),
      ]);
      if (worktreeBytes > this.contract.resources.maxWorktreeBytes) {
        throw new ResourceLimitError(
          `worktree exceeded ${this.contract.resources.maxWorktreeBytes} bytes`,
        );
      }
      if (artifactBytes > this.contract.resources.maxArtifactBytes) {
        throw new ResourceLimitError(
          `attempt artifacts exceeded ${this.contract.resources.maxArtifactBytes} bytes`,
        );
      }
      if (freeBytes < this.contract.resources.minimumFreeDiskBytes) {
        throw new ResourceLimitError(
          `free disk fell below ${this.contract.resources.minimumFreeDiskBytes} bytes`,
        );
      }
    } catch (error) {
      this.failure =
        error instanceof ResourceLimitError
          ? error
          : new ResourceLimitError(
              `resource monitor failed: ${errorMessage(error)}`,
            );
      this.controller.abort(this.failure);
    } finally {
      this.sampling = false;
    }
  }
}

async function boundedDirectorySize(
  root: string,
  maximum: number,
): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0 && total <= maximum) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) {
        try {
          total += (await stat(target)).size;
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )) {
            throw error;
          }
        }
      }
      if (total > maximum) return total;
    }
  }
  return total;
}

interface ProposalCapture {
  patch: string;
  changedPaths: string[];
}

async function captureProposal(
  workspace: GitWorkspace,
  manifest: AttemptManifest,
  contract: JobContract,
): Promise<ProposalCapture> {
  await captureGit(
    workspace.path,
    ["add", "--intent-to-add", "--all"],
    contract,
  );
  const [patch, status, names] = await Promise.all([
    captureGit(
      workspace.path,
      ["diff", "--binary", "--full-index", workspace.baseRevision, "--"],
      contract,
      contract.resources.maxPatchBytes,
    ),
    captureGit(
      workspace.path,
      ["status", "--porcelain=v2", "--untracked-files=all"],
      contract,
    ),
    captureGit(
      workspace.path,
      ["diff", "--name-only", "-z", workspace.baseRevision, "--"],
      contract,
    ),
  ]);
  const changedPaths = names.split("\0").filter(Boolean).sort();
  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (patchBytes > contract.resources.maxPatchBytes) {
    throw new ResourceLimitError(
      `proposal patch is ${patchBytes} bytes; maximum is ${contract.resources.maxPatchBytes}`,
    );
  }
  if (changedPaths.length > contract.resources.maxChangedPaths) {
    throw new ResourceLimitError(
      `proposal changes ${changedPaths.length} paths; maximum is ${contract.resources.maxChangedPaths}`,
    );
  }
  await Promise.all([
    writeFile(manifest.artifacts.proposalPatch, patch, "utf8"),
    writeFile(manifest.artifacts.repositoryStatus, status, "utf8"),
    writeFile(
      manifest.artifacts.changedPaths,
      `${JSON.stringify(changedPaths, null, 2)}\n`,
      "utf8",
    ),
  ]);
  return { patch, changedPaths };
}

async function captureCurrentPatch(
  workspace: GitWorkspace,
  contract: JobContract,
): Promise<string> {
  await captureGit(
    workspace.path,
    ["add", "--intent-to-add", "--all"],
    contract,
  );
  const patch = await captureGit(
    workspace.path,
    ["diff", "--binary", "--full-index", workspace.baseRevision, "--"],
    contract,
    contract.resources.maxPatchBytes,
  );
  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (patchBytes > contract.resources.maxPatchBytes) {
    throw new ResourceLimitError(
      `verified patch is ${patchBytes} bytes; maximum is ${contract.resources.maxPatchBytes}`,
    );
  }
  return patch;
}

async function runCommandSequence(input: {
  commands: ReturnType<typeof freezeJobRequest>["setupCommands"];
  phase: "setup" | "acceptance";
  workspacePath: string;
  artifactDirectory: string;
  defaultTimeoutMs: number;
  deadlineAt: number;
  maxLogBytes: number;
  cleanupTimeoutMs: number;
  policy: ExecutionPolicy;
  signal: AbortSignal;
  onGuardianReady?: (
    operationId: string,
    identity: ProcessGuardianIdentity,
  ) => void | Promise<void>;
  onProcessResult?: (
    operationId: string,
    result: ProcessResult,
  ) => void | Promise<void>;
  onExternalResource?: (resource: ExternalResource) => void | Promise<void>;
  onExternalResourceReleased?: (
    resourceId: string,
    cleanup: ProcessExecutionResult,
  ) => void | Promise<void>;
  executionBoundary: JobContract["execution"]["boundary"];
  attemptId: string;
}): Promise<CommandEvidence[]> {
  const evidence: CommandEvidence[] = [];
  for (const [index, command] of input.commands.entries()) {
    const operationId = `${input.phase}-${String(index + 1).padStart(2, "0")}`;
    const result = await executeCommand({
      command,
      phase: input.phase,
      index,
      workspacePath: input.workspacePath,
      artifactDirectory: input.artifactDirectory,
      defaultTimeoutMs: input.defaultTimeoutMs,
      maximumTimeoutMs: remainingTimeout(input.deadlineAt),
      maxLogBytes: input.maxLogBytes,
      cleanupTimeoutMs: input.cleanupTimeoutMs,
      policy: input.policy,
      signal: input.signal,
      onGuardianReady: (identity) =>
        input.onGuardianReady?.(operationId, identity),
      onProcessResult: (processResult) =>
        input.onProcessResult?.(operationId, processResult),
      executionBoundary: input.executionBoundary,
      attemptId: input.attemptId,
      onExternalResource: input.onExternalResource,
      onExternalResourceReleased: input.onExternalResourceReleased,
    });
    evidence.push(result);
    if (result.process?.outputLimit) {
      throw new ResourceLimitError(
        `${operationId} ${result.process.outputLimit.stream} exceeded ${result.process.outputLimit.limitBytes} bytes`,
      );
    }
    if (result.status !== "passed") break;
  }
  return evidence;
}

function phaseStatus(
  commands: CommandEvidence[],
): "passed" | "failed" | "cancelled" | "policy-denied" {
  if (commands.some((command) => command.status === "cancelled"))
    return "cancelled";
  if (commands.some((command) => command.status === "policy-denied")) {
    return "policy-denied";
  }
  return commands.every((command) => command.status === "passed")
    ? "passed"
    : "failed";
}

function captureGit(
  cwd: string,
  args: string[],
  contract: JobContract,
  maxOutputBytes = contract.resources.maxLogBytes,
): Promise<string> {
  return runBoundedGit(cwd, args, {
    timeoutMs: contract.resources.gitTimeoutMs,
    maxOutputBytes,
    trim: false,
  }).catch((error: unknown) => {
    if (errorMessage(error).includes("output exceeded")) {
      throw new ResourceLimitError(errorMessage(error));
    }
    throw error;
  });
}

function classifyFailure(
  error: unknown,
  status: AttemptManifest["status"],
  cancelled: boolean,
): AttemptManifest["failure"] {
  if (error instanceof ResourceLimitError) {
    return { kind: "resource-limit", message: error.message };
  }
  if (cancelled)
    return { kind: "cancelled", message: "Attempt cancelled by Conductor" };
  if (status === "preparing")
    return { kind: "workspace-failed", message: errorMessage(error) };
  if (status === "running")
    return { kind: "spawn-failed", message: errorMessage(error) };
  return { kind: "orchestrator-error", message: errorMessage(error) };
}

function remainingTimeout(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("Total attempt deadline expired");
  return remaining;
}

function reconstructExternalCleanup(
  contract: JobContract,
  manifest: AttemptManifest,
  resource: ExternalResource,
): { executable: string; args: string[]; cwd: string } {
  const boundary = contract.execution.boundary;
  if (boundary.kind !== "external-sandbox") {
    throw new Error(
      `External resource ${resource.resourceId} has no frozen sandbox owner profile`,
    );
  }
  if (
    resource.driver !== boundary.driver ||
    resource.profileId !== boundary.profileId ||
    resource.profileFingerprint !== boundary.profileFingerprint ||
    resource.image !== boundary.image
  ) {
    throw new Error(
      `External resource ${resource.resourceId} does not match its frozen owner profile`,
    );
  }
  return {
    executable: boundary.dockerExecutable,
    args: ["rm", "--force", resource.resourceId],
    cwd: path.dirname(manifest.artifacts.manifest),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function isAttemptTerminal(status: AttemptManifest["status"]): boolean {
  return ["completed", "failed", "needs-input", "cancelled"].includes(status);
}

function assertProcessCleanupProven(
  operationId: string,
  result: ProcessResult,
): void {
  if (result.termination.status !== "proven") {
    throw new Error(
      `Process cleanup for ${operationId} is ${result.termination.status}; continuing could race a surviving descendant`,
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertDiskHeadroom(
  target: string,
  minimumFreeBytes: number,
  probe: DiskFreeProbe,
): Promise<void> {
  const freeBytes = await probe(target);
  if (freeBytes < minimumFreeBytes) {
    throw new Error(
      `Insufficient free disk for a new attempt: ${freeBytes} bytes available, ${minimumFreeBytes} required by owner profile`,
    );
  }
}

async function availableDiskBytes(target: string): Promise<number> {
  let existing = target;
  try {
    await stat(existing);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
    existing = path.dirname(existing);
  }
  const filesystem = await statfs(existing);
  return filesystem.bavail * filesystem.bsize;
}
