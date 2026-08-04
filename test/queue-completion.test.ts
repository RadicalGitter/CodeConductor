import { expect, test } from "bun:test";

import type { AttemptCompletionEvidence } from "../src/queue/completion.js";
import { projectQueueCompletion } from "../src/queue/completion.js";

const finishedAt = "2026-08-04T00:00:00.000Z";

test("queue completion projection preserves existing terminal routing semantics", () => {
  expect(projectQueueCompletion(result(), finishedAt)).toMatchObject({
    status: "completed",
    completion: {
      attemptStatus: "completed",
      verificationStatus: "eligible",
      cleanupStatus: "proven",
      finishedAt,
    },
    message: undefined,
  });
  expect(
    projectQueueCompletion(result({ cleanupStatus: "unknown" }), finishedAt),
  ).toMatchObject({
    status: "needs-input",
    message:
      "Attempt cleanup is unknown; retry and evidence removal are prohibited",
  });
  expect(
    projectQueueCompletion(
      result({ verificationStatus: "ineligible" }),
      finishedAt,
    ),
  ).toMatchObject({
    status: "needs-input",
    message: "Deterministic verification marked proposal ineligible",
  });
  expect(
    projectQueueCompletion(
      result({
        status: "cancelled",
        verificationStatus: "ineligible",
        failure: { kind: "cancelled", message: "owner cancelled" },
      }),
      finishedAt,
    ),
  ).toMatchObject({ status: "cancelled", message: "owner cancelled" });
  expect(
    projectQueueCompletion(
      result({
        status: "failed",
        verificationStatus: "ineligible",
        failure: { kind: "worker-exit", message: "worker failed" },
      }),
      finishedAt,
    ),
  ).toMatchObject({ status: "failed", message: "worker failed" });
});

function result(
  patch: Partial<AttemptCompletionEvidence> = {},
): AttemptCompletionEvidence {
  return {
    attemptId: "job_example_a0001",
    status: "completed",
    verificationStatus: "eligible",
    cleanupStatus: "proven",
    artifacts: {
      job: "job.json",
      manifest: "attempt.json",
      cleanup: "cleanup.json",
      stdout: "stdout.log",
      stderr: "stderr.log",
      proposalPatch: "proposal.patch",
      repositoryStatus: "repository-status.txt",
      changedPaths: "changed-paths.json",
      verification: "verification.json",
    },
    ...patch,
  };
}
