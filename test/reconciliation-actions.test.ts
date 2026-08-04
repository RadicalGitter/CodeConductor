import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AttemptManifest } from "../src/contracts/attempt.js";
import { createAttemptCleanupRecord } from "../src/contracts/cleanup.js";
import type { QueueItem } from "../src/contracts/queue.js";
import type { ReconciliationActionProposal } from "../src/contracts/reconcile.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import {
  QueueStore,
  ReconciliationConflictError,
} from "../src/queue/queue-store.js";
import {
  RuntimeReconciler,
  stateEvidenceToken,
} from "../src/reconcile/runtime-reconciler.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";

test("runtime reconciliation persists approval and replays an exact queue reset", async () => {
  const runtime = await createRuntime();
  const operationId = randomUUID();
  const item = queueItem({
    status: "dispatching",
    dispatchOperationId: operationId,
  });

  try {
    await runtime.store.writeJsonAtomic(
      runtime.queue.itemPath(item.jobId),
      item,
    );
    const report = await runtime.reconciler.inspect();
    const proposal = action(
      report.availableActions,
      "reset-abandoned-queue-item",
    );
    const approved = approvedAction(proposal);
    const result = await runtime.reconciler.apply(approved);
    expect(result.evidence).toMatchObject({
      schema: "conductor.runtime-reconciliation-evidence/v1",
      disposition: "applied",
      actionKind: "reset-abandoned-queue-item",
    });
    const updated = await runtime.queue.read(item.jobId);
    expect(updated).toMatchObject({ status: "queued", revision: 1 });
    expect(updated.attemptId).toBeUndefined();
    expect(updated.dispatchOperationId).toBeUndefined();

    if (
      result.evidence.schema !== "conductor.runtime-reconciliation-evidence/v1"
    ) {
      throw new Error("Expected runtime reconciliation evidence");
    }
    expect(await exists(result.evidence.actionPath)).toBe(true);
    expect(await exists(result.evidence.resultPath)).toBe(true);
    const replay = await runtime.reconciler.apply(approved);
    expect(replay.evidence).toEqual(result.evidence);
    expect((await runtime.queue.read(item.jobId)).revision).toBe(1);
  } finally {
    await runtime.dispose();
  }
});

test("a retry reconstructs evidence when mutation committed before its result record", async () => {
  const runtime = await createRuntime();
  const item = queueItem({
    status: "dispatching",
    dispatchOperationId: randomUUID(),
  });

  try {
    await runtime.store.writeJsonAtomic(
      runtime.queue.itemPath(item.jobId),
      item,
    );
    const proposal = action(
      (await runtime.reconciler.inspect()).availableActions,
      "reset-abandoned-queue-item",
    );
    const current = await runtime.queue.read(item.jobId);
    await runtime.queue.reconcile(
      current,
      {
        status: "queued",
        dispatchOperationId: undefined,
        attemptId: undefined,
        completion: undefined,
        message: "simulated crash after authoritative mutation",
      },
      proposal.kind,
    );

    const recovered = await runtime.reconciler.apply(approvedAction(proposal));
    expect(recovered.evidence).toMatchObject({
      schema: "conductor.runtime-reconciliation-evidence/v1",
      disposition: "applied",
      detail: expect.stringContaining("Recovered completed reset"),
    });
    expect((await runtime.queue.read(item.jobId)).revision).toBe(1);
  } finally {
    await runtime.dispose();
  }
});

test("abrupt owner death after mutation converges from persisted action intent", async () => {
  const runtime = await createRuntime();
  const item = queueItem({
    status: "dispatching",
    dispatchOperationId: randomUUID(),
  });

  try {
    await runtime.store.writeJsonAtomic(
      runtime.queue.itemPath(item.jobId),
      item,
    );
    const proposal = action(
      (await runtime.reconciler.inspect()).availableActions,
      "reset-abandoned-queue-item",
    );
    const approved = approvedAction(proposal);
    const actionPath = path.join(runtime.dataRoot, "crash-action.json");
    await writeFile(actionPath, JSON.stringify(approved), "utf8");
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixtures", "reconciliation-crash.ts"),
        runtime.dataRoot,
        actionPath,
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(93);
    expect(stderr).toBe("");
    expect(await runtime.queue.read(item.jobId)).toMatchObject({
      status: "queued",
      revision: 1,
    });

    const recoveredRuntime = await createRuntimeAt(runtime.dataRoot);
    const recovered = await recoveredRuntime.reconciler.apply(approved);
    expect(recovered.evidence).toMatchObject({
      schema: "conductor.runtime-reconciliation-evidence/v1",
      disposition: "applied",
      detail: expect.stringContaining("Recovered completed reset"),
    });
    expect(recovered.report.lease.state).toBe("absent");
  } finally {
    await runtime.dispose();
  }
});

