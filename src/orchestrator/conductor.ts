import { spawn } from "node:child_process";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  proposalLineageSchema,
  type AttemptManifest,
  type ExternalResource,
  type ProposalContribution,
  type ProposalLineage,
} from "../contracts/attempt.js";
import {
  fingerprint,
  freezeJobRequest,
  jobRequestSchema,
  type JobContract,
} from "../contracts/job.js";
import {
  isProcessAlive,
  runProcess,
  type ProcessGuardianIdentity,
} from "../runtime/process-runner.js";
import { selectParentEnvironment } from "../runtime/environment.js";
import { SandboxProfiles, validateSandboxCommand } from "../sandbox/docker.js";
import {
  buildReviewPacket,
  reviewPacketSchema,
  sha256File,
  type ReviewPacket,
} from "../review/packet.js";
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
}

export type AttemptArtifactName = keyof AttemptManifest["artifacts"];

export class ProposalLineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalLineageError";
  }
}

export class Conductor {
  private readonly activeAttempts = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<AttemptManifest>>();

  constructor(
    readonly store: ArtifactStore,
    readonly workspaces: GitWorkspaceManager,
    readonly workers: WorkerRegistry,
    readonly executionPolicy = new ExecutionPolicy(),
    readonly sandboxProfiles = new SandboxProfiles(),
  ) {}

