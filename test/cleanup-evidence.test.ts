import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Conductor } from "../src/orchestrator/conductor.js";
import { QueueStore } from "../src/queue/queue-store.js";
import { RuntimeReconciler } from "../src/reconcile/runtime-reconciler.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { CodexAdapter } from "../src/workers/codex.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository } from "./helpers.js";

test("cleanup evidence preserves failures while the current state converges", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-cleanup-"));
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new CodexAdapter()]),
  );

  try {
    const contract = await conductor.prepareJob({
      objective: "Preserve cleanup observations",
      repositoryPath: repository.root,
      adapterId: "codex",
      idempotencyKey: "cleanup-evidence",
    });
    const attempt = await conductor.reservePreparedAttempt(contract.jobId);
    let cleanup = await store.readAttemptCleanup(
      contract.jobId,
      attempt.attemptId,
    );
    expect(cleanup.status).toBe("not-required");

    cleanup = await store.registerAttemptCleanupRequirement(
      contract.jobId,
      attempt.attemptId,
      {
        subject: { kind: "process-tree", id: "worker" },
        deadlineMs: 5_000,
      },
    );
    cleanup = await store.registerAttemptCleanupRequirement(
      contract.jobId,
      attempt.attemptId,
      {
        subject: { kind: "workspace", id: "worktree" },
        deadlineMs: 30_000,
      },
    );
    expect(cleanup.status).toBe("pending");

    cleanup = await store.appendAttemptCleanupEvidence(
      contract.jobId,
      attempt.attemptId,
      evidence("process-tree", "worker", "unknown", "process-runner"),
    );
    expect(cleanup.status).toBe("unknown");
    cleanup = await store.appendAttemptCleanupEvidence(
      contract.jobId,
      attempt.attemptId,
      evidence("workspace", "worktree", "failed", "workspace-remove"),
    );
    expect(cleanup.status).toBe("failed");

    cleanup = await store.appendAttemptCleanupEvidence(
      contract.jobId,
      attempt.attemptId,
      evidence("process-tree", "worker", "proven", "process-runner"),
    );
    cleanup = await store.appendAttemptCleanupEvidence(
      contract.jobId,
      attempt.attemptId,
      evidence("workspace", "worktree", "proven", "workspace-remove"),
    );
    expect(cleanup.status).toBe("proven");
    expect(cleanup.evidence.map((entry) => entry.status)).toEqual([
      "unknown",
      "failed",
      "proven",
      "proven",
    ]);

    const reservedManifest = await conductor.getAttempt(attempt.attemptId);
    const claimed = await store.transitionAttempt(reservedManifest, {
      status: "claimed",
      dispatchOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      launchOwner: {
        instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        processId: process.pid,
        claimedAt: new Date().toISOString(),
      },
    });
    const terminal = await store.transitionAttempt(claimed, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      verificationStatus: "ineligible",
      failure: { kind: "orchestrator-error", message: "fixture failure" },
    });
    await store.appendAttemptCleanupEvidence(
      contract.jobId,
      attempt.attemptId,
      evidence("workspace", "worktree", "failed", "workspace-remove"),
    );
    expect(await conductor.getAttempt(attempt.attemptId)).toEqual(terminal);
    await expect(
      store.transitionAttempt(terminal, {
        cleanupError: "must not rewrite terminal worker truth",
      }),
    ).rejects.toThrow("Illegal attempt transition");
    const report = await new RuntimeReconciler(
      conductor,
      new QueueStore(store),
      1_000,
    ).inspect();
    expect(
      report.issues.some(
        (issue) =>
          issue.kind === "attempt-cleanup-unresolved" &&
          issue.attemptId === attempt.attemptId &&
          issue.severity === "blocked",
      ),
    ).toBe(true);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

function evidence(
  kind: "process-tree" | "external-resource" | "workspace",
  id: string,
  status: "proven" | "failed" | "unknown",
  method: "process-runner" | "workspace-remove",
) {
  return {
    schema: "conductor.cleanup-evidence/v1" as const,
    evidenceId: randomUUID(),
    subject: { kind, id },
    status,
    method,
    observedAt: new Date().toISOString(),
  };
}
