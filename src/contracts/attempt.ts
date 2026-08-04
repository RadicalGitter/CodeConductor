import { z } from "zod/v4";

export const attemptStatusSchema = z.enum([
  "reserved",
  "preparing",
  "running",
  "verifying",
  "completed",
  "failed",
  "needs-input",
  "cancelled",
]);

export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const processGuardianIdentitySchema = z.object({
  schema: z.literal("conductor.process-guardian/v1"),
  nonce: z.string().uuid(),
  guardianPid: z.number().int().positive(),
  parentPid: z.number().int().positive(),
  createdAt: z.string().datetime(),
  workerPid: z.number().int().positive().optional(),
});

export const proposalContributionSchema = z.object({
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  jobRequestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceBaseRevision: z.string().regex(/^[a-f0-9]{40,64}$/i),
  patchBaseRevision: z.string().regex(/^[a-f0-9]{40,64}$/i),
  patchPath: z.string().min(1),
  patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
  patchBytes: z.number().int().nonnegative(),
  verificationPath: z.string().min(1),
  verificationSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const proposalLineageSchema = z.object({
  schema: z.literal("conductor.proposal-lineage/v1"),
  sourceBaseRevision: z.string().regex(/^[a-f0-9]{40,64}$/i),
  directParentAttemptIds: z.array(z.string().min(1)).min(1).max(256),
  contributions: z.array(proposalContributionSchema).min(1).max(256),
  status: z.enum(["pending", "composed", "rejected"]),
  derivedRevision: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/i)
    .optional(),
  composedAt: z.string().datetime().optional(),
  failure: z.string().min(1).optional(),
});

export type ProposalContribution = z.infer<typeof proposalContributionSchema>;
export type ProposalLineage = z.infer<typeof proposalLineageSchema>;

export const failureKindSchema = z.enum([
  "invalid-job",
  "adapter-unavailable",
  "workspace-failed",
  "setup-failed",
  "spawn-failed",
  "worker-exit",
  "proposal-capture-failed",
  "timeout",
  "cancelled",
  "orphaned",
  "composition-failed",
  "orchestrator-error",
]);

export const attemptManifestSchema = z.object({
  schema: z.literal("conductor.attempt/v1"),
  attemptId: z.string().min(1),
  jobId: z.string().min(1),
  ordinal: z.number().int().positive(),
  adapterId: z.string().min(1),
  status: attemptStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  workspace: z
    .object({
      path: z.string().min(1),
      baseRevision: z.string().min(1),
      retained: z.boolean(),
    })
    .optional(),
  guardian: processGuardianIdentitySchema.optional(),
  lineage: proposalLineageSchema.optional(),
  invocation: z
    .object({
      executable: z.string().min(1),
      args: z.array(z.string()),
      cwd: z.string().min(1),
      environmentKeys: z.array(z.string()),
    })
    .optional(),
  process: z
    .object({
      pid: z.number().int().positive().optional(),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      timedOut: z.boolean(),
      cancelled: z.boolean(),
      durationMs: z.number().int().nonnegative(),
    })
    .optional(),
  artifacts: z.object({
    job: z.string().min(1),
    manifest: z.string().min(1),
    stdout: z.string().min(1),
    stderr: z.string().min(1),
    proposalPatch: z.string().min(1),
    repositoryStatus: z.string().min(1),
    changedPaths: z.string().min(1),
    verification: z.string().min(1),
  }),
  failure: z
    .object({
      kind: failureKindSchema,
      message: z.string().min(1),
    })
    .optional(),
  cleanupError: z.string().min(1).optional(),
  reviewDisposition: z
    .enum(["not-requested", "pending", "accepted", "rejected", "superseded"])
    .default("not-requested"),
  verificationStatus: z
    .enum(["not-run", "running", "eligible", "ineligible"])
    .default("not-run"),
});

export type AttemptManifest = z.infer<typeof attemptManifestSchema>;

export function createReservedAttempt(input: {
  jobId: string;
  attemptId: string;
  ordinal: number;
  adapterId: string;
  createdAt?: Date;
  artifacts: AttemptManifest["artifacts"];
  lineage?: ProposalLineage;
}): AttemptManifest {
  return attemptManifestSchema.parse({
    schema: "conductor.attempt/v1",
    attemptId: input.attemptId,
    jobId: input.jobId,
    ordinal: input.ordinal,
    adapterId: input.adapterId,
    status: "reserved",
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    artifacts: input.artifacts,
    lineage: input.lineage,
    reviewDisposition: "not-requested",
    verificationStatus: "not-run",
  });
}
