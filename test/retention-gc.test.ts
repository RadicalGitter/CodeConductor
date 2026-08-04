import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JobContract } from "../src/contracts/job.js";
import {
  DEFAULT_OWNER_RESOURCE_PROFILE,
  ownerResourceProfileSchema,
} from "../src/contracts/resources.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import { RetentionManager } from "../src/retention/gc.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository, runTestJob } from "./helpers.js";

test("GC is two-stage, evidence-bound, and preserves compact audit records", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-gc-"));
  const profile = ownerResourceProfileSchema.parse({
    ...structuredClone(DEFAULT_OWNER_RESOURCE_PROFILE),
    profileId: "gc-test",
    limits: {
      ...DEFAULT_OWNER_RESOURCE_PROFILE.limits,
      terminalRetentionMs: 60_000,
      gcProposalTtlMs: 60_000,
      minimumFreeDiskBytes: 0,
    },
  });
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new FailingAdapter(), new SuccessfulAdapter()]),
    undefined,
    undefined,
    profile,
  );
  const retention = new RetentionManager(conductor);

  try {
    const result = await runTestJob(conductor, {
      objective: "Create terminal evidence for retention testing",
      repositoryPath: repository.root,
      adapterId: "failing",
      idempotencyKey: "gc-two-stage",
      retainWorkspace: true,
    });
    expect(result.status).toBe("failed");
    const future = new Date(Date.now() + 120_000);

    const workspacePlan = await retention.dryRun(future);
    expect(workspacePlan.candidates).toHaveLength(1);
    expect(workspacePlan.candidates[0]?.kind).toBe("workspace");
    expect(await exists(result.workspacePath!)).toBe(true);

    const workspaceResult = await retention.apply(
      workspacePlan,
      approval(future),
      future,
    );
    expect(workspaceResult.removed[0]?.kind).toBe("workspace");
    expect(await exists(result.workspacePath!)).toBe(false);

    const artifactPlan = await retention.dryRun(
      new Date(future.getTime() + 1_000),
    );
    const artifactCandidate = artifactPlan.candidates.find(
      (candidate) => candidate.kind === "attempt-artifacts",
    );
    expect(artifactCandidate?.files.length).toBeGreaterThan(0);

    await appendFile(result.artifacts.stdout, "stale\n", "utf8");
    await expect(
      retention.apply(
        artifactPlan,
        approval(new Date(future.getTime() + 1_000)),
        new Date(future.getTime() + 1_000),
      ),
    ).rejects.toThrow("GC artifact binding changed");

    const freshPlan = await retention.dryRun(
      new Date(future.getTime() + 2_000),
    );
    const applied = await retention.apply(
      freshPlan,
      approval(new Date(future.getTime() + 2_000)),
      new Date(future.getTime() + 2_000),
    );
    expect(applied.removed[0]?.kind).toBe("attempt-artifacts");
    expect(await exists(result.artifacts.stdout)).toBe(false);
    expect(await exists(result.artifacts.manifest)).toBe(true);
    expect(await exists(result.artifacts.cleanup!)).toBe(true);
    expect(await exists(result.artifacts.verification)).toBe(true);

    const tombstone = JSON.parse(
      await readFile(
        path.join(
          store.attemptDirectory(result.jobId, result.attemptId),
          "gc-tombstone.json",
        ),
        "utf8",
      ),
    ) as { schema: string; removedFiles: unknown[] };
    expect(tombstone.schema).toBe("conductor.gc-tombstone/v1");
    expect(tombstone.removedFiles.length).toBeGreaterThan(0);
    expect(
      await exists(
        path.join(dataRoot, "gc", "actions", `${freshPlan.planId}.json`),
      ),
    ).toBe(true);
    expect((await retention.inspectActions()).completed).toContain(
      freshPlan.planId,
    );
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 30_000);

test("GC never proposes active or reviewable evidence", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-gc-safe-"));
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new FailingAdapter(), new SuccessfulAdapter()]),
  );
  try {
    const contract = await conductor.prepareJob({
      objective: "Remain active",
      repositoryPath: repository.root,
      adapterId: "failing",
      idempotencyKey: "gc-active",
    });
    await store.reserveAttempt(contract);
    await runTestJob(conductor, {
      objective: "Remain reviewable",
      repositoryPath: repository.root,
      adapterId: "successful",
      idempotencyKey: "gc-reviewable",
      retainWorkspace: false,
    });
    const plan = await new RetentionManager(conductor).dryRun(
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
    );
    expect(
      plan.observations.map((entry) => entry.retentionClass).sort(),
    ).toEqual(["active", "reviewable"]);
    expect(plan.candidates).toHaveLength(0);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 20_000);

test("cleanup failure is quarantined regardless of age", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-gc-quarantine-"),
  );
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new FailingAdapter()]),
  );
  let attemptId: string | undefined;
  try {
    const result = await runTestJob(conductor, {
      objective: "Quarantine failed cleanup evidence",
      repositoryPath: repository.root,
      adapterId: "failing",
      idempotencyKey: "gc-quarantine",
      retainWorkspace: true,
    });
    attemptId = result.attemptId;
    await store.registerAttemptCleanupRequirement(
      result.jobId,
      result.attemptId,
      {
        subject: { kind: "workspace", id: "worktree" },
        deadlineMs: 30_000,
      },
    );
    await store.appendAttemptCleanupEvidence(result.jobId, result.attemptId, {
      schema: "conductor.cleanup-evidence/v1",
      evidenceId: randomUUID(),
      subject: { kind: "workspace", id: "worktree" },
      status: "failed",
      method: "workspace-remove",
      observedAt: new Date().toISOString(),
      detail: "Injected cleanup failure",
    });
    const plan = await new RetentionManager(conductor).dryRun(
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
    );
    expect(plan.observations[0]?.retentionClass).toBe("quarantine");
    expect(plan.candidates).toHaveLength(0);
  } finally {
    if (attemptId) await conductor.removeAttemptWorkspace(attemptId);
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 20_000);

class FailingAdapter implements WorkerAdapter {
  readonly description = {
    id: "failing",
    label: "Failing fixture worker",
    executable: process.execPath,
    mutationMode: "worktree" as const,
    outputFormat: "text" as const,
    safetyMode: "test-fixture",
    available: true,
    modelIdentity: "not-applicable" as const,
  };

  buildInvocation(_contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: ["-e", "console.error('expected failure'); process.exit(7)"],
      cwd: workspacePath,
    };
  }
}

class SuccessfulAdapter implements WorkerAdapter {
  readonly description = {
    id: "successful",
    label: "Successful fixture worker",
    executable: process.execPath,
    mutationMode: "worktree" as const,
    outputFormat: "text" as const,
    safetyMode: "test-fixture",
    available: true,
    modelIdentity: "not-applicable" as const,
  };

  buildInvocation(_contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspacePath,
    };
  }
}

function approval(now: Date) {
  return {
    approvedBy: "test-owner",
    approvedAt: now.toISOString(),
    reason: "Test owner approved the exact evidence-bound GC plan",
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
