import { z } from "zod/v4";

export const attemptStatusSchema = z.enum([
  "reserved",
  "preparing",
  "running",
  "completed",
  "failed",
  "needs-input",
  "cancelled",
]);

export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const failureKindSchema = z.enum([
  "invalid-job",
  "adapter-unavailable",
  "workspace-failed",
  "spawn-failed",
  "worker-exit",
  "proposal-capture-failed",
  "timeout",
  "cancelled",
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
  }),
  failure: z
    .object({
      kind: failureKindSchema,
      message: z.string().min(1),
    })
    .optional(),
  reviewDisposition: z
    .enum(["not-requested", "pending", "accepted", "rejected", "superseded"])
    .default("not-requested"),
});

export type AttemptManifest = z.infer<typeof attemptManifestSchema>;

export function createReservedAttempt(input: {
  jobId: string;
  attemptId: string;
  ordinal: number;
  adapterId: string;
  createdAt?: Date;
  artifacts: AttemptManifest["artifacts"];
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
    reviewDisposition: "not-requested",
  });
}
