import { z } from "zod/v4";

import { commandSpecSchema } from "../contracts/job.js";
import { processResultSchema } from "../contracts/attempt.js";

export const commandEvidenceSchema = z.object({
  phase: z.enum(["setup", "acceptance"]),
  index: z.number().int().nonnegative(),
  command: commandSpecSchema,
  resolvedCwd: z.string().min(1),
  executionBoundary: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("host-worktree") }),
      z.object({
        kind: z.literal("external-sandbox"),
        profileId: z.string().min(1),
        profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        driver: z.literal("docker"),
        image: z.string().min(1),
        containerName: z.string().min(1),
        network: z.literal("none"),
        readOnlyRoot: z.literal(true),
      }),
    ])
    .default({ kind: "host-worktree" }),
  status: z.enum([
    "passed",
    "failed",
    "timed-out",
    "cancelled",
    "policy-denied",
  ]),
  process: processResultSchema.optional(),
  stdout: z.string().min(1).optional(),
  stderr: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;

export const verificationRecordSchema = z.object({
  schema: z.literal("conductor.verification/v1"),
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  updatedAt: z.string().datetime(),
  setup: z.object({
    status: z.enum([
      "not-configured",
      "pending",
      "passed",
      "failed",
      "cancelled",
      "policy-denied",
    ]),
    commands: z.array(commandEvidenceSchema),
    repositoryClean: z.boolean().nullable(),
  }),
  scope: z.object({
    status: z.enum(["not-run", "not-configured", "passed", "failed"]),
    changedPaths: z.array(z.string()),
    violations: z.array(
      z.object({
        path: z.string().min(1),
        kind: z.enum(["outside-allowed", "forbidden", "protected"]),
        rule: z.string().min(1),
      }),
    ),
  }),
  acceptance: z.object({
    status: z.enum([
      "not-run",
      "not-configured",
      "pending",
      "passed",
      "failed",
      "cancelled",
      "policy-denied",
    ]),
    commands: z.array(commandEvidenceSchema),
    proposalStable: z.boolean().nullable(),
  }),
  eligibleForReview: z.boolean(),
});

export type VerificationRecord = z.infer<typeof verificationRecordSchema>;

export function createVerificationRecord(input: {
  jobId: string;
  attemptId: string;
  hasSetup: boolean;
  hasAcceptance: boolean;
}): VerificationRecord {
  return verificationRecordSchema.parse({
    schema: "conductor.verification/v1",
    jobId: input.jobId,
    attemptId: input.attemptId,
    updatedAt: new Date().toISOString(),
    setup: {
      status: input.hasSetup ? "pending" : "not-configured",
      commands: [],
      repositoryClean: input.hasSetup ? null : true,
    },
    scope: {
      status: "not-run",
      changedPaths: [],
      violations: [],
    },
    acceptance: {
      status: input.hasAcceptance ? "pending" : "not-configured",
      commands: [],
      proposalStable: input.hasAcceptance ? null : true,
    },
    eligibleForReview: false,
  });
}
