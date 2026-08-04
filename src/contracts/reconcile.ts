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

export const reconciliationActionProposalSchema = z.object({
  schema: z.literal("conductor.reconciliation-action-proposal/v1"),
  kind: z.literal("quarantine-unreadable-dispatcher-lease"),
  observedState: z.enum(["incomplete", "corrupt"]),
  evidenceToken: z.string().regex(/^[a-f0-9]{64}$/),
  requiredAuthority: z.literal("owner"),
  description: z.string().min(1).max(1_000),
});

export type ReconciliationActionProposal = z.infer<
  typeof reconciliationActionProposalSchema
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
  ownerAction: reconciliationActionProposalSchema.optional(),
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
  evidence: leaseEvidenceRecordSchema,
  report: runtimeReconciliationReportSchema,
});

export type ReconciliationApplyResult = z.infer<
  typeof reconciliationApplyResultSchema
>;
