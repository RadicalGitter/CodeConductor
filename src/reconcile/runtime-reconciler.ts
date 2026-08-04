import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  reconciliationApplyResultSchema,
  reconciliationIssueSchema,
  reconciliationActionSchema,
  leaseReconciliationActionSchema,
  reconciliationActionIntentSchema,
  runtimeReconciliationActionProposalSchema,
  runtimeReconciliationEvidenceSchema,
  runtimeReconciliationReportSchema,
  type ReconciliationAction,
  type ReconciliationApplyResult,
  type ReconciliationIssue,
  type RuntimeReconciliationReport,
  type LeaseInspectionState,
  type RuntimeReconciliationActionProposal,
  type RuntimeReconciliationEvidence,
} from "../contracts/reconcile.js";
import { type AttemptManifest } from "../contracts/attempt.js";
import type { AttemptCleanupRecord } from "../contracts/cleanup.js";
import { type QueueItem } from "../contracts/queue.js";
import { Conductor } from "../orchestrator/conductor.js";
import {
  QueueStore,
  ReconciliationConflictError,
} from "../queue/queue-store.js";
import { projectQueueCompletion } from "../queue/completion.js";

export class RuntimeReconciler {
  constructor(
    readonly conductor: Conductor,
    readonly queue: QueueStore,
    readonly leaseMs: number,
    private readonly options: {
      actionFailpoint?: (
        point: "after-runtime-mutation",
        proposal: RuntimeReconciliationActionProposal,
      ) => void | Promise<void>;
    } = {},
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
    const cleanupByAttempt = new Map<string, AttemptCleanupRecord>();
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

    for (const attempt of attempts) {
      try {
        cleanupByAttempt.set(
          attempt.attemptId,
          await this.conductor.getAttemptCleanup(attempt.attemptId),
        );
      } catch (error) {
        issues.push(
          issue({
            kind: "attempt-cleanup-unreadable",
            severity: "blocked",
            summary: `Cleanup evidence for ${attempt.attemptId} could not be read: ${errorMessage(error)}`,
            jobId: attempt.jobId,
            attemptId: attempt.attemptId,
            requiredAuthority: "owner-action",
          }),
        );
      }
    }

    let relationshipActions: RuntimeReconciliationActionProposal[] = [];
    if (
      !issues.some((candidate) =>
        ["queue-state-unreadable", "attempt-state-unreadable"].includes(
          candidate.kind,
        ),
      )
    ) {
      const relationships = inspectQueueAttemptRelationships(
        items,
        attempts,
        cleanupByAttempt,
        lease.state,
      );
      issues.push(...relationships.issues);
      relationshipActions = relationships.availableActions;
      for (const attempt of attempts) {
        const cleanup = cleanupByAttempt.get(attempt.attemptId);
        if (!cleanup || ["not-required", "proven"].includes(cleanup.status)) {
          continue;
        }
        const activeOwner =
          !isAttemptTerminal(attempt.status) && isLeaseActive(lease.state);
        issues.push(
          issue({
            kind: "attempt-cleanup-unresolved",
            severity: activeOwner ? "warning" : "blocked",
            summary: `Attempt ${attempt.attemptId} cleanup is ${cleanup.status}; retry and evidence removal remain prohibited`,
            jobId: attempt.jobId,
            attemptId: attempt.attemptId,
            requiredAuthority: activeOwner ? "wait-for-owner" : "owner-action",
          }),
        );
      }
    }

    return runtimeReconciliationReportSchema.parse({
      schema: "conductor.runtime-reconciliation/v1",
      generatedAt: now.toISOString(),
      dryRun: true,
      lease,
      issues,
      availableActions: [
        ...(lease.ownerAction ? [lease.ownerAction] : []),
        ...relationshipActions,
      ],
    });
  }