  async prepareJob(input: unknown): Promise<JobContract> {
    const request = jobRequestSchema.parse(input);
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
    );
    const candidate = freezeJobRequest(request, {
      repositoryRoot: repository.root,
      baseRevision: repository.revision,
      sandboxBinding,
    });
    const reservation = await this.store.reserveJob(candidate);
    return reservation.contract;
  }

  async submitJob(input: unknown): Promise<RunJobResult> {
    const contract = await this.prepareJob(input);
    const attemptReservation = await this.store.reserveInitialAttempt(contract);
    if (!attemptReservation.created) {
      return summarize(attemptReservation.manifest, true);
    }
    this.launchAttempt(contract, attemptReservation.manifest);
    return summarize(attemptReservation.manifest, false);
  }

  async startPreparedJob(jobId: string): Promise<RunJobResult> {
    const reserved = await this.reservePreparedAttempt(jobId);
    return this.startReservedAttempt(reserved.attemptId);
  }

  async reservePreparedAttempt(
    jobId: string,
    parentAttemptIds: string[] = [],
  ): Promise<RunJobResult> {
    const contract = await this.store.readJob(jobId);
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
    );
    return summarize(attemptReservation.manifest, false);
  }

  async startReservedAttempt(attemptId: string): Promise<RunJobResult> {
    const manifest = await this.getAttempt(attemptId);
    if (manifest.status !== "reserved") {
      throw new Error(
        `Attempt ${attemptId} cannot start from status ${manifest.status}`,
      );
    }
    if (this.executions.has(attemptId)) {
      throw new Error(`Attempt ${attemptId} is already executing`);
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
    this.launchAttempt(contract, manifest);
    return summarize(manifest, false);
  }

  async runJob(input: unknown): Promise<RunJobResult> {
    const submitted = await this.submitJob(input);
    if (submitted.idempotentReplay) return submitted;
    return this.waitForAttempt(submitted.attemptId);
  }

  async waitForAttempt(attemptId: string): Promise<RunJobResult> {
    const execution = this.executions.get(attemptId);
    const manifest = execution
      ? await execution
      : await this.getAttempt(attemptId);
    return summarize(manifest, false);
  }

  async getAttempt(attemptId: string): Promise<AttemptManifest> {
    return this.store.findAttempt(attemptId);
  }

  async getVerification(attemptId: string): Promise<VerificationRecord> {
    const manifest = await this.getAttempt(attemptId);
    return verificationRecordSchema.parse(
      JSON.parse(await readFile(manifest.artifacts.verification, "utf8")),
    );
  }

  async getReviewPacket(attemptId: string): Promise<ReviewPacket> {
    const manifest = await this.getAttempt(attemptId);
    if (
      !["completed", "failed", "needs-input", "cancelled"].includes(
        manifest.status,
      )
    ) {
      throw new Error(`Attempt ${attemptId} is not terminal`);
    }
    const contract = await this.store.readJob(manifest.jobId);
    if (manifest.lineage?.status === "composed") {
      await this.validateProposalLineage(contract, manifest.lineage);
    }
    const target = path.join(
      path.dirname(manifest.artifacts.manifest),
      "review-packet.json",
    );
    try {
      return reviewPacketSchema.parse(
        JSON.parse(await readFile(target, "utf8")),
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }

    const verification = await this.getVerification(attemptId);
    const changedPaths = JSON.parse(
      await readFile(manifest.artifacts.changedPaths, "utf8"),
    ) as unknown;
    if (
      !Array.isArray(changedPaths) ||
      !changedPaths.every((entry) => typeof entry === "string")
    ) {
      throw new Error(`Invalid changed-path evidence for ${attemptId}`);
    }
    const packet = await buildReviewPacket({
      contract,
      manifest,
      verification,
      changedPaths,
    });
    await this.store.writeJsonAtomic(target, packet);
    return packet;
  }

  async getReviewBundle(attemptId: string, maxPatchBytes = 500_000) {
    const packet = await this.getReviewPacket(attemptId);
    const patchBinding = packet.bindings.find(
      (binding) => binding.name === "proposalPatch",
    );
    if (
      !patchBinding?.available ||
      !patchBinding.sha256 ||
      (await sha256File(patchBinding.path)) !== patchBinding.sha256
    ) {
      throw new Error(`Proposal patch evidence changed for ${attemptId}`);
    }
    const patch = await this.readAttemptArtifact(
      attemptId,
      "proposalPatch",
      maxPatchBytes,
    );
    return { packet, patch };
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
    if (manifest.status !== "reserved") return manifest;
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
    if (manifest.status === "reserved") {
      manifest = await this.update(manifest, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        verificationStatus: "ineligible",
        failure: {
          kind: "orphaned",
          message:
            "Reserved attempt lost dispatcher ownership before execution",
        },
      });
      return { disposition: "safe-to-retry", manifest };
    }
    if (!manifest.guardian) {
      return { disposition: "unknown", manifest };
    }
    if (isProcessAlive(manifest.guardian.guardianPid)) {
      await delay(guardianExitGraceMs);
      manifest = await this.getAttempt(attemptId);
      if (manifest.guardian && isProcessAlive(manifest.guardian.guardianPid)) {
        return { disposition: "still-running", manifest };
      }
    }
    const cleanup = await this.cleanupExternalResources(manifest);
    manifest = cleanup.manifest;
    if (!cleanup.safe) {
      return { disposition: "unknown", manifest };
    }
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
    return cleanup.manifest;
  }

  async removeAttemptWorkspace(attemptId: string): Promise<AttemptManifest> {
    let manifest = await this.getAttempt(attemptId);
    if (
      ["reserved", "preparing", "running", "verifying"].includes(
        manifest.status,
      )
    ) {
      throw new Error(
        `Cannot remove workspace for active attempt ${attemptId}`,
      );
    }
    manifest = await this.releaseAttemptExternalResources(attemptId);
    if (!manifest.workspace || !manifest.workspace.retained) return manifest;

    const contract = await this.store.readJob(manifest.jobId);
    await this.workspaces.remove({
      path: manifest.workspace.path,
      repositoryRoot: contract.repository.root,
      baseRevision: manifest.workspace.baseRevision,
    });
    return this.update(manifest, {
      workspace: { ...manifest.workspace, retained: false },
    });
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
    let manifest = initialManifest;
    let workspace: GitWorkspace | undefined;
    let verification = createVerificationRecord({
      jobId: contract.jobId,
      attemptId: initialManifest.attemptId,
      hasSetup: contract.setupCommands.length > 0,
      hasAcceptance: contract.acceptanceCommands.length > 0,
    });

    try {
      manifest = await this.update(manifest, { status: "preparing" });
      workspace = await this.workspaces.create({
        repositoryRoot: contract.repository.root,
        baseRevision: contract.repository.baseRevision,
        attemptId: manifest.attemptId,
      });
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
          policy: this.executionPolicy,
          signal: abortController.signal,
          executionBoundary: contract.execution.boundary,
          attemptId: manifest.attemptId,
          onGuardianReady: async (identity) => {
            manifest = await this.update(manifest, { guardian: identity });
          },
          onExternalResource: async (resource) => {
            manifest = await this.registerExternalResource(manifest, resource);
          },
          onExternalResourceReleased: async (resourceId) => {
            manifest = await this.releaseExternalResource(manifest, resourceId);
          },
        });
        const repositoryClean =
          (await captureGit(workspace.path, [
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
          ])) === "";
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
          const cancelled = verification.setup.status === "cancelled";
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
              kind: cancelled ? "cancelled" : "setup-failed",
              message: repositoryClean
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
      manifest = await this.update(manifest, {
        status: "running",
        invocation: {
          executable: invocation.executable,
          args: invocation.args,
          cwd: invocation.cwd,
          environmentKeys: Object.keys(invocation.env ?? {}).sort(),
        },
      });

      const processResult = await runProcess(invocation, {
        stdoutPath: manifest.artifacts.stdout,
        stderrPath: manifest.artifacts.stderr,
        timeoutMs: contract.execution.timeoutMs,
        signal: abortController.signal,
        onGuardianReady: async (identity) => {
          manifest = await this.update(manifest, { guardian: identity });
        },
        onSpawn: async (workerPid) => {
          if (!manifest.guardian) return;
          manifest = await this.update(manifest, {
            guardian: { ...manifest.guardian, workerPid },
          });
        },
      });
      let proposal: ProposalCapture;
      try {
        proposal = await captureProposal(workspace, manifest);
      } catch (error) {
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
            kind: "proposal-capture-failed",
            message: errorMessage(error),
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
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          process: processResult,
          verificationStatus: "ineligible",
          failure: {
            kind: "cancelled",
            message: "Attempt cancelled by Conductor",
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
            policy: this.executionPolicy,
            signal: abortController.signal,
            executionBoundary: contract.execution.boundary,
            attemptId: manifest.attemptId,
            onGuardianReady: async (identity) => {
              manifest = await this.update(manifest, { guardian: identity });
            },
            onExternalResource: async (resource) => {
              manifest = await this.registerExternalResource(
                manifest,
                resource,
              );
            },
            onExternalResourceReleased: async (resourceId) => {
              manifest = await this.releaseExternalResource(
                manifest,
                resourceId,
              );
            },
          });
          const finalPatch = await captureCurrentPatch(workspace);
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
              verification.acceptance.status === "passed" && proposalStable,
          };
        } else {
          verification = {
            ...verification,
            acceptance: {
              status: "not-configured",
              commands: [],
              proposalStable: true,
            },
            eligibleForReview: true,
          };
        }
        await this.writeVerification(manifest, verification);
        const verificationCancelled =
          verification.acceptance.status === "cancelled";
        manifest = await this.update(manifest, {
          status: verificationCancelled ? "cancelled" : "completed",
          finishedAt: new Date().toISOString(),
          process: processResult,
          verificationStatus: verification.eligibleForReview
            ? "eligible"
            : "ineligible",
          failure: verificationCancelled
            ? {
                kind: "cancelled",
                message: "Attempt cancelled during deterministic verification",
              }
            : undefined,
        });
      }
    } catch (error) {
      if (error instanceof TerminalAttempt) {
        manifest = error.manifest;
      } else {
        manifest = await this.update(manifest, {
          status: abortController.signal.aborted ? "cancelled" : "failed",
          finishedAt: new Date().toISOString(),
          failure: classifyFailure(
            error,
            manifest.status,
            abortController.signal.aborted,
          ),
          verificationStatus: "ineligible",
        });
      }
    } finally {
      if (workspace && !contract.execution.retainWorkspace) {
        try {
          const externalCleanup = await this.cleanupExternalResources(manifest);
          manifest = externalCleanup.manifest;
          if (!externalCleanup.safe) {
            throw new Error(
              "External resource cleanup failed; its worktree must remain available",
            );
          }
          await this.workspaces.remove(workspace);
          manifest = await this.update(manifest, {
            workspace: { ...manifest.workspace!, retained: false },
          });
        } catch (error) {
          const cleanupError = `Workspace cleanup failed: ${errorMessage(error)}`;
          manifest = await this.update(manifest, {
            cleanupError,
            ...(manifest.failure
              ? {}
              : {
                  status: "failed" as const,
                  failure: {
                    kind: "orchestrator-error" as const,
                    message: cleanupError,
                  },
                }),
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
  ): Promise<AttemptManifest> {
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
  ): Promise<AttemptManifest> {
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

  private async cleanupExternalResources(
    initialManifest: AttemptManifest,
  ): Promise<{ manifest: AttemptManifest; safe: boolean }> {
    let manifest = initialManifest;
    for (const resource of manifest.externalResources) {
      if (resource.status !== "active") continue;
      const prefix = path.join(
        path.dirname(manifest.artifacts.manifest),
        `recovery-${resource.resourceId}`,
      );
      try {
        const result = await runProcess(
          {
            executable: resource.cleanup.executable,
            args: resource.cleanup.args,
            cwd: resource.cleanup.cwd,
          },
          {
            stdoutPath: `${prefix}.stdout.log`,
            stderrPath: `${prefix}.stderr.log`,
            timeoutMs: 30_000,
          },
        );
        const stderr = await readFile(`${prefix}.stderr.log`, "utf8");
        if (result.exitCode !== 0 && !/No such container/i.test(stderr)) {
          return { manifest, safe: false };
        }
        manifest = await this.releaseExternalResource(
          manifest,
          resource.resourceId,
        );
      } catch {
        return { manifest, safe: false };
      }
    }
    return { manifest, safe: true };
  }

  private async update(
    manifest: AttemptManifest,
    patch: Partial<AttemptManifest>,
  ): Promise<AttemptManifest> {
    const updated = { ...manifest, ...patch };
    await this.store.writeAttempt(updated);
    return updated;
  }
}

class TerminalAttempt extends Error {
  constructor(readonly manifest: AttemptManifest) {
    super(`Attempt reached terminal state: ${manifest.attemptId}`);
  }
}

function summarize(
  manifest: AttemptManifest,
  idempotentReplay: boolean,
): RunJobResult {
  return {
    jobId: manifest.jobId,
    attemptId: manifest.attemptId,
    status: manifest.status,
    idempotentReplay,
    workspacePath: manifest.workspace?.path,
    workspaceRetained: manifest.workspace?.retained,
    artifacts: manifest.artifacts,
    failure: manifest.failure,
    verificationStatus: manifest.verificationStatus,
  };
}

interface ProposalCapture {
  patch: string;
  changedPaths: string[];
}

async function captureProposal(
  workspace: GitWorkspace,
  manifest: AttemptManifest,
): Promise<ProposalCapture> {
  await captureGit(workspace.path, ["add", "--intent-to-add", "--all"]);
  const [patch, status, names] = await Promise.all([
    captureGit(workspace.path, [
      "diff",
      "--binary",
      "--full-index",
      workspace.baseRevision,
      "--",
    ]),
    captureGit(workspace.path, [
      "status",
      "--porcelain=v2",
      "--untracked-files=all",
    ]),
    captureGit(workspace.path, [
      "diff",
      "--name-only",
      "-z",
      workspace.baseRevision,
      "--",
    ]),
  ]);
  const changedPaths = names.split("\0").filter(Boolean).sort();
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

async function captureCurrentPatch(workspace: GitWorkspace): Promise<string> {
  await captureGit(workspace.path, ["add", "--intent-to-add", "--all"]);
  return captureGit(workspace.path, [
    "diff",
    "--binary",
    "--full-index",
    workspace.baseRevision,
    "--",
  ]);
}

async function runCommandSequence(input: {
  commands: ReturnType<typeof freezeJobRequest>["setupCommands"];
  phase: "setup" | "acceptance";
  workspacePath: string;
  artifactDirectory: string;
  defaultTimeoutMs: number;
  policy: ExecutionPolicy;
  signal: AbortSignal;
  onGuardianReady?: (identity: ProcessGuardianIdentity) => void | Promise<void>;
  onExternalResource?: (resource: ExternalResource) => void | Promise<void>;
  onExternalResourceReleased?: (resourceId: string) => void | Promise<void>;
  executionBoundary: JobContract["execution"]["boundary"];
  attemptId: string;
}): Promise<CommandEvidence[]> {
  const evidence: CommandEvidence[] = [];
  for (const [index, command] of input.commands.entries()) {
    const result = await executeCommand({
      command,
      phase: input.phase,
      index,
      workspacePath: input.workspacePath,
      artifactDirectory: input.artifactDirectory,
      defaultTimeoutMs: input.defaultTimeoutMs,
      policy: input.policy,
      signal: input.signal,
      onGuardianReady: input.onGuardianReady,
      executionBoundary: input.executionBoundary,
      attemptId: input.attemptId,
      onExternalResource: input.onExternalResource,
      onExternalResourceReleased: input.onExternalResourceReleased,
    });
    evidence.push(result);
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

function captureGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
      env: selectParentEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`git ${args[0] ?? ""} failed (${code}): ${stderr.trim()}`),
        );
    });
  });
}

function classifyFailure(
  error: unknown,
  status: AttemptManifest["status"],
  cancelled: boolean,
): AttemptManifest["failure"] {
  if (cancelled)
    return { kind: "cancelled", message: "Attempt cancelled by Conductor" };
  if (status === "preparing")
    return { kind: "workspace-failed", message: errorMessage(error) };
  if (status === "running")
    return { kind: "spawn-failed", message: errorMessage(error) };
  return { kind: "orchestrator-error", message: errorMessage(error) };
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
