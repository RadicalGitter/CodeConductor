import { createHash } from "node:crypto";

import {
  reconciliationApplyResultSchema,
  reconciliationIssueSchema,
  reconciliationActionSchema,
  runtimeReconciliationReportSchema,
  type ReconciliationAction,
  type ReconciliationApplyResult,
  type ReconciliationIssue,
  type RuntimeReconciliationReport,
  type LeaseInspectionState,
} from "../contracts/reconcile.js";
import { type AttemptManifest } from "../contracts/attempt.js";
import { type QueueItem } from "../contracts/queue.js";
import { Conductor } from "../orchestrator/conductor.js";
import { QueueStore } from "../queue/queue-store.js";

export class RuntimeReconciler {
  constructor(
    readonly conductor: Conductor,
    readonly queue: QueueStore,
    readonly leaseMs: number,
  ) {}

  async inspect(now = new Date()): Promise<RuntimeReconciliationReport> {
    const lease = await this.queue.inspectLease(this.leaseMs, now);
    const issues: ReconciliationIssue[] = [];
    if (["corrupt", "incomplete"].includes(lease.state)) {
      issues.push(
        issue({
          kind: "lease-reconciliation-required",
          severity: "blocked",
          summary: lease.detail,
          requiredAuthority: lease.ownerAction
            ? "owner-action"
            : "wait-for-owner",
        }),
      );
    }

    let items: QueueItem[] = [];
    try {
      items = await this.queue.list();
    } catch (error) {
      issues.push(
        issue({
          kind: "queue-state-unreadable",
          severity: "blocked",
          summary: `Queue state could not be enumerated: ${errorMessage(error)}`,
          requiredAuthority: "owner-action",
        }),
      );
    }

    let attempts: AttemptManifest[] = [];
    try {
      attempts = await this.conductor.listAttempts();
    } catch (error) {
      issues.push(
        issue({
          kind: "attempt-state-unreadable",
          severity: "blocked",
          summary: `Attempt state could not be enumerated: ${errorMessage(error)}`,
          requiredAuthority: "owner-action",
        }),
      );
    }

    if (
      !issues.some((candidate) =>
        ["queue-state-unreadable", "attempt-state-unreadable"].includes(
          candidate.kind,
        ),
      )
    ) {
      issues.push(
        ...inspectQueueAttemptRelationships(items, attempts, lease.state),
      );
    }

    return runtimeReconciliationReportSchema.parse({
      schema: "conductor.runtime-reconciliation/v1",
      generatedAt: now.toISOString(),
      dryRun: true,
      lease,
      issues,
      availableActions: lease.ownerAction ? [lease.ownerAction] : [],
    });
  }

  async apply(
    input: ReconciliationAction,
    now = new Date(),
  ): Promise<ReconciliationApplyResult> {
    const action = reconciliationActionSchema.parse(input);
    const evidence = await this.queue.quarantineUnreadableLease(
      action,
      this.leaseMs,
      now,
    );
    return reconciliationApplyResultSchema.parse({
      schema: "conductor.reconciliation-result/v1",
      action,
      evidence,
      report: await this.inspect(now),
    });
  }
}

function inspectQueueAttemptRelationships(
  items: QueueItem[],
  attempts: AttemptManifest[],
  leaseState: LeaseInspectionState,
): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  const attemptsById = new Map(
    attempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  const referenced = new Set<string>();

  for (const item of items) {
    if (["running", "cancelling"].includes(item.status) && !item.attemptId) {
      issues.push(
        issue({
          kind: "queue-references-missing-attempt",
          severity: "blocked",
          summary: `Queue item ${item.jobId} is ${item.status} without an attempt identity`,
          jobId: item.jobId,
          requiredAuthority: "runtime-restart",
        }),
      );
      continue;
    }
    if (!item.attemptId) continue;
    referenced.add(item.attemptId);
    const attempt = attemptsById.get(item.attemptId);
    if (!attempt) {
      issues.push(
        issue({
          kind: "active-queue-missing-attempt",
          severity: "blocked",
          summary: `Queue item ${item.jobId} references missing attempt ${item.attemptId}`,
          jobId: item.jobId,
          attemptId: item.attemptId,
          requiredAuthority: "owner-action",
        }),
      );
      continue;
    }
    if (
      item.dispatchOperationId &&
      attempt.dispatchOperationId &&
      item.dispatchOperationId !== attempt.dispatchOperationId
    ) {
      issues.push(
        issue({
          kind: "dispatch-operation-mismatch",
          severity: "blocked",
          summary: `Queue item ${item.jobId} and attempt ${attempt.attemptId} have different dispatch operation identities`,
          jobId: item.jobId,
          attemptId: attempt.attemptId,
          requiredAuthority: "owner-action",
        }),
      );
    }
    if (isQueueTerminal(item.status) && !isAttemptTerminal(attempt.status)) {
      issues.push(
        issue({
          kind: "terminal-queue-nonterminal-attempt",
          severity: "blocked",
          summary: `Terminal queue item ${item.jobId} references nonterminal attempt ${attempt.attemptId} (${attempt.status})`,
          jobId: item.jobId,
          attemptId: attempt.attemptId,
          requiredAuthority: "owner-action",
        }),
      );
    }
  }

  for (const attempt of attempts) {
    if (isAttemptTerminal(attempt.status) || referenced.has(attempt.attemptId))
      continue;
    issues.push(
      issue({
        kind: "unreferenced-nonterminal-attempt",
        severity:
          attempt.status === "reserved" && isLeaseActive(leaseState)
            ? "warning"
            : "blocked",
        summary: `Nonterminal attempt ${attempt.attemptId} (${attempt.status}) is not referenced by a queue item`,
        jobId: attempt.jobId,
        attemptId: attempt.attemptId,
        requiredAuthority:
          attempt.status === "reserved" && isLeaseActive(leaseState)
            ? "wait-for-owner"
            : ["reserved", "claimed"].includes(attempt.status)
              ? "runtime-restart"
              : "owner-action",
      }),
    );
  }
  return issues;
}

function isLeaseActive(state: LeaseInspectionState): boolean {
  return ["active-local", "expired-live-local", "active-remote"].includes(
    state,
  );
}

function issue(
  input: Omit<ReconciliationIssue, "issueId">,
): ReconciliationIssue {
  const issueId = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
  return reconciliationIssueSchema.parse({ issueId, ...input });
}

function isQueueTerminal(status: QueueItem["status"]): boolean {
  return ["completed", "failed", "needs-input", "cancelled"].includes(status);
}

function isAttemptTerminal(status: AttemptManifest["status"]): boolean {
  return ["completed", "failed", "needs-input", "cancelled"].includes(status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
