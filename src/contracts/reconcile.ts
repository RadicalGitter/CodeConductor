import { z } from "zod/v4";

import { dispatcherLeaseSchema } from "./queue.js";

export const leaseInspectionStateSchema = z.enum([
  "absent",
  "initializing",
  "active-local",
  "expired-live-local",
  "active-remote",
  "recoverable-dead-local",
  "incomplete",
  "corrupt",
]);

export type LeaseInspectionState = z.infer<typeof leaseInspectionStateSchema>;

export const leaseReconciliationActionProposalSchema = z.object({
  schema: z.literal("conductor.reconciliation-action-proposal/v1"),
  kind: z.literal("quarantine-unreadable-dispatcher-lease"),
  observedState: z.enum(["incomplete", "corrupt"]),
  evidenceToken: z.string().regex(/^[a-f0-9]{64}$/),
  requiredAuthority: z.literal("owner"),
  description: z.string().min(1).max(1_000),
});

const runtimeActionProposalBase = z.object({
  schema: z.literal("conductor.reconciliation-action-proposal/v2"),
  jobId: z.string().min(1),
  evidenceToken: z.string().regex(/^[a-f0-9]{64}$/),
  requiredAuthority: z.literal("owner"),
  description: z.string().min(1).max(1_000),
});

export const resetQueueItemActionProposalSchema =
  runtimeActionProposalBase.extend({
    kind: z.literal("reset-abandoned-queue-item"),
    expectedQueueRevision: z.number().int().nonnegative(),
    observedStatus: z.enum(["queued", "dispatching"]),
  });

export const quarantineQueueItemActionProposalSchema =
  runtimeActionProposalBase.extend({
    kind: z.literal("quarantine-queue-item"),
    expectedQueueRevision: z.number().int().nonnegative(),
    observedStatus: z.enum([
      "queued",
      "dispatching",
      "running",
      "cancelling",
      "completed",
      "failed",
      "needs-input",
      "cancelled",
    ]),
    observedAttemptId: z.string().min(1).optional(),
  });

export const bindQueueAttemptActionProposalSchema =
  runtimeActionProposalBase.extend({
    kind: z.literal("bind-queue-to-attempt"),
    expectedQueueRevision: z.number().int().nonnegative(),
    attemptId: z.string().min(1),
    expectedAttemptRevision: z.number().int().nonnegative(),
    dispatchOperationId: z.string().uuid(),
  });

export const synchronizeQueueActionProposalSchema =
  runtimeActionProposalBase.extend({
    kind: z.literal("synchronize-queue-from-terminal-attempt"),
    expectedQueueRevision: z.number().int().nonnegative(),
    attemptId: z.string().min(1),
    expectedAttemptRevision: z.number().int().nonnegative(),
    expectedCleanupRevision: z.number().int().nonnegative(),
  });

export const recoverAttemptActionProposalSchema =
  runtimeActionProposalBase.extend({
    kind: z.literal("recover-interrupted-attempt"),
    attemptId: z.string().min(1),
    expectedAttemptRevision: z.number().int().nonnegative(),
    expectedCleanupRevision: z.number().int().nonnegative(),
  });

export const runtimeReconciliationActionProposalSchema = z.discriminatedUnion(
  "kind",
  [
    resetQueueItemActionProposalSchema,
    quarantineQueueItemActionProposalSchema,
    bindQueueAttemptActionProposalSchema,
    synchronizeQueueActionProposalSchema,
    recoverAttemptActionProposalSchema,
  ],
);

export const runtimeReconciliationActionKindSchema = z.enum([
  "reset-abandoned-queue-item",
  "quarantine-queue-item",
  "bind-queue-to-attempt",
  "synchronize-queue-from-terminal-attempt",
  "recover-interrupted-attempt",
]);

export const reconciliationActionProposalSchema = z.union([
  leaseReconciliationActionProposalSchema,
  runtimeReconciliationActionProposalSchema,
]);

export type ReconciliationActionProposal = z.infer<
  typeof reconciliationActionProposalSchema
>;
export type RuntimeReconciliationActionProposal = z.infer<
  typeof runtimeReconciliationActionProposalSchema
>;

export const reconciliationActionSchema = z.object({
  schema: z.literal("conductor.reconciliation-action/v1"),
  proposal: reconciliationActionProposalSchema,
  approval: z.object({
    approvedBy: z.string().min(1).max(200),
    approvedAt: z.string().datetime(),
    reason: z.string().min(1).max(1_000),
  }),
});

export type ReconciliationAction = z.infer<typeof reconciliationActionSchema>;

export const leaseReconciliationActionSchema =
  reconciliationActionSchema.extend({
    proposal: leaseReconciliationActionProposalSchema,
  });

export type LeaseReconciliationAction = z.infer<
  typeof leaseReconciliationActionSchema
>;

export const reconciliationMutexSchema = z.object({
  schema: z.literal("conductor.reconciliation-mutex/v1"),
  instanceId: z.string().uuid(),
  hostname: z.string().min(1),
  processId: z.number().int().positive(),
  acquiredAt: z.string().datetime(),
});

