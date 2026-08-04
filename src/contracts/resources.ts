import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

export const resourceLimitsSchema = z.object({
  attemptTimeoutMs: z.number().int().min(1_000).max(86_400_000),
  maxCommands: z.number().int().min(1).max(256),
  maxAttemptsPerJob: z.number().int().min(1).max(256),
  maxAutomaticRetries: z.number().int().min(0).max(16),
  maxChangedPaths: z.number().int().min(1).max(10_000),
  maxPatchBytes: z.number().int().min(1_024).max(1_073_741_824),
  maxLogBytes: z.number().int().min(1_024).max(1_073_741_824),
  maxArtifactBytes: z.number().int().min(1_024).max(10_737_418_240),
  maxWorktreeBytes: z.number().int().min(1_024).max(1_099_511_627_776),
  maxLineageContributions: z.number().int().min(1).max(256),
  maxExternalResources: z.number().int().min(0).max(256),
  gitTimeoutMs: z.number().int().min(1_000).max(600_000),
  cleanupTimeoutMs: z.number().int().min(1_000).max(600_000),
  minimumFreeDiskBytes: z.number().int().nonnegative().max(1_099_511_627_776),
  terminalRetentionMs: z.number().int().min(60_000).max(31_536_000_000),
  reviewedRetentionMs: z.number().int().min(60_000).max(31_536_000_000),
  gcProposalTtlMs: z.number().int().min(60_000).max(86_400_000),
});

export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;

export const ownerResourceProfileSchema = z.object({
  schema: z.literal("conductor.owner-resource-profile/v1"),
  profileId: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  limits: resourceLimitsSchema,
});

export type OwnerResourceProfile = z.infer<typeof ownerResourceProfileSchema>;

export const resourceBudgetSchema = resourceLimitsSchema.extend({
  schema: z.literal("conductor.resource-budget/v1"),
  profileId: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ResourceBudget = z.infer<typeof resourceBudgetSchema>;

export const DEFAULT_OWNER_RESOURCE_PROFILE: OwnerResourceProfile =
  ownerResourceProfileSchema.parse({
    schema: "conductor.owner-resource-profile/v1",
    profileId: "overnight-local-v1",
    limits: {
      attemptTimeoutMs: 45 * 60 * 1_000,
      maxCommands: 32,
      maxAttemptsPerJob: 16,
      maxAutomaticRetries: 1,
      maxChangedPaths: 20,
      maxPatchBytes: 5 * 1024 * 1024,
      maxLogBytes: 10 * 1024 * 1024,
      maxArtifactBytes: 50 * 1024 * 1024,
      maxWorktreeBytes: 2 * 1024 * 1024 * 1024,
      maxLineageContributions: 32,
      maxExternalResources: 32,
      gitTimeoutMs: 60_000,
      cleanupTimeoutMs: 30_000,
      minimumFreeDiskBytes: 1024 * 1024 * 1024,
      terminalRetentionMs: 7 * 24 * 60 * 60 * 1_000,
      reviewedRetentionMs: 30 * 24 * 60 * 60 * 1_000,
      gcProposalTtlMs: 15 * 60 * 1_000,
    },
  });

export function freezeResourceBudget(
  profile: OwnerResourceProfile,
  requestedAttemptTimeoutMs?: number,
): ResourceBudget {
  const parsed = ownerResourceProfileSchema.parse(profile);
  const body = {
    schema: "conductor.resource-budget/v1",
    profileId: parsed.profileId,
    ...parsed.limits,
    attemptTimeoutMs: Math.min(
      parsed.limits.attemptTimeoutMs,
      requestedAttemptTimeoutMs ?? parsed.limits.attemptTimeoutMs,
    ),
  } as const;
  return resourceBudgetSchema.parse({
    ...body,
    profileFingerprint: createHash("sha256")
      .update(canonicalProfileJson(body))
      .digest("hex"),
  });
}

export function assertResourceBudgetIntegrity(budget: ResourceBudget): void {
  const { profileFingerprint, ...body } = resourceBudgetSchema.parse(budget);
  const actual = createHash("sha256")
    .update(canonicalProfileJson(body))
    .digest("hex");
  if (actual !== profileFingerprint) {
    throw new Error(
      `Frozen resource budget fingerprint is invalid: ${budget.profileId}`,
    );
  }
}

export function loadOwnerResourceProfileFromEnvironment(): OwnerResourceProfile {
  const configured = process.env.CONDUCTOR_RESOURCE_PROFILE_FILE;
  if (!configured) return DEFAULT_OWNER_RESOURCE_PROFILE;
  const target = path.resolve(configured);
  return ownerResourceProfileSchema.parse(
    JSON.parse(readFileSync(target, "utf8")) as unknown,
  );
}

function canonicalProfileJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalProfileJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, entry]) => `${JSON.stringify(key)}:${canonicalProfileJson(entry)}`,
    )
    .join(",")}}`;
}
