import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AttemptManifest } from "../src/contracts/attempt.js";
import type { QueueItem } from "../src/contracts/queue.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import {
  QueueStore,
  ReconciliationConflictError,
} from "../src/queue/queue-store.js";
import { RuntimeReconciler } from "../src/reconcile/runtime-reconciler.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";

test("unreadable lease evidence refuses silent acquisition and requests reconciliation", async () => {
  for (const shape of ["malformed", "missing"] as const) {
    const dataRoot = await mkdtemp(
      path.join(os.tmpdir(), `conductor-lease-${shape}-`),
    );
    const store = new ArtifactStore(dataRoot);
    const queue = new QueueStore(store);
    const lockDirectory = path.join(dataRoot, "queue", "dispatcher.lock");

    try {
      await queue.initialize();
      await mkdir(lockDirectory);
      if (shape === "malformed") {
        await writeFile(
          path.join(lockDirectory, "lease.json"),
          "{broken",
          "utf8",
        );
      }
      const old = new Date(Date.now() - 60_000);
      await utimes(lockDirectory, old, old);
      await expect(queue.acquireLease("new-owner", 1_000)).rejects.toThrow(
        "requires reconciliation",
      );
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
});

test("a same-host dead owner is recoverable despite a future expiry", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-clock-"));
  const store = new ArtifactStore(dataRoot);
  const queue = new QueueStore(store);

  try {
    const original = await queue.acquireLease("dead-owner", 1_000);
    expect(original).toBeTruthy();
    await store.writeJsonAtomic(
      path.join(dataRoot, "queue", "dispatcher.lock", "lease.json"),
      {
        ...original,
        processId: 999_999_999,
        heartbeatAt: "2099-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:01:00.000Z",
      },
    );

    const recovered = await queue.acquireLease("recovered-owner", 1_000);
    expect(recovered?.generation).toBe(original!.generation + 1);
    const evidence = await readdir(
      path.join(dataRoot, "queue", "lease-evidence"),
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("lease inspection distinguishes initialization, stale absence, and corruption", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-inspect-"));
  const queue = new QueueStore(new ArtifactStore(dataRoot));
  const lockDirectory = path.join(dataRoot, "queue", "dispatcher.lock");
  const now = new Date();

  try {
    await queue.initialize();
    await mkdir(lockDirectory);
    const initializing = await queue.inspectLease(1_000, now);
    expect(initializing.state).toBe("initializing");
    expect(initializing.ownerAction).toBeUndefined();

    const old = new Date(now.getTime() - 2_000);
    await utimes(lockDirectory, old, old);
    const incomplete = await queue.inspectLease(1_000, now);
    expect(incomplete.state).toBe("incomplete");
    expect(incomplete.ownerAction?.observedState).toBe("incomplete");

    await writeFile(path.join(lockDirectory, "lease.json"), "{broken", "utf8");
    await utimes(lockDirectory, old, old);
    const corrupt = await queue.inspectLease(1_000, now);
    expect(corrupt.state).toBe("corrupt");
    expect(corrupt.ownerAction?.observedState).toBe("corrupt");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("young corrupt lease evidence requires waiting rather than implicit authority", async () => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-young-corrupt-"),
  );
  const store = new ArtifactStore(dataRoot);
  const queue = new QueueStore(store);
  const reconciler = createReconciler(store, queue, 1_000);
  const lockDirectory = path.join(dataRoot, "queue", "dispatcher.lock");

  try {
    await queue.initialize();
    await mkdir(lockDirectory);
    await writeFile(path.join(lockDirectory, "lease.json"), "{broken", "utf8");
    const report = await reconciler.inspect();
    expect(report.availableActions).toEqual([]);
    expect(report.issues[0]?.requiredAuthority).toBe("wait-for-owner");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("owner quarantine preserves unreadable lease bytes and records the reason", async () => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-quarantine-"),
  );
  const store = new ArtifactStore(dataRoot);
  const queue = new QueueStore(store);
  const reconciler = createReconciler(store, queue, 1_000);
  const lockDirectory = path.join(dataRoot, "queue", "dispatcher.lock");
  const now = new Date();

  try {
    await queue.initialize();
    await mkdir(lockDirectory);
    await writeFile(path.join(lockDirectory, "lease.json"), "{broken", "utf8");
    const old = new Date(now.getTime() - 2_000);
    await utimes(lockDirectory, old, old);
    const report = await reconciler.inspect(now);
    expect(report.issues.map((issue) => issue.kind)).toContain(
      "lease-reconciliation-required",
    );
    expect(report.availableActions).toHaveLength(1);

    const result = await reconciler.apply(
      {
        schema: "conductor.reconciliation-action/v1",
        proposal: report.availableActions[0]!,
        approval: {
          approvedBy: "test-owner",
          approvedAt: now.toISOString(),
          reason: "Owner inspected the local process and approved quarantine",
        },
      },
      now,
    );
    expect(result.report.lease.state).toBe("absent");
    expect(
      await readFile(
        path.join(result.evidence.evidencePath, "lease.json"),
        "utf8",
      ),
    ).toBe("{broken");
    const record = JSON.parse(
      await readFile(
        path.join(result.evidence.evidencePath, "reconciliation.json"),
        "utf8",
      ),
    ) as { ownerReason: string; ownerApprovedBy: string };
    expect(record.ownerReason).toBe(
      "Owner inspected the local process and approved quarantine",
    );
    expect(record.ownerApprovedBy).toBe("test-owner");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("owner quarantine preserves an incomplete stale lease directory", async () => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-incomplete-quarantine-"),
  );
  const store = new ArtifactStore(dataRoot);
  const queue = new QueueStore(store);
  const reconciler = createReconciler(store, queue, 1_000);
  const lockDirectory = path.join(dataRoot, "queue", "dispatcher.lock");
  const now = new Date();

  try {
    await queue.initialize();
    await mkdir(lockDirectory);
    const old = new Date(now.getTime() - 2_000);
    await utimes(lockDirectory, old, old);
    const report = await reconciler.inspect(now);
    expect(report.lease.state).toBe("incomplete");
    const result = await reconciler.apply(
      approvedAction(report.availableActions[0]!, now),
      now,
    );
    expect(result.evidence.originalState).toBe("incomplete");
    expect((await stat(result.evidence.evidencePath)).isDirectory()).toBe(true);
    await expect(
      readFile(path.join(result.evidence.evidencePath, "lease.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await queue.acquireLease("new-owner", 1_000, now)).toBeTruthy();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("evidence-bound owner actions refuse stale observations", async () => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-stale-action-"),
  );
  const queue = new QueueStore(new ArtifactStore(dataRoot));
  const lockDirectory = path.join(dataRoot, "queue", "dispatcher.lock");
  const now = new Date();

  try {
    await queue.initialize();
    await mkdir(lockDirectory);
    await writeFile(path.join(lockDirectory, "lease.json"), "{first", "utf8");
    const old = new Date(now.getTime() - 2_000);
    await utimes(lockDirectory, old, old);
    const proposal = (await queue.inspectLease(1_000, now)).ownerAction!;
    await writeFile(path.join(lockDirectory, "lease.json"), "{second", "utf8");
    await utimes(lockDirectory, old, old);

    await expect(
      queue.quarantineUnreadableLease(
        approvedAction(proposal, now),
        1_000,
        now,
      ),
    ).rejects.toBeInstanceOf(ReconciliationConflictError);
    expect(await readFile(path.join(lockDirectory, "lease.json"), "utf8")).toBe(
      "{second",
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("two owner actions preserve evidence exactly once", async () => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-action-race-"),
  );
  const queue = new QueueStore(new ArtifactStore(dataRoot));
  const lockDirectory = path.join(dataRoot, "queue", "dispatcher.lock");
  const now = new Date();

  try {
    await queue.initialize();
    await mkdir(lockDirectory);
    await writeFile(path.join(lockDirectory, "lease.json"), "{broken", "utf8");
    const old = new Date(now.getTime() - 2_000);
    await utimes(lockDirectory, old, old);
    const proposal = (await queue.inspectLease(1_000, now)).ownerAction!;
    const action = approvedAction(proposal, now);
    const results = await Promise.allSettled([
      queue.quarantineUnreadableLease(action, 1_000, now),
      queue.quarantineUnreadableLease(action, 1_000, now),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await readdir(path.join(dataRoot, "queue", "lease-evidence")),
    ).toHaveLength(1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("a dead reconciliation owner is preserved and cannot wedge lease repair", async () => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-dead-reconcile-owner-"),
  );
  const store = new ArtifactStore(dataRoot);
  const queue = new QueueStore(store);
  const reconciler = createReconciler(store, queue, 1_000);
  const lockDirectory = path.join(dataRoot, "queue", "dispatcher.lock");
  const reconciliationLock = path.join(
    dataRoot,
    "queue",
    "dispatcher.reconcile.lock",
  );
  const deadInstanceId = randomUUID();
  const now = new Date();

  try {
    await queue.initialize();
    await mkdir(lockDirectory);
    await writeFile(path.join(lockDirectory, "lease.json"), "{broken", "utf8");
    const old = new Date(now.getTime() - 2_000);
    await utimes(lockDirectory, old, old);
    await store.writeJsonAtomic(path.join(reconciliationLock, "owner.json"), {
      schema: "conductor.reconciliation-mutex/v1",
      instanceId: deadInstanceId,
      hostname: os.hostname(),
      processId: 999_999_999,
      acquiredAt: old.toISOString(),
    });
    const report = await reconciler.inspect(now);
    const result = await reconciler.apply(
      approvedAction(report.availableActions[0]!, now),
      now,
    );
    expect(result.evidence.originalState).toBe("corrupt");
    const mutexEvidence = path.join(
      dataRoot,
      "queue",
      "lease-evidence",
      "reconciliation-locks",
      deadInstanceId,
      "reconciliation.json",
    );
    expect(
      (
        JSON.parse(await readFile(mutexEvidence, "utf8")) as {
          disposition: string;
        }
      ).disposition,
    ).toBe("recovered-dead-owner");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("live local and remote leases are never stolen on time evidence alone", async () => {
  for (const shape of ["live-local", "remote"] as const) {
    const dataRoot = await mkdtemp(
      path.join(os.tmpdir(), `conductor-no-steal-${shape}-`),
    );
    const store = new ArtifactStore(dataRoot);
    const queue = new QueueStore(store);

    try {
      const lease = await queue.acquireLease("first-owner", 1_000);
      expect(lease).toBeTruthy();
      await store.writeJsonAtomic(
        path.join(dataRoot, "queue", "dispatcher.lock", "lease.json"),
        {
          ...lease,
          hostname: shape === "remote" ? "another-host" : os.hostname(),
          processId: shape === "remote" ? 999_999_999 : process.pid,
          heartbeatAt: "2000-01-01T00:00:00.000Z",
          expiresAt: "2000-01-01T00:00:01.000Z",
        },
      );
      const inspection = await queue.inspectLease(1_000);
      expect(inspection.state).toBe(
        shape === "remote" ? "active-remote" : "expired-live-local",
      );
      expect(await queue.acquireLease("second-owner", 1_000)).toBeUndefined();
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
});

test("two dead-owner recoverers create one successor lease", async () => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-recovery-race-"),
  );
  const store = new ArtifactStore(dataRoot);
  const queue = new QueueStore(store);

  try {
    const lease = await queue.acquireLease("dead-owner", 1_000);
    await store.writeJsonAtomic(
      path.join(dataRoot, "queue", "dispatcher.lock", "lease.json"),
      { ...lease, processId: 999_999_999 },
    );
    const results = await Promise.all([
      queue.acquireLease("recoverer-a", 1_000),
      queue.acquireLease("recoverer-b", 1_000),
    ]);
    const acquired = results.filter((candidate) => candidate !== undefined);
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.generation).toBe(2);
    const current = await queue.inspectLease(1_000);
    expect(current.state).toBe("active-local");
    expect(current.lease?.generation).toBe(2);
    expect(
      await readdir(path.join(dataRoot, "queue", "lease-evidence")),
    ).toHaveLength(1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("dry-run reconciliation reports queue and attempt relationship mismatches without mutation", async () => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-reconcile-state-"),
  );
  const store = new ArtifactStore(dataRoot);
  const queue = new QueueStore(store);
  const reconciler = createReconciler(store, queue, 1_000);
  const now = new Date().toISOString();
  const queueOperation = randomUUID();
  const attemptOperation = randomUUID();
  const queueItem = queueItemFixture({
    jobId: "job-terminal",
    status: "completed",
    attemptId: "job-terminal_a001",
    dispatchOperationId: queueOperation,
    now,
  });
  const attempt = attemptFixture({
    jobId: "job-terminal",
    attemptId: "job-terminal_a001",
    status: "running",
    dispatchOperationId: attemptOperation,
    now,
  });
  const orphan = attemptFixture({
    jobId: "job-orphan",
    attemptId: "job-orphan_a001",
    status: "reserved",
    dispatchOperationId: randomUUID(),
    now,
  });

  try {
    await store.writeJsonAtomic(queue.itemPath(queueItem.jobId), queueItem);
    await store.writeJsonAtomic(
      store.attemptManifestPath(attempt.jobId, attempt.attemptId),
      attempt,
    );
    await store.writeJsonAtomic(
      store.attemptManifestPath(orphan.jobId, orphan.attemptId),
      orphan,
    );
    const before = await stat(queue.itemPath(queueItem.jobId));
    const report = await reconciler.inspect();
    const kinds = report.issues.map((issue) => issue.kind);
    expect(kinds).toContain("dispatch-operation-mismatch");
    expect(kinds).toContain("terminal-queue-nonterminal-attempt");
    expect(kinds).toContain("unreferenced-nonterminal-attempt");
    expect(report.availableActions).toEqual([]);
    const after = await stat(queue.itemPath(queueItem.jobId));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("a reserved attempt under a live lease is reported as transient rather than corrupt", async () => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-reconcile-transient-"),
  );
  const store = new ArtifactStore(dataRoot);
  const queue = new QueueStore(store);
  const reconciler = createReconciler(store, queue, 1_000);
  const now = new Date().toISOString();
  const orphan = attemptFixture({
    jobId: "job-in-flight",
    attemptId: "job-in-flight_a001",
    status: "reserved",
    dispatchOperationId: randomUUID(),
    now,
  });

  try {
    await store.writeJsonAtomic(
      store.attemptManifestPath(orphan.jobId, orphan.attemptId),
      orphan,
    );
    const lease = await queue.acquireLease("live-owner", 1_000);
    const report = await reconciler.inspect();
    const issue = report.issues.find(
      (candidate) => candidate.kind === "unreferenced-nonterminal-attempt",
    );
    expect(issue?.severity).toBe("warning");
    expect(issue?.requiredAuthority).toBe("wait-for-owner");
    await queue.releaseLease(lease!);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("standalone dry-run reconciliation remains available without starting the dispatcher", async () => {
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-reconcile-cli-"),
  );
  const lockDirectory = path.join(dataRoot, "queue", "dispatcher.lock");

  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, "lease.json"), "{broken", "utf8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDirectory, old, old);
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "..", "scripts", "reconcile-runtime.ts"),
        "--dry-run",
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, CONDUCTOR_DATA_DIR: dataRoot },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout) as {
      dryRun: boolean;
      lease: { state: string };
      availableActions: unknown[];
    };
    expect(report.dryRun).toBe(true);
    expect(report.lease.state).toBe("corrupt");
    expect(report.availableActions).toHaveLength(1);

    const actionPath = path.join(dataRoot, "approved-action.json");
    await writeFile(
      actionPath,
      JSON.stringify(
        approvedAction(
          report.availableActions[0] as Parameters<typeof approvedAction>[0],
          new Date(),
        ),
      ),
      "utf8",
    );
    const applyChild = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "..", "scripts", "reconcile-runtime.ts"),
        "--apply",
        actionPath,
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, CONDUCTOR_DATA_DIR: dataRoot },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [applyExitCode, applyStdout, applyStderr] = await Promise.all([
      applyChild.exited,
      new Response(applyChild.stdout).text(),
      new Response(applyChild.stderr).text(),
    ]);
    expect(applyStderr).toBe("");
    expect(applyExitCode).toBe(0);
    const applied = JSON.parse(applyStdout) as {
      evidence: { originalState: string; evidencePath: string };
      report: { lease: { state: string } };
    };
    expect(applied.evidence.originalState).toBe("corrupt");
    expect(
      await readFile(
        path.join(applied.evidence.evidencePath, "lease.json"),
        "utf8",
      ),
    ).toBe("{broken");
    expect(applied.report.lease.state).toBe("absent");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

function createReconciler(
  store: ArtifactStore,
  queue: QueueStore,
  leaseMs: number,
): RuntimeReconciler {
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([]),
  );
  return new RuntimeReconciler(conductor, queue, leaseMs);
}

function approvedAction(
  proposal: NonNullable<
    Awaited<ReturnType<QueueStore["inspectLease"]>>["ownerAction"]
  >,
  now: Date,
) {
  return {
    schema: "conductor.reconciliation-action/v1" as const,
    proposal,
    approval: {
      approvedBy: "test-owner",
      approvedAt: now.toISOString(),
      reason: "Test owner approved evidence quarantine",
    },
  };
}

function queueItemFixture(input: {
  jobId: string;
  status: QueueItem["status"];
  attemptId?: string;
  dispatchOperationId?: string;
  now: string;
}): QueueItem {
  return {
    schema: "conductor.queue-item/v2",
    jobId: input.jobId,
    status: input.status,
    revision: 0,
    priority: 0,
    dependsOnJobIds: [],
    createdAt: input.now,
    updatedAt: input.now,
    attemptId: input.attemptId,
    dispatchOperationId: input.dispatchOperationId,
  };
}

function attemptFixture(input: {
  jobId: string;
  attemptId: string;
  status: AttemptManifest["status"];
  dispatchOperationId?: string;
  now: string;
}): AttemptManifest {
  const root = path.join("artifacts", input.attemptId);
  return {
    schema: "conductor.attempt/v2",
    jobId: input.jobId,
    attemptId: input.attemptId,
    ordinal: 1,
    adapterId: "fixture",
    status: input.status,
    revision: 0,
    dispatchOperationId: input.dispatchOperationId,
    createdAt: input.now,
    artifacts: {
      job: path.join(root, "job.json"),
      manifest: path.join(root, "attempt.json"),
      stdout: path.join(root, "stdout.log"),
      stderr: path.join(root, "stderr.log"),
      proposalPatch: path.join(root, "proposal.patch"),
      repositoryStatus: path.join(root, "repository-status.txt"),
      changedPaths: path.join(root, "changed-paths.json"),
      verification: path.join(root, "verification.json"),
    },
    externalResources: [],
    reviewDisposition: "not-requested",
    verificationStatus: "not-run",
  };
}