export type ReconciliationMutex = z.infer<typeof reconciliationMutexSchema>;

export const reconciliationMutexEvidenceSchema = z.object({
  schema: z.literal("conductor.reconciliation-mutex-evidence/v1"),
  disposition: z.literal("recovered-dead-owner"),
  recordedAt: z.string().datetime(),
  mutex: reconciliationMutexSchema,
});

export const leaseInspectionSchema = z.object({
  schema: z.literal("conductor.lease-inspection/v1"),
  state: leaseInspectionStateSchema,
  observedAt: z.string().datetime(),
  lockDirectory: z.string().min(1),
  ageMs: z.number().int().nonnegative().optional(),
  evidenceToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  lease: dispatcherLeaseSchema.optional(),
  automaticAction: z.enum(["create", "wait", "recover-dead-owner", "none"]),
  detail: z.string().min(1),
  ownerAction: leaseReconciliationActionProposalSchema.optional(),
});

export type LeaseInspection = z.infer<typeof leaseInspectionSchema>;

export const leaseEvidenceRecordSchema = z.object({
  schema: z.literal("conductor.lease-evidence/v1"),
  evidenceId: z.string().uuid(),
  disposition: z.enum(["recovered-dead-owner", "owner-quarantined-unreadable"]),
  recordedAt: z.string().datetime(),
  originalState: leaseInspectionStateSchema,
  evidenceToken: z.string().regex(/^[a-f0-9]{64}$/),
  sourcePath: z.string().min(1),
  evidencePath: z.string().min(1),
  ownerReason: z.string().min(1).optional(),
  ownerApprovedBy: z.string().min(1).optional(),
  ownerApprovedAt: z.string().datetime().optional(),
  lease: dispatcherLeaseSchema.optional(),
});

export type LeaseEvidenceRecord = z.infer<typeof leaseEvidenceRecordSchema>;

export const runtimeReconciliationEvidenceSchema = z.object({
  schema: z.literal("conductor.runtime-reconciliation-evidence/v1"),
  evidenceId: z.string().uuid(),
  operationId: z.string().regex(/^[a-f0-9]{64}$/),
  actionKind: runtimeReconciliationActionKindSchema,
  disposition: z.enum(["applied", "blocked"]),
  recordedAt: z.string().datetime(),
  beforeEvidenceToken: z.string().regex(/^[a-f0-9]{64}$/),
  detail: z.string().min(1).max(4_000),
  actionPath: z.string().min(1),
  resultPath: z.string().min(1),
  queueRevision: z.number().int().nonnegative().optional(),
  attemptRevision: z.number().int().nonnegative().optional(),
  cleanupRevision: z.number().int().nonnegative().optional(),
});

export type RuntimeReconciliationEvidence = z.infer<
  typeof runtimeReconciliationEvidenceSchema
>;

export const reconciliationActionIntentSchema = z.object({
  schema: z.literal("conductor.reconciliation-action-intent/v1"),
  operationId: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.string().datetime(),
  action: reconciliationActionSchema,
});

export const reconciliationIssueSchema = z.object({
  issueId: z.string().regex(/^[a-f0-9]{16}$/),
  kind: z.enum([
    "lease-reconciliation-required",
    "queue-state-unreadable",
    "attempt-state-unreadable",
    "attempt-cleanup-unreadable",
    "attempt-cleanup-unresolved",
    "active-queue-missing-attempt",
    "queue-references-missing-attempt",
    "dispatch-operation-mismatch",
    "terminal-queue-nonterminal-attempt",
    "unreferenced-nonterminal-attempt",
    "queue-shape-invalid",
    "queue-attempt-job-mismatch",
    "queue-completion-mismatch",
    "active-queue-terminal-attempt",
    "ambiguous-dispatch-attempts",
    "inactive-owner-nonterminal-attempt",
  ]),
  severity: z.enum(["warning", "blocked"]),
  summary: z.string().min(1),
  jobId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  requiredAuthority: z.enum([
    "none",
    "wait-for-owner",
    "owner-action",
    "runtime-restart",
  ]),
  actionEvidenceToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export type ReconciliationIssue = z.infer<typeof reconciliationIssueSchema>;

export const runtimeReconciliationReportSchema = z.object({
  schema: z.literal("conductor.runtime-reconciliation/v1"),
  generatedAt: z.string().datetime(),
  dryRun: z.literal(true),
  lease: leaseInspectionSchema,
  issues: z.array(reconciliationIssueSchema),
  availableActions: z.array(reconciliationActionProposalSchema),
});

export type RuntimeReconciliationReport = z.infer<
  typeof runtimeReconciliationReportSchema
>;

export const reconciliationApplyResultSchema = z.object({
  schema: z.literal("conductor.reconciliation-result/v1"),
  action: reconciliationActionSchema,
  evidence: z.union([
    leaseEvidenceRecordSchema,
    runtimeReconciliationEvidenceSchema,
  ]),
  report: runtimeReconciliationReportSchema,
});

export type ReconciliationApplyResult = z.infer<
  typeof reconciliationApplyResultSchema
>;