test("standalone CLI applies a typed runtime action without starting a dispatcher", async () => {
  const runtime = await createRuntime();
  const item = queueItem({
    status: "dispatching",
    dispatchOperationId: randomUUID(),
  });

  try {
    await runtime.store.writeJsonAtomic(
      runtime.queue.itemPath(item.jobId),
      item,
    );
    const proposal = action(
      (await runtime.reconciler.inspect()).availableActions,
      "reset-abandoned-queue-item",
    );
    const actionPath = path.join(runtime.dataRoot, "cli-action.json");
    await writeFile(
      actionPath,
      JSON.stringify(approvedAction(proposal)),
      "utf8",
    );
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "..", "scripts", "reconcile-runtime.ts"),
        "--apply",
        actionPath,
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, CONDUCTOR_DATA_DIR: runtime.dataRoot },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      evidence: {
        schema: "conductor.runtime-reconciliation-evidence/v1",
        disposition: "applied",
      },
      report: { lease: { state: "absent" } },
    });
    expect((await runtime.queue.read(item.jobId)).status).toBe("queued");
  } finally {
    await runtime.dispose();
  }
});

test("stale runtime proposals preserve approval intent but cannot mutate newer state", async () => {
  const runtime = await createRuntime();
  const item = queueItem({
    status: "dispatching",
    dispatchOperationId: randomUUID(),
  });

  try {
    await runtime.store.writeJsonAtomic(
      runtime.queue.itemPath(item.jobId),
      item,
    );
    const proposal = action(
      (await runtime.reconciler.inspect()).availableActions,
      "reset-abandoned-queue-item",
    );
    const approved = approvedAction(proposal);
    await runtime.queue.update(await runtime.queue.read(item.jobId), {
      status: "needs-input",
      message: "newer owner evidence",
    });
    await expect(runtime.reconciler.apply(approved)).rejects.toBeInstanceOf(
      ReconciliationConflictError,
    );
    expect((await runtime.queue.read(item.jobId)).message).toBe(
      "newer owner evidence",
    );
    const operation = createHash("sha256")
      .update(JSON.stringify(approved))
      .digest("hex");
    const directory = path.join(
      runtime.queue.root,
      "reconciliation-actions",
      operation,
    );
    expect(await exists(path.join(directory, "action.json"))).toBe(true);
    expect(await exists(path.join(directory, "result.json"))).toBe(false);
  } finally {
    await runtime.dispose();
  }
});

test("a caller cannot manufacture an unoffered action even with the current state hash", async () => {
  const runtime = await createRuntime();
  const dispatchOperationId = randomUUID();
  const attempt = attemptManifest({
    status: "reserved",
    dispatchOperationId,
  });
  const item = queueItem({ status: "dispatching", dispatchOperationId });

  try {
    await writeAttempt(runtime.store, attempt);
    await runtime.store.writeJsonAtomic(
      runtime.queue.itemPath(item.jobId),
      item,
    );
    const current = await runtime.queue.read(item.jobId);
    const forged = {
      schema: "conductor.reconciliation-action-proposal/v2" as const,
      kind: "reset-abandoned-queue-item" as const,
      jobId: current.jobId,
      expectedQueueRevision: current.revision,
      observedStatus: "dispatching" as const,
      evidenceToken: stateEvidenceToken("reset-abandoned-queue-item", {
        item: current,
      }),
      requiredAuthority: "owner" as const,
      description: "Forged reset despite an exact reserved attempt",
    };
    expect(
      (await runtime.reconciler.inspect()).availableActions.map(
        (candidate) => candidate.kind,
      ),
    ).toEqual(["bind-queue-to-attempt"]);
    await expect(
      runtime.reconciler.apply(approvedAction(forged)),
    ).rejects.toBeInstanceOf(ReconciliationConflictError);
    expect((await runtime.queue.read(item.jobId)).status).toBe("dispatching");
  } finally {
    await runtime.dispose();
  }
});

test("terminal attempt and cleanup evidence deterministically repair queue completion", async () => {
  const runtime = await createRuntime();
  const dispatchOperationId = randomUUID();
  const attempt = attemptManifest({
    status: "completed",
    dispatchOperationId,
    verificationStatus: "eligible",
  });
  const item = queueItem({
    status: "running",
    attemptId: attempt.attemptId,
    dispatchOperationId,
  });

  try {
    await writeAttempt(runtime.store, attempt);
    await runtime.store.writeJsonAtomic(
      runtime.queue.itemPath(item.jobId),
      item,
    );
    const proposal = action(
      (await runtime.reconciler.inspect()).availableActions,
      "synchronize-queue-from-terminal-attempt",
    );
    const result = await runtime.reconciler.apply(approvedAction(proposal));
    expect(result.evidence).toMatchObject({ disposition: "applied" });
    expect(await runtime.queue.read(item.jobId)).toMatchObject({
      status: "completed",
      attemptId: attempt.attemptId,
      completion: {
        attemptId: attempt.attemptId,
        attemptStatus: "completed",
        verificationStatus: "eligible",
        cleanupStatus: "not-required",
      },
    });
  } finally {
    await runtime.dispose();
  }
});

