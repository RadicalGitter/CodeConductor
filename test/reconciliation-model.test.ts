import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import type { AttemptManifest } from "../src/contracts/attempt.js";
import {
  createAttemptCleanupRecord,
  type AttemptCleanupRecord,
} from "../src/contracts/cleanup.js";
import type { QueueItem } from "../src/contracts/queue.js";
import { projectQueueCompletion } from "../src/queue/completion.js";
import { inspectQueueAttemptRelationships } from "../src/reconcile/runtime-reconciler.js";

const queueStatuses: QueueItem["status"][] = [
  "queued",
  "dispatching",
  "running",
  "cancelling",
  "completed",
  "failed",
  "needs-input",
  "cancelled",
];
const attemptStatuses: Array<AttemptManifest["status"] | "missing"> = [
  "missing",
  "reserved",
  "claimed",
  "preparing",
  "running",
  "verifying",
  "completed",
  "failed",
  "needs-input",
  "cancelled",
];

test("all 80 queue/attempt status pairs are stable, actionable, or owner-held", () => {
  let inspected = 0;
  for (const queueStatus of queueStatuses) {
    for (const attemptStatus of attemptStatuses) {
      const scenario = pair(queueStatus, attemptStatus);
      const unowned = inspectQueueAttemptRelationships(
        [scenario.item],
        scenario.attempt ? [scenario.attempt] : [],
        scenario.cleanup,
        "absent",
      );
      for (const issue of unowned.issues) {
        expect(issue.requiredAuthority).toBe("owner-action");
        expect(issue.actionEvidenceToken).toBeTruthy();
        expect(
          unowned.availableActions.some(
            (action) => action.evidenceToken === issue.actionEvidenceToken,
          ),
        ).toBe(true);
      }

      const owned = inspectQueueAttemptRelationships(
        [scenario.item],
        scenario.attempt ? [scenario.attempt] : [],
        scenario.cleanup,
        "active-local",
      );
      expect(owned.availableActions).toEqual([]);
      for (const issue of owned.issues) {
        expect(issue.requiredAuthority).toBe("wait-for-owner");
        expect(issue.actionEvidenceToken).toBeUndefined();
      }
      inspected += 1;
    }
  }
  expect(inspected).toBe(80);
});

test("relationship model detects wrong owners, corrupt completion, and ambiguous dispatch", () => {
  const operationId = randomUUID();
  const wrongOwner = attempt("completed", operationId, "job_other");
  const wrongOwnerCleanup = cleanup(wrongOwner);
  const crossJob = inspectQueueAttemptRelationships(
    [queue("running", operationId, wrongOwner.attemptId)],
    [wrongOwner],
    new Map([[wrongOwner.attemptId, wrongOwnerCleanup]]),
    "absent",
  );
  expect(crossJob.issues.map((issue) => issue.kind)).toContain(
    "queue-attempt-job-mismatch",
  );

  const terminal = attempt("completed", operationId);
  const terminalCleanup = cleanup(terminal);
  const projection = projectQueueCompletion(
    {
      attemptId: terminal.attemptId,
      status: terminal.status,
      verificationStatus: "eligible",
      cleanupStatus: terminalCleanup.status,
      artifacts: terminal.artifacts,
    },
    terminal.finishedAt,
  );
  const corruptCompletion = inspectQueueAttemptRelationships(
    [
      {
        ...queue("completed", operationId, terminal.attemptId),
        completion: {
          ...projection.completion,
          attemptId: "wrong-attempt",
        },
      },
    ],
    [terminal],
    new Map([[terminal.attemptId, terminalCleanup]]),
    "absent",
  );
  expect(corruptCompletion.issues.map((issue) => issue.kind)).toContain(
    "queue-completion-mismatch",
  );

  const first = attempt("reserved", operationId, "job_example", "attempt-a");
  const second = attempt("reserved", operationId, "job_example", "attempt-b");
  const ambiguous = inspectQueueAttemptRelationships(
    [queue("dispatching", operationId)],
    [first, second],
    new Map([
      [first.attemptId, cleanup(first)],
      [second.attemptId, cleanup(second)],
    ]),
    "absent",
  );
  expect(ambiguous.issues.map((issue) => issue.kind)).toContain(
    "ambiguous-dispatch-attempts",
  );
  expect(ambiguous.availableActions.map((action) => action.kind)).toContain(
    "quarantine-queue-item",
  );
});