  async apply(
    input: ReconciliationAction,
    now = new Date(),
  ): Promise<ReconciliationApplyResult> {
    const action = reconciliationActionSchema.parse(input);
    if (action.proposal.kind === "quarantine-unreadable-dispatcher-lease") {
      const leaseAction = leaseReconciliationActionSchema.parse(action);
      const evidence = await this.queue.quarantineUnreadableLease(
        leaseAction,
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
    const evidence = await this.applyRuntimeAction(action, now);
    return reconciliationApplyResultSchema.parse({
      schema: "conductor.reconciliation-result/v1",
      action,
      evidence,
      report: await this.inspect(now),
    });
  }

  private async applyRuntimeAction(
    action: ReconciliationAction,
    now: Date,
  ): Promise<RuntimeReconciliationEvidence> {
    const proposal = runtimeReconciliationActionProposalSchema.parse(
      action.proposal,
    );
    const operationId = createHash("sha256")
      .update(JSON.stringify(action))
      .digest("hex");
    const paths = await this.persistActionIntent(operationId, action, now);
    const replay = await readJsonIfExists(paths.resultPath);
    if (replay) return runtimeReconciliationEvidenceSchema.parse(replay);

    const offered = (await this.inspect(now)).availableActions.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(proposal),
    );
    if (!offered) {
      const current = await this.readRuntimeActionState(proposal);
      if (!(await this.runtimeActionPostcondition(proposal, current))) {
        throw new ReconciliationConflictError(
          `Runtime reconciliation action ${proposal.kind} is not offered for the current evidence`,
        );
      }
    }

    const leaseBefore = await this.queue.inspectLease(this.leaseMs, now);
    if (!["absent", "recoverable-dead-local"].includes(leaseBefore.state)) {
      throw new ReconciliationConflictError(
        `Runtime state reconciliation requires an unowned queue; lease is ${leaseBefore.state}`,
        true,
      );
    }
    const lease = await this.queue.acquireLease(
      `reconciliation-${operationId.slice(0, 16)}`,
      this.leaseMs,
      now,
    );
    if (!lease) {
      throw new ReconciliationConflictError(
        "A dispatcher acquired authority before the reconciliation action",
        true,
      );
    }

    try {
      const current = await this.readRuntimeActionState(proposal);
      let disposition: RuntimeReconciliationEvidence["disposition"];
      let detail: string;
      if (current.evidenceToken !== proposal.evidenceToken) {
        const recovered = await this.runtimeActionPostcondition(
          proposal,
          current,
        );
        if (!recovered) {
          throw new ReconciliationConflictError(
            `Runtime state changed after ${proposal.kind} was proposed`,
          );
        }
        disposition = recovered.disposition;
        detail = recovered.detail;
      } else {
        const applied = await this.executeRuntimeAction(proposal, current);
        disposition = applied.disposition;
        detail = applied.detail;
        await this.options.actionFailpoint?.(
          "after-runtime-mutation",
          proposal,
        );
      }
      const after = await this.readRuntimeActionState(proposal);
      const evidence = runtimeReconciliationEvidenceSchema.parse({
        schema: "conductor.runtime-reconciliation-evidence/v1",
        evidenceId: randomUUID(),
        operationId,
        actionKind: proposal.kind,
        disposition,
        recordedAt: new Date().toISOString(),
        beforeEvidenceToken: proposal.evidenceToken,
        detail,
        actionPath: paths.actionPath,
        resultPath: paths.resultPath,
        queueRevision: after.item?.revision,
        attemptRevision: after.attempt?.revision,
        cleanupRevision: after.cleanup?.revision,
      });
      await this.conductor.store.writeJsonAtomic(paths.resultPath, evidence);
      return evidence;
    } finally {
      await this.queue.releaseLease(lease);
    }
  }

  private async persistActionIntent(
    operationId: string,
    action: ReconciliationAction,
    now: Date,
  ): Promise<{ actionPath: string; resultPath: string }> {
    const root = path.join(this.queue.root, "reconciliation-actions");
    const directory = path.join(root, operationId);
    const actionPath = path.join(directory, "action.json");
    const resultPath = path.join(directory, "result.json");
    const staging = `${directory}.reserve-${process.pid}-${randomUUID()}`;
    const intent = reconciliationActionIntentSchema.parse({
      schema: "conductor.reconciliation-action-intent/v1",
      operationId,
      recordedAt: now.toISOString(),
      action,
    });
    await mkdir(root, { recursive: true });
    try {
      await mkdir(staging);
      await this.conductor.store.writeJsonAtomic(
        path.join(staging, "action.json"),
        intent,
      );
      await rename(staging, directory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      const existingRaw = await readJsonIfExists(actionPath);
      if (!existingRaw) throw error;
      const existing = reconciliationActionIntentSchema.parse(existingRaw);
      if (
        existing.operationId !== operationId ||
        JSON.stringify(existing.action) !== JSON.stringify(action)
      ) {
        throw new ReconciliationConflictError(
          `Reconciliation operation identity ${operationId} belongs to different evidence`,
        );
      }
    }
    return { actionPath, resultPath };
  }

  private async readRuntimeActionState(
    proposal: RuntimeReconciliationActionProposal,
  ): Promise<RuntimeActionState> {
    if (
      proposal.kind === "reset-abandoned-queue-item" ||
      proposal.kind === "quarantine-queue-item"
    ) {
      const item = await this.queue.read(proposal.jobId);
      return {
        item,
        evidenceToken: stateEvidenceToken(proposal.kind, { item }),
      };
    }
    if (proposal.kind === "bind-queue-to-attempt") {
      const [item, attempt] = await Promise.all([
        this.queue.read(proposal.jobId),
        this.conductor.getAttempt(proposal.attemptId),
      ]);
      return {
        item,
        attempt,
        evidenceToken: stateEvidenceToken(proposal.kind, { item, attempt }),
      };
    }
    if (proposal.kind === "synchronize-queue-from-terminal-attempt") {
      const [item, attempt, cleanup] = await Promise.all([
        this.queue.read(proposal.jobId),
        this.conductor.getAttempt(proposal.attemptId),
        this.conductor.getAttemptCleanup(proposal.attemptId),
      ]);
      return {
        item,
        attempt,
        cleanup,
        evidenceToken: stateEvidenceToken(proposal.kind, {
          item,
          attempt,
          cleanup,
        }),
      };
    }
    const [attempt, cleanup] = await Promise.all([
      this.conductor.getAttempt(proposal.attemptId),
      this.conductor.getAttemptCleanup(proposal.attemptId),
    ]);
    return {
      attempt,
      cleanup,
      evidenceToken: stateEvidenceToken(proposal.kind, { attempt, cleanup }),
    };
  }

  private async executeRuntimeAction(
    proposal: RuntimeReconciliationActionProposal,
    state: RuntimeActionState,
  ): Promise<{
    disposition: RuntimeReconciliationEvidence["disposition"];
    detail: string;
  }> {
    if (proposal.kind === "reset-abandoned-queue-item") {
      await this.queue.reconcile(
        requiredItem(state),
        {
          status: "queued",
          dispatchOperationId: undefined,
          attemptId: undefined,
          completion: undefined,
          message:
            "Owner-approved reconciliation cleared abandoned dispatch evidence",
        },
        proposal.kind,
      );
      return {
        disposition: "applied",
        detail: `Queue item ${proposal.jobId} returned to queued without inventing an attempt`,
      };
    }
    if (proposal.kind === "quarantine-queue-item") {
      await this.queue.reconcile(
        requiredItem(state),
        {
          status: "needs-input",
          dispatchOperationId: undefined,
          attemptId: undefined,
          completion: undefined,
          message:
            "Owner-approved reconciliation quarantined an untrusted queue-to-attempt relationship",
        },
        proposal.kind,
      );
      return {
        disposition: "applied",
        detail: `Queue item ${proposal.jobId} quarantined; prior relationship remains in its revision journal`,
      };
    }
    if (proposal.kind === "bind-queue-to-attempt") {
      await this.queue.reconcile(
        requiredItem(state),
        {
          status: "running",
          dispatchOperationId: proposal.dispatchOperationId,
          attemptId: proposal.attemptId,
          completion: undefined,
          message:
            "Owner-approved reconciliation restored the exact dispatch binding",
        },
        proposal.kind,
      );
      return {
        disposition: "applied",
        detail: `Queue item ${proposal.jobId} rebound to ${proposal.attemptId}`,
      };
    }
    if (proposal.kind === "synchronize-queue-from-terminal-attempt") {
      const item = requiredItem(state);
      const attempt = requiredAttempt(state);
      const cleanup = requiredCleanup(state);
      if (!isAttemptTerminal(attempt.status)) {
        throw new ReconciliationConflictError(
          `Attempt ${attempt.attemptId} is no longer terminal`,
        );
      }
      await this.queue.reconcile(
        item,
        projectQueueCompletion({
          attemptId: attempt.attemptId,
          status: attempt.status,
          verificationStatus: attempt.verificationStatus,
          cleanupStatus: cleanup.status,
          artifacts: attempt.artifacts,
          failure: attempt.failure,
        }),
        proposal.kind,
      );
      return {
        disposition: "applied",
        detail: `Queue item ${proposal.jobId} synchronized from immutable attempt and cleanup evidence`,
      };
    }

    const recovery = await this.conductor.recoverInterruptedAttempt(
      proposal.attemptId,
    );
    const cleanup = await this.conductor.getAttemptCleanup(proposal.attemptId);
    const safe = ["not-required", "proven"].includes(cleanup.status);
    if (
      ["terminal", "safe-to-retry"].includes(recovery.disposition) &&
      isAttemptTerminal(recovery.manifest.status) &&
      safe
    ) {
      return {
        disposition: "applied",
        detail: `Attempt ${proposal.attemptId} is terminal with ${cleanup.status} cleanup`,
      };
    }
    return {
      disposition: "blocked",
      detail:
        recovery.disposition === "still-running"
          ? `Attempt ${proposal.attemptId} still has a live process owner; retry remains prohibited`
          : `Attempt ${proposal.attemptId} cleanup is ${cleanup.status}; additional process or resource absence evidence is required`,
    };
  }

  private async runtimeActionPostcondition(
    proposal: RuntimeReconciliationActionProposal,
    state: RuntimeActionState,
  ): Promise<
    | {
        disposition: RuntimeReconciliationEvidence["disposition"];
        detail: string;
      }
    | undefined
  > {
    if (proposal.kind === "reset-abandoned-queue-item") {
      const item = requiredItem(state);
      return item.status === "queued" &&
        !item.dispatchOperationId &&
        !item.attemptId &&
        !item.completion
        ? {
            disposition: "applied",
            detail: `Recovered completed reset of queue item ${item.jobId}`,
          }
        : undefined;
    }
    if (proposal.kind === "quarantine-queue-item") {
      const item = requiredItem(state);
      return item.status === "needs-input" &&
        !item.dispatchOperationId &&
        !item.attemptId &&
        !item.completion
        ? {
            disposition: "applied",
            detail: `Recovered completed quarantine of queue item ${item.jobId}`,
          }
        : undefined;
    }
    if (proposal.kind === "bind-queue-to-attempt") {
      const item = requiredItem(state);
      return item.status === "running" &&
        item.attemptId === proposal.attemptId &&
        item.dispatchOperationId === proposal.dispatchOperationId
        ? {
            disposition: "applied",
            detail: `Recovered completed binding of ${item.jobId} to ${proposal.attemptId}`,
          }
        : undefined;
    }
    if (proposal.kind === "synchronize-queue-from-terminal-attempt") {
      const item = requiredItem(state);
      const attempt = requiredAttempt(state);
      const cleanup = requiredCleanup(state);
      return isAttemptTerminal(attempt.status) &&
        queueMatchesAttempt(item, attempt, cleanup)
        ? {
            disposition: "applied",
            detail: `Recovered completed queue synchronization for ${item.jobId}`,
          }
        : undefined;
    }
    const attempt = requiredAttempt(state);
    const cleanup = requiredCleanup(state);
    if (isAttemptTerminal(attempt.status)) {
      return ["not-required", "proven"].includes(cleanup.status)
        ? {
            disposition: "applied",
            detail: `Recovered terminal orphan repair for ${attempt.attemptId}`,
          }
        : {
            disposition: "blocked",
            detail: `Attempt ${attempt.attemptId} is terminal but cleanup is ${cleanup.status}`,
          };
    }
    if (cleanup.revision !== proposal.expectedCleanupRevision) {
      return {
        disposition: "blocked",
        detail: `Attempt ${attempt.attemptId} remains nonterminal and cleanup is ${cleanup.status}`,
      };
    }
    return undefined;
  }
}

export function inspectQueueAttemptRelationships(
  items: QueueItem[],
  attempts: AttemptManifest[],
  cleanupByAttempt: Map<string, AttemptCleanupRecord>,
  leaseState: LeaseInspectionState,
): {
  issues: ReconciliationIssue[];
  availableActions: RuntimeReconciliationActionProposal[];
} {
  const issues: ReconciliationIssue[] = [];
  const availableActions = new Map<
    string,
    RuntimeReconciliationActionProposal
  >();
  const attemptsById = new Map(
    attempts.map((attempt) => [attempt.attemptId, attempt]),
  );
  const attemptsByOperation = new Map<string, AttemptManifest[]>();
  for (const attempt of attempts) {
    if (!attempt.dispatchOperationId) continue;
    const key = dispatchKey(attempt.jobId, attempt.dispatchOperationId);
    const matches = attemptsByOperation.get(key) ?? [];
    matches.push(attempt);
    attemptsByOperation.set(key, matches);
  }
  const referenced = new Set<string>();
  const ownerCanAct = ["absent", "recoverable-dead-local"].includes(leaseState);
  const inactiveAuthority =
    isLeaseActive(leaseState) || leaseState === "initializing"
      ? "wait-for-owner"
      : "owner-action";

  const report = (
    input: Omit<ReconciliationIssue, "issueId" | "actionEvidenceToken">,
    action?: RuntimeReconciliationActionProposal,
  ) => {
    const offered = ownerCanAct ? action : undefined;
    if (offered) availableActions.set(offered.evidenceToken, offered);
    issues.push(
      issue({
        ...input,
        requiredAuthority: offered ? "owner-action" : input.requiredAuthority,
        actionEvidenceToken: offered?.evidenceToken,
      }),
    );
  };

  for (const item of items) {
    if (
      item.status === "queued" &&
      (item.dispatchOperationId || item.attemptId || item.completion)
    ) {
      report(
        {
          kind: "queue-shape-invalid",
          severity: "blocked",
          summary: `Queued item ${item.jobId} retains dispatch, attempt, or completion state`,
          jobId: item.jobId,
          attemptId: item.attemptId,
          requiredAuthority: inactiveAuthority,
        },
        resetQueueAction(item),
      );
      continue;
    }

    if (item.status === "dispatching" && !item.dispatchOperationId) {
      report(
        {
          kind: "queue-shape-invalid",
          severity: "blocked",
          summary: `Dispatching item ${item.jobId} lacks a durable operation identity`,
          jobId: item.jobId,
          attemptId: item.attemptId,
          requiredAuthority: inactiveAuthority,
        },
        quarantineQueueAction(item),
      );
      continue;
    }

    if (["running", "cancelling"].includes(item.status) && !item.attemptId) {
      report(
        {
          kind: "queue-references-missing-attempt",
          severity: "blocked",
          summary: `Queue item ${item.jobId} is ${item.status} without an attempt identity`,
          jobId: item.jobId,
          requiredAuthority: inactiveAuthority,
        },
        quarantineQueueAction(item),
      );
      continue;
    }

    if (item.status === "dispatching" && !item.attemptId) {
      const matching =
        attemptsByOperation.get(
          dispatchKey(item.jobId, item.dispatchOperationId!),
        ) ?? [];
      if (matching.length === 0) {
        report(
          {
            kind: "queue-references-missing-attempt",
            severity: "blocked",
            summary: `Dispatch intent ${item.dispatchOperationId} for ${item.jobId} has no reserved attempt`,
            jobId: item.jobId,
            requiredAuthority: inactiveAuthority,
          },
          resetQueueAction(item),
        );
      } else if (matching.length === 1) {
        const attempt = matching[0]!;
        referenced.add(attempt.attemptId);
        const cleanup = cleanupByAttempt.get(attempt.attemptId);
        report(
          {
            kind: "queue-shape-invalid",
            severity: "blocked",
            summary: `Dispatching item ${item.jobId} can be rebound to ${attempt.attemptId} from its exact operation identity`,
            jobId: item.jobId,
            attemptId: attempt.attemptId,
            requiredAuthority: inactiveAuthority,
          },
          isAttemptTerminal(attempt.status)
            ? cleanup
              ? synchronizeQueueAction(item, attempt, cleanup)
              : undefined
            : bindQueueAction(item, attempt),
        );
      } else {
        report(
          {
            kind: "ambiguous-dispatch-attempts",
            severity: "blocked",
            summary: `Dispatch operation ${item.dispatchOperationId} for ${item.jobId} owns ${matching.length} attempts`,
            jobId: item.jobId,
            requiredAuthority: inactiveAuthority,
          },
          quarantineQueueAction(item),
        );
      }
      continue;
    }

    if (!item.attemptId) {
      if (item.status === "completed" || item.completion) {
        report(
          {
            kind: "queue-completion-mismatch",
            severity: "blocked",
            summary: `Terminal queue item ${item.jobId} has completion state without an attempt identity`,
            jobId: item.jobId,
            requiredAuthority: inactiveAuthority,
          },
          quarantineQueueAction(item),
        );
      }
      continue;
    }

    const attempt = attemptsById.get(item.attemptId);
    if (!attempt) {
      report(
        {
          kind: "active-queue-missing-attempt",
          severity: "blocked",
          summary: `Queue item ${item.jobId} references missing attempt ${item.attemptId}`,
          jobId: item.jobId,
          attemptId: item.attemptId,
          requiredAuthority: inactiveAuthority,
        },
        quarantineQueueAction(item),
      );
      continue;
    }

    if (attempt.jobId !== item.jobId) {
      report(
        {
          kind: "queue-attempt-job-mismatch",
          severity: "blocked",
          summary: `Queue item ${item.jobId} references attempt ${attempt.attemptId} owned by ${attempt.jobId}`,
          jobId: item.jobId,
          attemptId: attempt.attemptId,
          requiredAuthority: inactiveAuthority,
        },
        quarantineQueueAction(item),
      );
      continue;
    }

    if (
      item.dispatchOperationId !== attempt.dispatchOperationId &&
      (item.dispatchOperationId || attempt.dispatchOperationId)
    ) {
      report(
        {
          kind: "dispatch-operation-mismatch",
          severity: "blocked",
          summary: `Queue item ${item.jobId} and attempt ${attempt.attemptId} have different dispatch operation identities`,
          jobId: item.jobId,
          attemptId: attempt.attemptId,
          requiredAuthority: inactiveAuthority,
        },
        quarantineQueueAction(item),
      );
      if (isQueueTerminal(item.status) && !isAttemptTerminal(attempt.status)) {
        const cleanup = cleanupByAttempt.get(attempt.attemptId);
        report(
          {
            kind: "terminal-queue-nonterminal-attempt",
            severity: "blocked",
            summary: `Terminal queue item ${item.jobId} references nonterminal attempt ${attempt.attemptId} (${attempt.status})`,
            jobId: item.jobId,
            attemptId: attempt.attemptId,
            requiredAuthority: inactiveAuthority,
          },
          cleanup ? recoverAttemptAction(attempt, cleanup) : undefined,
        );
      }
      continue;
    }

    referenced.add(attempt.attemptId);
    const cleanup = cleanupByAttempt.get(attempt.attemptId);

    if (item.status === "dispatching") {
      report(
        {
          kind: "queue-shape-invalid",
          severity: "blocked",
          summary: `Dispatching item ${item.jobId} already names attempt ${attempt.attemptId} but has not advanced`,
          jobId: item.jobId,
          attemptId: attempt.attemptId,
          requiredAuthority: inactiveAuthority,
        },
        isAttemptTerminal(attempt.status)
          ? cleanup
            ? synchronizeQueueAction(item, attempt, cleanup)
            : undefined
          : bindQueueAction(item, attempt),
      );
      continue;
    }

    if (["running", "cancelling"].includes(item.status)) {
      if (isAttemptTerminal(attempt.status)) {
        report(
          {
            kind: "active-queue-terminal-attempt",
            severity: "blocked",
            summary: `Active queue item ${item.jobId} references terminal attempt ${attempt.attemptId} (${attempt.status})`,
            jobId: item.jobId,
            attemptId: attempt.attemptId,
            requiredAuthority: inactiveAuthority,
          },
          cleanup ? synchronizeQueueAction(item, attempt, cleanup) : undefined,
        );
      } else if (!isLeaseActive(leaseState)) {
        report(
          {
            kind: "inactive-owner-nonterminal-attempt",
            severity: "blocked",
            summary: `Queue item ${item.jobId} references nonterminal attempt ${attempt.attemptId} without an active dispatcher owner`,
            jobId: item.jobId,
            attemptId: attempt.attemptId,
            requiredAuthority: inactiveAuthority,
          },
          cleanup ? recoverAttemptAction(attempt, cleanup) : undefined,
        );
      }
      continue;
    }

    if (isQueueTerminal(item.status) && !isAttemptTerminal(attempt.status)) {
      report(
        {
          kind: "terminal-queue-nonterminal-attempt",
          severity: "blocked",
          summary: `Terminal queue item ${item.jobId} references nonterminal attempt ${attempt.attemptId} (${attempt.status})`,
          jobId: item.jobId,
          attemptId: attempt.attemptId,
          requiredAuthority: inactiveAuthority,
        },
        cleanup ? recoverAttemptAction(attempt, cleanup) : undefined,
      );
      continue;
    }

    if (
      isQueueTerminal(item.status) &&
      isAttemptTerminal(attempt.status) &&
      cleanup &&
      !queueMatchesAttempt(item, attempt, cleanup)
    ) {
      report(
        {
          kind: "queue-completion-mismatch",
          severity: "blocked",
          summary: `Queue completion for ${item.jobId} does not match terminal attempt ${attempt.attemptId} and cleanup revision ${cleanup.revision}`,
          jobId: item.jobId,
          attemptId: attempt.attemptId,
          requiredAuthority: inactiveAuthority,
        },
        synchronizeQueueAction(item, attempt, cleanup),
      );
    }
  }

  for (const attempt of attempts) {
    if (isAttemptTerminal(attempt.status) || referenced.has(attempt.attemptId))
      continue;
    const activeOwner = isLeaseActive(leaseState);
    const cleanup = cleanupByAttempt.get(attempt.attemptId);
    report(
      {
        kind: "unreferenced-nonterminal-attempt",
        severity: activeOwner ? "warning" : "blocked",
        summary: `Nonterminal attempt ${attempt.attemptId} (${attempt.status}) is not referenced by a queue item`,
        jobId: attempt.jobId,
        attemptId: attempt.attemptId,
        requiredAuthority: activeOwner ? "wait-for-owner" : "owner-action",
      },
      cleanup ? recoverAttemptAction(attempt, cleanup) : undefined,
    );
  }
  return {
    issues,
    availableActions: [...availableActions.values()].sort((left, right) =>
      left.evidenceToken.localeCompare(right.evidenceToken),
    ),
  };
}

function resetQueueAction(
  item: QueueItem,
): RuntimeReconciliationActionProposal {
  return {
    schema: "conductor.reconciliation-action-proposal/v2",
    kind: "reset-abandoned-queue-item",
    jobId: item.jobId,
    expectedQueueRevision: item.revision,
    observedStatus: item.status === "queued" ? "queued" : "dispatching",
    evidenceToken: stateEvidenceToken("reset-abandoned-queue-item", { item }),
    requiredAuthority: "owner",
    description: `Clear stale dispatch evidence and return queue item ${item.jobId} to queued`,
  };
}

function quarantineQueueAction(
  item: QueueItem,
): RuntimeReconciliationActionProposal {
  return {
    schema: "conductor.reconciliation-action-proposal/v2",
    kind: "quarantine-queue-item",
    jobId: item.jobId,
    expectedQueueRevision: item.revision,
    observedStatus: item.status,
    observedAttemptId: item.attemptId,
    evidenceToken: stateEvidenceToken("quarantine-queue-item", { item }),
    requiredAuthority: "owner",
    description: `Move queue item ${item.jobId} to needs-input and clear its untrusted attempt binding`,
  };
}

function bindQueueAction(
  item: QueueItem,
  attempt: AttemptManifest,
): RuntimeReconciliationActionProposal {
  return {
    schema: "conductor.reconciliation-action-proposal/v2",
    kind: "bind-queue-to-attempt",
    jobId: item.jobId,
    expectedQueueRevision: item.revision,
    attemptId: attempt.attemptId,
    expectedAttemptRevision: attempt.revision,
    dispatchOperationId: item.dispatchOperationId!,
    evidenceToken: stateEvidenceToken("bind-queue-to-attempt", {
      item,
      attempt,
    }),
    requiredAuthority: "owner",
    description: `Bind queue item ${item.jobId} to attempt ${attempt.attemptId} using their exact dispatch identity`,
  };
}

function synchronizeQueueAction(
  item: QueueItem,
  attempt: AttemptManifest,
  cleanup: AttemptCleanupRecord,
): RuntimeReconciliationActionProposal {
  return {
    schema: "conductor.reconciliation-action-proposal/v2",
    kind: "synchronize-queue-from-terminal-attempt",
    jobId: item.jobId,
    expectedQueueRevision: item.revision,
    attemptId: attempt.attemptId,
    expectedAttemptRevision: attempt.revision,
    expectedCleanupRevision: cleanup.revision,
    evidenceToken: stateEvidenceToken(
      "synchronize-queue-from-terminal-attempt",
      { item, attempt, cleanup },
    ),
    requiredAuthority: "owner",
    description: `Derive queue completion for ${item.jobId} from immutable attempt ${attempt.attemptId} and cleanup evidence`,
  };
}

function recoverAttemptAction(
  attempt: AttemptManifest,
  cleanup: AttemptCleanupRecord,
): RuntimeReconciliationActionProposal {
  return {
    schema: "conductor.reconciliation-action-proposal/v2",
    kind: "recover-interrupted-attempt",
    jobId: attempt.jobId,
    attemptId: attempt.attemptId,
    expectedAttemptRevision: attempt.revision,
    expectedCleanupRevision: cleanup.revision,
    evidenceToken: stateEvidenceToken("recover-interrupted-attempt", {
      attempt,
      cleanup,
    }),
    requiredAuthority: "owner",
    description: `Run evidence-gated orphan recovery for attempt ${attempt.attemptId}; unresolved process or resource ownership remains quarantined`,
  };
}

function queueMatchesAttempt(
  item: QueueItem,
  attempt: AttemptManifest,
  cleanup: AttemptCleanupRecord,
): boolean {
  const expected = projectQueueCompletion(
    {
      attemptId: attempt.attemptId,
      status: attempt.status,
      verificationStatus: attempt.verificationStatus,
      cleanupStatus: cleanup.status,
      artifacts: attempt.artifacts,
      failure: attempt.failure,
    },
    item.completion?.finishedAt ?? attempt.finishedAt ?? attempt.createdAt,
  );
  return (
    item.status === expected.status &&
    item.attemptId === expected.attemptId &&
    Boolean(item.completion) &&
    item.completion?.attemptId === expected.completion.attemptId &&
    item.completion?.attemptStatus === expected.completion.attemptStatus &&
    item.completion?.verificationStatus ===
      expected.completion.verificationStatus &&
    item.completion?.cleanupStatus === expected.completion.cleanupStatus &&
    JSON.stringify(item.completion?.artifacts) ===
      JSON.stringify(expected.completion.artifacts)
  );
}

export function stateEvidenceToken(
  kind: RuntimeReconciliationActionProposal["kind"],
  state: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, state }))
    .digest("hex");
}

interface RuntimeActionState {
  item?: QueueItem;
  attempt?: AttemptManifest;
  cleanup?: AttemptCleanupRecord;
  evidenceToken: string;
}

function requiredItem(state: RuntimeActionState): QueueItem {
  if (!state.item) throw new Error("Reconciliation queue evidence is missing");
  return state.item;
}

function requiredAttempt(state: RuntimeActionState): AttemptManifest {
  if (!state.attempt)
    throw new Error("Reconciliation attempt evidence is missing");
  return state.attempt;
}

function requiredCleanup(state: RuntimeActionState): AttemptCleanupRecord {
  if (!state.cleanup)
    throw new Error("Reconciliation cleanup evidence is missing");
  return state.cleanup;
}

async function readJsonIfExists(target: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function dispatchKey(jobId: string, operationId: string): string {
  return `${jobId}\0${operationId}`;
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