test("exact dispatch identity can be rebound without launching or changing the attempt", async () => {
  const runtime = await createRuntime();
  const dispatchOperationId = randomUUID();
  const attempt = attemptManifest({
    status: "reserved",
    dispatchOperationId,
  });
  const item = queueItem({ status: "dispatching", dispatchOperationId });

  try {
    await writeAttempt(runtime.store, attempt);
    await runtime.store.writeJsonAtomic(
      runtime.queue.itemPath(item.jobId),
      item,
    );
    const proposal = action(
      (await runtime.reconciler.inspect()).availableActions,
      "bind-queue-to-attempt",
    );
    await runtime.reconciler.apply(approvedAction(proposal));
    expect(await runtime.queue.read(item.jobId)).toMatchObject({
      status: "running",
      attemptId: attempt.attemptId,
      dispatchOperationId,
    });
    expect((await runtime.conductor.getAttempt(attempt.attemptId)).status).toBe(
      "reserved",
    );
  } finally {
    await runtime.dispose();
  }
});

test("untrusted cross-job bindings quarantine queue routing without rewriting attempt evidence", async () => {
  const runtime = await createRuntime();
  const dispatchOperationId = randomUUID();
  const attempt = attemptManifest({
    jobId: "job_other",
    attemptId: "job_other_a0001",
    status: "completed",
    dispatchOperationId,
    verificationStatus: "eligible",
  });
  const item = queueItem({
    status: "running",
    attemptId: attempt.attemptId,
    dispatchOperationId,
  });

  try {
    await writeAttempt(runtime.store, attempt);
    await runtime.store.writeJsonAtomic(
      runtime.queue.itemPath(item.jobId),
      item,
    );
    const proposal = action(
      (await runtime.reconciler.inspect()).availableActions,
      "quarantine-queue-item",
    );
    await runtime.reconciler.apply(approvedAction(proposal));
    const quarantined = await runtime.queue.read(item.jobId);
    expect(quarantined.status).toBe("needs-input");
    expect(quarantined.attemptId).toBeUndefined();
    expect(quarantined.dispatchOperationId).toBeUndefined();
    expect((await runtime.conductor.getAttempt(attempt.attemptId)).status).toBe(
      "completed",
    );
  } finally {
    await runtime.dispose();
  }
});

test("orphan recovery terminalizes only evidence-safe attempts and reports blocked legacy state", async () => {
  const runtime = await createRuntime();
  const reserved = attemptManifest({ status: "reserved" });
  const legacy = attemptManifest({
    jobId: "job_legacy",
    attemptId: "job_legacy_a0001",
    status: "running",
  });

  try {
    await writeAttempt(runtime.store, reserved);
    await writeAttempt(runtime.store, legacy);
    let report = await runtime.reconciler.inspect();
    const recoverReserved = report.availableActions.find(
      (candidate) =>
        candidate.kind === "recover-interrupted-attempt" &&
        candidate.attemptId === reserved.attemptId,
    );
    const recoverLegacy = report.availableActions.find(
      (candidate) =>
        candidate.kind === "recover-interrupted-attempt" &&
        candidate.attemptId === legacy.attemptId,
    );
    expect(recoverReserved).toBeTruthy();
    expect(recoverLegacy).toBeTruthy();

    const recovered = await runtime.reconciler.apply(
      approvedAction(recoverReserved!),
    );
    expect(recovered.evidence).toMatchObject({ disposition: "applied" });
    expect(
      (await runtime.conductor.getAttempt(reserved.attemptId)).status,
    ).toBe("cancelled");

    const blocked = await runtime.reconciler.apply(
      approvedAction(recoverLegacy!),
    );
    expect(blocked.evidence).toMatchObject({
      disposition: "blocked",
      actionKind: "recover-interrupted-attempt",
    });
    expect((await runtime.conductor.getAttempt(legacy.attemptId)).status).toBe(
      "running",
    );
    report = blocked.report;
    expect(
      report.issues.some(
        (issue) =>
          issue.attemptId === legacy.attemptId &&
          issue.kind === "unreferenced-nonterminal-attempt",
      ),
    ).toBe(true);
  } finally {
    await runtime.dispose();
  }
});

