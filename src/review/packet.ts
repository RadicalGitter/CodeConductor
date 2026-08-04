import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod/v4";

import type { AttemptManifest } from "../contracts/attempt.js";
import { jobContractSchema, type JobContract } from "../contracts/job.js";
import {
  verificationRecordSchema,
  type VerificationRecord,
} from "../verification/types.js";

const artifactBindingSchema = z.object({
  name: z.enum([
    "job",
    "proposalPatch",
    "changedPaths",
    "verification",
    "stdout",
    "stderr",
  ]),
  path: z.string().min(1),
  available: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export const reviewPacketSchema = z.object({
  schema: z.literal("conductor.review-packet/v1"),
  createdAt: z.string().datetime(),
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  authority: z.literal("advisory-review-only"),
  attempt: z.object({
    status: z.string().min(1),
    verificationStatus: z.string().min(1),
    reviewDisposition: z.string().min(1),
    adapterId: z.string().min(1),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
  }),
  contract: jobContractSchema,
  verification: verificationRecordSchema,
  changedPaths: z.array(z.string()),
  bindings: z.array(artifactBindingSchema),
  reviewerContract: z.object({
    allowedOutcomes: z.array(z.enum(["pass", "fail", "needs-context"])),
    requiredFindingFields: z.array(z.string()),
    instructions: z.array(z.string()),
  }),
});

export type ReviewPacket = z.infer<typeof reviewPacketSchema>;

export async function buildReviewPacket(input: {
  contract: JobContract;
  manifest: AttemptManifest;
  verification: VerificationRecord;
  changedPaths: string[];
  now?: Date;
}): Promise<ReviewPacket> {
  const artifactNames = [
    "job",
    "proposalPatch",
    "changedPaths",
    "verification",
    "stdout",
    "stderr",
  ] as const;
  const bindings = await Promise.all(
    artifactNames.map(async (name) => {
      const target = input.manifest.artifacts[name];
      try {
        const details = await stat(target);
        return {
          name,
          path: target,
          available: true as const,
          size: details.size,
          sha256: await sha256File(target),
        };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return { name, path: target, available: false as const };
        }
        throw error;
      }
    }),
  );

  return reviewPacketSchema.parse({
    schema: "conductor.review-packet/v1",
    createdAt: (input.now ?? new Date()).toISOString(),
    jobId: input.manifest.jobId,
    attemptId: input.manifest.attemptId,
    authority: "advisory-review-only",
    attempt: {
      status: input.manifest.status,
      verificationStatus: input.manifest.verificationStatus,
      reviewDisposition: input.manifest.reviewDisposition,
      adapterId: input.manifest.adapterId,
      startedAt: input.manifest.startedAt,
      finishedAt: input.manifest.finishedAt,
    },
    contract: input.contract,
    verification: input.verification,
    changedPaths: input.changedPaths,
    bindings,
    reviewerContract: {
      allowedOutcomes: ["pass", "fail", "needs-context"],
      requiredFindingFields: ["severity", "path", "line", "claim", "evidence"],
      instructions: [
        "Review the bound proposal patch against the frozen contract and repository evidence.",
        "Treat deterministic verification as evidence, not proof of semantic correctness.",
        "Return fail for any actionable defect and needs-context only when named evidence is missing.",
        "Do not accept, merge, execute, or mutate repository state.",
      ],
    },
  });
}

export function sha256File(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}
