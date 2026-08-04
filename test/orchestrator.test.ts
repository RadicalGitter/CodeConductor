import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Conductor, type RunJobResult } from "../src/orchestrator/conductor.js";
import type { JobContract } from "../src/contracts/job.js";
import {
  ArtifactStore,
  IdempotencyConflictError,
} from "../src/storage/artifact-store.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import {
  GitWorkspaceManager,
  type GitWorkspace,
} from "../src/workspaces/git-workspace.js";
import { createTestRepository, runTestJob } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("./fixtures/mutate-worker.ts", import.meta.url),
);

test("runs a durable proposal in an exact-revision worktree and replays idempotently", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-data-"));
  const store = new ArtifactStore(dataRoot);
  const workspaces = new GitWorkspaceManager(store.workspaceRoot());
  const conductor = new Conductor(
    store,
    workspaces,
    new WorkerRegistry([new FixtureAdapter()]),
  );
  let retainedWorkspace: GitWorkspace | undefined;

  try {
    const request = {
      objective: "Create generated.txt as a worker proposal",
      repositoryPath: repository.root,
      adapterId: "fixture",
      idempotencyKey: "durable-proposal-test",
      retainWorkspace: true,
    };
    const result = await runTestJob(conductor, request);
    retainedWorkspace = {
      path: result.workspacePath!,
      repositoryRoot: repository.root,
      baseRevision: repository.revision,
    };
    expect(result.status).toBe("completed");
    expect(result.idempotentReplay).toBe(false);
    expect(result.workspacePath).toBeTruthy();
    expect(await exists(path.join(repository.root, "generated.txt"))).toBe(
      false,
    );
    expect(
      await readFile(path.join(result.workspacePath!, "generated.txt"), "utf8"),
    ).toBe("worker proposal\n");
    expect(await readFile(result.artifacts.stdout, "utf8")).toContain(
      "worker_complete",
    );
    expect(await readFile(result.artifacts.proposalPatch, "utf8")).toContain(
      "generated.txt",
    );

    const manifest = await conductor.getAttempt(result.attemptId);
    expect(manifest.workspace?.baseRevision).toBe(repository.revision);
    expect(manifest.reviewDisposition).toBe("not-requested");

    const firstReview = await conductor.getReviewBundle(result.attemptId);
    const secondReview = await conductor.getReviewBundle(result.attemptId);
    expect(firstReview.packet.schema).toBe("conductor.review-packet/v2");
    expect(firstReview.packet.authority).toBe("advisory-review-only");
    expect(firstReview.packet.changedPaths).toEqual(["generated.txt"]);
    expect(firstReview.patch.text).toContain("generated.txt");
    expect(secondReview.packet).toEqual(firstReview.packet);
    expect(
      firstReview.packet.bindings.find((binding) =>
        binding.purposes.includes("proposal-patch"),
      )?.sha256,
    ).toMatch(/^[a-f0-9]{64}$/);
    const originalPatch = await readFile(
      result.artifacts.proposalPatch,
      "utf8",
    );
    await writeFile(
      result.artifacts.proposalPatch,
      `${originalPatch}\ntampered\n`,
    );
    await expect(conductor.getReviewBundle(result.attemptId)).rejects.toThrow(
      "Sealed review evidence changed",
    );
    await writeFile(result.artifacts.proposalPatch, originalPatch);

    const replay = await runTestJob(conductor, request);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.attemptId).toBe(result.attemptId);

    await expect(
      runTestJob(conductor, {
        ...request,
        objective: "A conflicting objective",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const processSubject = (
      await conductor.getAttemptCleanup(result.attemptId)
    ).requirements.find(
      (requirement) => requirement.subject.kind === "process-tree",
    )!.subject;
    await store.appendAttemptCleanupEvidence(result.jobId, result.attemptId, {
      schema: "conductor.cleanup-evidence/v1",
      evidenceId: randomUUID(),
      subject: processSubject,
      status: "unknown",
      method: "legacy-unverified",
      observedAt: new Date().toISOString(),
      detail: "injected unproved descendant state",
    });
    await expect(
      conductor.removeAttemptWorkspace(result.attemptId),
    ).rejects.toThrow("workspace removal is prohibited");
    expect(await exists(result.workspacePath!)).toBe(true);
    await store.appendAttemptCleanupEvidence(result.jobId, result.attemptId, {
      schema: "conductor.cleanup-evidence/v1",
      evidenceId: randomUUID(),
      subject: processSubject,
      status: "proven",
      method: "process-runner",
      observedAt: new Date().toISOString(),
      detail: "injected closure after quarantine assertion",
    });

    const removed = await conductor.removeAttemptWorkspace(result.attemptId);
    expect(removed.manifest.workspace?.retained).toBe(true);
    expect(removed.cleanup.status).toBe("proven");
    expect(await exists(result.workspacePath!)).toBe(false);
    retainedWorkspace = undefined;
  } finally {
    if (retainedWorkspace) await workspaces.remove(retainedWorkspace);
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 60_000);

test("workspace cleanup failure is durable without rewriting worker outcome", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-cleanup-failure-"),
  );
  const store = new ArtifactStore(dataRoot);
  const workspaces = new FailingRemovalWorkspaceManager(store.workspaceRoot());
  const conductor = new Conductor(
    store,
    workspaces,
    new WorkerRegistry([new FixtureAdapter()]),
  );
  let retainedWorkspace: GitWorkspace | undefined;

  try {
    const result = await runTestJob(conductor, {
      objective: "Preserve a completed proposal when cleanup fails",
      repositoryPath: repository.root,
      adapterId: "fixture",
      idempotencyKey: "workspace-cleanup-failure",
      retainWorkspace: false,
    });
    retainedWorkspace = {
      path: result.workspacePath!,
      repositoryRoot: repository.root,
      baseRevision: repository.revision,
    };

    expect(result.status).toBe("completed");
    const manifest = await conductor.getAttempt(result.attemptId);
    expect(manifest.status).toBe("completed");
    expect(manifest.failure).toBeUndefined();
    expect(await conductor.getAttemptCleanup(result.attemptId)).toMatchObject({
      status: "failed",
      evidence: [
        expect.objectContaining({
          subject: { kind: "process-tree", id: "worker" },
          status: "proven",
        }),
        expect.objectContaining({
          subject: { kind: "workspace", id: "worktree" },
          status: "failed",
          method: "workspace-remove",
        }),
      ],
    });
    expect(await exists(result.workspacePath!)).toBe(true);
  } finally {
    if (retainedWorkspace) {
      await new GitWorkspaceManager(store.workspaceRoot()).remove(
        retainedWorkspace,
      );
    }
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 60_000);

test("100 jittered simultaneous callers claim and launch one reserved attempt once", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-claim-"));
  const store = new ArtifactStore(dataRoot);
  const workspaces = new CountingWorkspaceManager(store.workspaceRoot());
  const conductor = new Conductor(
    store,
    workspaces,
    new WorkerRegistry([new FixtureAdapter()]),
  );
  let retainedWorkspace: GitWorkspace | undefined;

  try {
    const contract = await conductor.prepareJob({
      objective: "Claim one worker launch",
      repositoryPath: repository.root,
      adapterId: "fixture",
      idempotencyKey: "single-launch-claim",
      retainWorkspace: true,
      scope: { allowedPaths: ["generated.txt"] },
    });
    const dispatchOperationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const reserved = await conductor.reservePreparedAttempt(
      contract.jobId,
      [],
      dispatchOperationId,
    );
    await expect(
      conductor.startReservedAttempt(
        reserved.attemptId,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ),
    ).rejects.toThrow(`belongs to dispatch operation ${dispatchOperationId}`);
    const starts = await Promise.allSettled(
      Array.from({ length: 100 }, async (_, index) => {
        await new Promise((resolve) =>
          setTimeout(resolve, (index * 17 + 3) % 11),
        );
        return conductor.startReservedAttempt(
          reserved.attemptId,
          dispatchOperationId,
        );
      }),
    );

    expect(starts.filter((start) => start.status === "fulfilled")).toHaveLength(
      1,
    );
    const result = await conductor.waitForAttempt(reserved.attemptId);
    expect(result.status).toBe("completed");
    expect(workspaces.createCalls).toBe(1);
    retainedWorkspace = {
      path: result.workspacePath!,
      repositoryRoot: repository.root,
      baseRevision: repository.revision,
    };
    await conductor.removeAttemptWorkspace(result.attemptId);
    retainedWorkspace = undefined;
  } finally {
    if (retainedWorkspace) await workspaces.remove(retainedWorkspace);
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 60_000);

test("100 randomized claim races each enter the launch seam exactly once", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-races-"));
  const store = new ArtifactStore(dataRoot);
  const conductor = new ClaimCountingConductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new FixtureAdapter()]),
  );

  try {
    const template = await conductor.prepareJob({
      objective: "Create a template for repeated claim races",
      repositoryPath: repository.root,
      adapterId: "fixture",
      idempotencyKey: "claim-race-template",
    });
    for (let trial = 0; trial < 100; trial += 1) {
      const suffix = trial.toString().padStart(4, "0");
      const contract = {
        ...template,
        jobId: `job_claim_round_${suffix}`,
        idempotencyKey: `claim-round-${suffix}`,
      };
      await store.reserveJob(contract);
      const dispatchOperationId = `00000000-0000-4000-8000-${trial
        .toString(16)
        .padStart(12, "0")}`;
      const reserved = await store.reserveInitialAttempt(
        contract,
        dispatchOperationId,
      );
      const callers = 2 + ((trial * 37 + 11) % 19);
      const before = conductor.launches;
      const starts = await Promise.allSettled(
        Array.from({ length: callers }, async (_, caller) => {
          await new Promise((resolve) =>
            setTimeout(resolve, (trial * 13 + caller * 7) % 5),
          );
          return conductor.startReservedAttempt(
            reserved.manifest.attemptId,
            dispatchOperationId,
          );
        }),
      );
      expect(
        starts.filter((start) => start.status === "fulfilled"),
      ).toHaveLength(1);
      expect(conductor.launches).toBe(before + 1);
    }
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 30_000);

class FixtureAdapter implements WorkerAdapter {
  readonly description = {
    id: "fixture",
    label: "Fixture worker",
    executable: process.execPath,
    mutationMode: "worktree" as const,
    outputFormat: "jsonl" as const,
    safetyMode: "test-fixture",
    available: true,
    modelIdentity: "not-applicable" as const,
  };

  buildInvocation(_contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: [fixture, workspacePath],
      cwd: workspacePath,
    };
  }
}

class CountingWorkspaceManager extends GitWorkspaceManager {
  createCalls = 0;

  override async create(input: {
    repositoryRoot: string;
    baseRevision: string;
    attemptId: string;
  }) {
    this.createCalls += 1;
    return super.create(input);
  }
}

class FailingRemovalWorkspaceManager extends GitWorkspaceManager {
  override async remove(_workspace: GitWorkspace): Promise<void> {
    throw new Error("injected workspace cleanup failure");
  }
}

class ClaimCountingConductor extends Conductor {
  launches = 0;

  override async launchClaimedAttempt(
    attemptId: string,
    dispatchOperationId: string,
  ): Promise<RunJobResult> {
    const manifest = await this.getAttempt(attemptId);
    if (
      manifest.status !== "claimed" ||
      manifest.dispatchOperationId !== dispatchOperationId
    ) {
      throw new Error("Launch seam received an invalid durable claim");
    }
    this.launches += 1;
    return {
      jobId: manifest.jobId,
      attemptId: manifest.attemptId,
      status: manifest.status,
      idempotentReplay: false,
      artifacts: manifest.artifacts,
      verificationStatus: manifest.verificationStatus,
      cleanupStatus: "not-required",
    };
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