test("a live dispatcher suppresses competing state actions", async () => {
  const runtime = await createRuntime();
  const attempt = attemptManifest({ status: "reserved" });

  try {
    await writeAttempt(runtime.store, attempt);
    const lease = await runtime.queue.acquireLease("live-owner", 5_000);
    const report = await runtime.reconciler.inspect();
    expect(report.availableActions).toEqual([]);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: "unreferenced-nonterminal-attempt",
        attemptId: attempt.attemptId,
        severity: "warning",
        requiredAuthority: "wait-for-owner",
      }),
    );
    await runtime.queue.releaseLease(lease!);
  } finally {
    await runtime.dispose();
  }
});

test("specialized queue reconciliation rejects an unauthorized postcondition", async () => {
  const runtime = await createRuntime();
  const item = queueItem({
    status: "dispatching",
    dispatchOperationId: randomUUID(),
  });

  try {
    await runtime.store.writeJsonAtomic(
      runtime.queue.itemPath(item.jobId),
      item,
    );
    const current = await runtime.queue.read(item.jobId);
    await expect(
      runtime.queue.reconcile(
        current,
        { status: "completed" },
        "synchronize-queue-from-terminal-attempt",
      ),
    ).rejects.toThrow("Illegal synchronize-queue-from-terminal-attempt");
    expect((await runtime.queue.read(item.jobId)).revision).toBe(0);
  } finally {
    await runtime.dispose();
  }
});

async function createRuntime() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-actions-"));
  return createRuntimeAt(dataRoot, true);
}

async function createRuntimeAt(dataRoot: string, ownsRoot = false) {
  const store = new ArtifactStore(dataRoot);
  const queue = new QueueStore(store);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([]),
  );
  return {
    dataRoot,
    store,
    queue,
    conductor,
    reconciler: new RuntimeReconciler(conductor, queue, 1_000),
    dispose: () =>
      ownsRoot
        ? rm(dataRoot, { recursive: true, force: true })
        : Promise.resolve(),
  };
}

async function writeAttempt(
  store: ArtifactStore,
  attempt: AttemptManifest,
): Promise<void> {
  await store.writeJsonAtomic(
    store.attemptManifestPath(attempt.jobId, attempt.attemptId),
    attempt,
  );
  await store.writeJsonAtomic(
    store.attemptCleanupPath(attempt.jobId, attempt.attemptId),
    createAttemptCleanupRecord({
      attemptId: attempt.attemptId,
      jobId: attempt.jobId,
    }),
  );
}

function action<T extends ReconciliationActionProposal["kind"]>(
  actions: ReconciliationActionProposal[],
  kind: T,
): Extract<ReconciliationActionProposal, { kind: T }> {
  const found = actions.find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`Missing reconciliation action ${kind}`);
  return found as Extract<ReconciliationActionProposal, { kind: T }>;
}

function approvedAction<T extends ReconciliationActionProposal>(proposal: T) {
  return {
    schema: "conductor.reconciliation-action/v1" as const,
    proposal,
    approval: {
      approvedBy: "test-owner",
      approvedAt: new Date().toISOString(),
      reason: "Test owner approved exact evidence-bound state repair",
    },
  };
}

function queueItem(
  patch: Partial<QueueItem> & Pick<QueueItem, "status">,
): QueueItem {
  const { status, ...rest } = patch;
  const now = new Date().toISOString();
  return {
    schema: "conductor.queue-item/v2",
    jobId: "job_example",
    status,
    revision: 0,
    priority: 0,
    dependsOnJobIds: [],
    createdAt: now,
    updatedAt: now,
    automaticRetryCount: 0,
    ...rest,
  };
}

function attemptManifest(
  patch: Partial<AttemptManifest> & Pick<AttemptManifest, "status">,
): AttemptManifest {
  const { status, ...rest } = patch;
  const jobId = patch.jobId ?? "job_example";
  const attemptId = patch.attemptId ?? `${jobId}_a0001`;
  const root = path.join("artifacts", attemptId);
  const now = new Date().toISOString();
  return {
    schema: "conductor.attempt/v2",
    jobId,
    attemptId,
    ordinal: 1,
    adapterId: "fixture",
    status,
    revision: 0,
    createdAt: now,
    finishedAt: ["completed", "failed", "needs-input", "cancelled"].includes(
      status,
    )
      ? now
      : undefined,
    artifacts: {
      job: path.join(root, "job.json"),
      manifest: path.join(root, "attempt.json"),
      cleanup: path.join(root, "cleanup.json"),
      stdout: path.join(root, "stdout.log"),
      stderr: path.join(root, "stderr.log"),
      proposalPatch: path.join(root, "proposal.patch"),
      repositoryStatus: path.join(root, "repository-status.txt"),
      changedPaths: path.join(root, "changed-paths.json"),
      verification: path.join(root, "verification.json"),
    },
    externalResources: [],
    reviewDisposition: "not-requested",
    verificationStatus: patch.verificationStatus ?? "not-run",
    ...rest,
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
