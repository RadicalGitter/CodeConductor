import type { AttemptManifest } from "../contracts/attempt.js";
import type { AttemptCleanupStatus } from "../contracts/cleanup.js";
import type { QueueItem, QueueItemStatus } from "../contracts/queue.js";

export interface AttemptCompletionEvidence {
  attemptId: string;
  status: AttemptManifest["status"];
  verificationStatus: AttemptManifest["verificationStatus"];
  cleanupStatus: AttemptCleanupStatus;
  artifacts: AttemptManifest["artifacts"];
  failure?: AttemptManifest["failure"];
}

export interface QueueCompletionProjection {
  status: QueueItemStatus;
  attemptId: string;
  completion: NonNullable<QueueItem["completion"]>;
  message?: string;
}

export function projectQueueCompletion(
  result: AttemptCompletionEvidence,
  finishedAt = new Date().toISOString(),
): QueueCompletionProjection {
  const cleanupSafe = ["not-required", "proven"].includes(result.cleanupStatus);
  const eligible =
    result.status === "completed" &&
    result.verificationStatus === "eligible" &&
    cleanupSafe;
  const needsInput =
    !cleanupSafe ||
    result.status === "needs-input" ||
    (result.status === "completed" && !eligible);
  const status: QueueItemStatus = !cleanupSafe
    ? "needs-input"
    : result.status === "cancelled"
      ? "cancelled"
      : eligible
        ? "completed"
        : needsInput
          ? "needs-input"
          : "failed";
  return {
    status,
    attemptId: result.attemptId,
    completion: {
      attemptId: result.attemptId,
      attemptStatus: result.status,
      verificationStatus: result.verificationStatus,
      cleanupStatus: result.cleanupStatus,
      finishedAt,
      artifacts: {
        manifest: result.artifacts.manifest,
        proposalPatch: result.artifacts.proposalPatch,
        changedPaths: result.artifacts.changedPaths,
        verification: result.artifacts.verification,
        cleanup: result.artifacts.cleanup,
      },
    },
    message:
      result.failure?.message ??
      (!cleanupSafe
        ? `Attempt cleanup is ${result.cleanupStatus}; retry and evidence removal are prohibited`
        : needsInput
          ? "Deterministic verification marked proposal ineligible"
          : undefined),
  };
}
