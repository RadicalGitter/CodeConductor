import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

import type { AttemptManifest } from "../contracts/attempt.js";
import { freezeJobRequest, jobRequestSchema } from "../contracts/job.js";
import { runProcess } from "../runtime/process-runner.js";
import { ArtifactStore } from "../storage/artifact-store.js";
import {
  GitWorkspaceManager,
  type GitWorkspace,
} from "../workspaces/git-workspace.js";
import { WorkerRegistry } from "../workers/adapter.js";

export interface RunJobResult {
  jobId: string;
  attemptId: string;
  status: AttemptManifest["status"];
  idempotentReplay: boolean;
  workspacePath?: string;
  artifacts: AttemptManifest["artifacts"];
  failure?: AttemptManifest["failure"];
}

export class Conductor {
  private readonly activeAttempts = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<AttemptManifest>>();

  constructor(
    readonly store: ArtifactStore,
    readonly workspaces: GitWorkspaceManager,
    readonly workers: WorkerRegistry,
  ) {}

  async submitJob(input: unknown): Promise<RunJobResult> {
    const request = jobRequestSchema.parse(input);
    this.workers.get(request.adapterId);
    const repository = await this.workspaces.inspectRepository(
      request.repositoryPath,
      request.baseRef,
    );
    const candidate = freezeJobRequest(request, {
      repositoryRoot: repository.root,
      baseRevision: repository.revision,
    });
    const reservation = await this.store.reserveJob(candidate);
    const attemptReservation = await this.store.reserveInitialAttempt(
      reservation.contract,
    );
    if (!attemptReservation.created) {
      return summarize(attemptReservation.manifest, true);
    }
    const abortController = new AbortController();
    this.activeAttempts.set(
      attemptReservation.manifest.attemptId,
      abortController,
    );
    const execution = this.executeAttempt(
      reservation.contract,
      attemptReservation.manifest,
      abortController,
    ).finally(() => {
      this.activeAttempts.delete(attemptReservation.manifest.attemptId);
      this.executions.delete(attemptReservation.manifest.attemptId);
    });
    this.executions.set(attemptReservation.manifest.attemptId, execution);
    // Submission is intentionally fire-and-poll. Attach a rejection observer so
    // a catastrophic persistence failure cannot become an unhandled rejection;
    // explicit waiters still receive the original rejected promise.
    void execution.catch(() => undefined);
    return summarize(attemptReservation.manifest, false);
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

  cancelAttempt(attemptId: string): boolean {
    const controller = this.activeAttempts.get(attemptId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async removeAttemptWorkspace(attemptId: string): Promise<AttemptManifest> {
    const manifest = await this.getAttempt(attemptId);
    if (["reserved", "preparing", "running"].includes(manifest.status)) {
      throw new Error(
        `Cannot remove workspace for active attempt ${attemptId}`,
      );
    }
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

  private async executeAttempt(
    contract: ReturnType<typeof freezeJobRequest>,
    initialManifest: AttemptManifest,
    abortController: AbortController,
  ): Promise<AttemptManifest> {
    let manifest = initialManifest;
    let workspace: GitWorkspace | undefined;

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
      });

      const adapter = this.workers.get(contract.worker.adapterId);
      const invocation = adapter.buildInvocation(contract, workspace.path);
      manifest = await this.update(manifest, {
        status: "running",
        startedAt: new Date().toISOString(),
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
      });
      try {
        await captureProposal(workspace, manifest);
      } catch (error) {
        return this.update(manifest, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          process: processResult,
          failure: {
            kind: "proposal-capture-failed",
            message: errorMessage(error),
          },
        });
      }

      if (processResult.cancelled) {
        manifest = await this.update(manifest, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          process: processResult,
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
          failure: {
            kind: "worker-exit",
            message: `Worker exited with code ${processResult.exitCode}`,
          },
        });
      } else {
        manifest = await this.update(manifest, {
          status: "completed",
          finishedAt: new Date().toISOString(),
          process: processResult,
        });
      }
    } catch (error) {
      manifest = await this.update(manifest, {
        status: abortController.signal.aborted ? "cancelled" : "failed",
        finishedAt: new Date().toISOString(),
        failure: classifyFailure(
          error,
          manifest.status,
          abortController.signal.aborted,
        ),
      });
    } finally {
      if (workspace && !contract.execution.retainWorkspace) {
        try {
          await this.workspaces.remove(workspace);
          manifest = await this.update(manifest, {
            workspace: { ...manifest.workspace!, retained: false },
          });
        } catch (error) {
          if (!manifest.failure) {
            manifest = await this.update(manifest, {
              status: "failed",
              failure: {
                kind: "orchestrator-error",
                message: `Workspace cleanup failed: ${errorMessage(error)}`,
              },
            });
          }
        }
      }
    }

    return manifest;
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
    artifacts: manifest.artifacts,
    failure: manifest.failure,
  };
}

async function captureProposal(
  workspace: GitWorkspace,
  manifest: AttemptManifest,
): Promise<void> {
  await captureGit(workspace.path, ["add", "--intent-to-add", "--all"]);
  const [patch, status] = await Promise.all([
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
  ]);
  await Promise.all([
    writeFile(manifest.artifacts.proposalPatch, patch, "utf8"),
    writeFile(manifest.artifacts.repositoryStatus, status, "utf8"),
  ]);
}

function captureGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
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