test("a terminal attempt without readable cleanup is never rebound as running", () => {
  const operationId = randomUUID();
  const terminal = attempt("completed", operationId);
  const result = inspectQueueAttemptRelationships(
    [queue("dispatching", operationId)],
    [terminal],
    new Map(),
    "absent",
  );

  expect(result.issues.map((candidate) => candidate.kind)).toContain(
    "queue-shape-invalid",
  );
  expect(result.availableActions).toEqual([]);
});

function pair(
  queueStatus: QueueItem["status"],
  attemptStatus: AttemptManifest["status"] | "missing",
) {
  const operationId = randomUUID();
  const manifest =
    attemptStatus === "missing"
      ? undefined
      : attempt(attemptStatus, operationId);
  let item = queue(
    queueStatus,
    queueStatus === "queued" && !manifest ? undefined : operationId,
    manifest?.attemptId,
  );
  const cleanupRecord = manifest ? cleanup(manifest) : undefined;
  if (
    manifest &&
    cleanupRecord &&
    isQueueTerminal(queueStatus) &&
    isAttemptTerminal(manifest.status)
  ) {
    const projection = projectQueueCompletion(
      {
        attemptId: manifest.attemptId,
        status: manifest.status,
        verificationStatus: manifest.verificationStatus,
        cleanupStatus: cleanupRecord.status,
        artifacts: manifest.artifacts,
        failure: manifest.failure,
      },
      manifest.finishedAt,
    );
    item = { ...item, completion: projection.completion };
  }
  return {
    item,
    attempt: manifest,
    cleanup: new Map<string, AttemptCleanupRecord>(
      manifest && cleanupRecord ? [[manifest.attemptId, cleanupRecord]] : [],
    ),
  };
}

function queue(
  status: QueueItem["status"],
  dispatchOperationId?: string,
  attemptId?: string,
): QueueItem {
  const now = "2026-08-04T00:00:00.000Z";
  return {
    schema: "conductor.queue-item/v2",
    jobId: "job_example",
    status,
    revision: 0,
    priority: 0,
    dependsOnJobIds: [],
    createdAt: now,
    updatedAt: now,
    dispatchOperationId,
    attemptId,
  };
}

function attempt(
  status: AttemptManifest["status"],
  dispatchOperationId: string,
  jobId = "job_example",
  attemptId = `${jobId}_a0001`,
): AttemptManifest {
  const terminal = isAttemptTerminal(status);
  const root = `artifacts/${attemptId}`;
  return {
    schema: "conductor.attempt/v2",
    jobId,
    attemptId,
    ordinal: 1,
    adapterId: "fixture",
    status,
    revision: 0,
    dispatchOperationId,
    createdAt: "2026-08-04T00:00:00.000Z",
    finishedAt: terminal ? "2026-08-04T00:01:00.000Z" : undefined,
    artifacts: {
      job: `${root}/job.json`,
      manifest: `${root}/attempt.json`,
      cleanup: `${root}/cleanup.json`,
      stdout: `${root}/stdout.log`,
      stderr: `${root}/stderr.log`,
      proposalPatch: `${root}/proposal.patch`,
      repositoryStatus: `${root}/repository-status.txt`,
      changedPaths: `${root}/changed-paths.json`,
      verification: `${root}/verification.json`,
    },
    externalResources: [],
    reviewDisposition: "not-requested",
    verificationStatus: status === "completed" ? "eligible" : "ineligible",
    failure:
      status === "failed"
        ? { kind: "worker-exit", message: "fixture failure" }
        : status === "cancelled"
          ? { kind: "cancelled", message: "fixture cancellation" }
          : undefined,
  };
}

function cleanup(attempt: AttemptManifest): AttemptCleanupRecord {
  return createAttemptCleanupRecord({
    attemptId: attempt.attemptId,
    jobId: attempt.jobId,
    now: new Date("2026-08-04T00:00:00.000Z"),
  });
}

function isQueueTerminal(status: QueueItem["status"]): boolean {
  return ["completed", "failed", "needs-input", "cancelled"].includes(status);
}

function isAttemptTerminal(status: AttemptManifest["status"]): boolean {
  return ["completed", "failed", "needs-input", "cancelled"].includes(status);
}
