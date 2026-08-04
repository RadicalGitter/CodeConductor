import { z } from "zod/v4";

import {
  processGuardianIdentitySchema,
  processTerminationEvidenceSchema,
} from "./attempt.js";

export const cleanupSubjectSchema = z.object({
  kind: z.enum(["process-tree", "external-resource", "workspace"]),
  id: z.string().min(1).max(256),
});

export const cleanupRequirementSchema = z.object({
  schema: z.literal("conductor.cleanup-requirement/v1"),
  subject: cleanupSubjectSchema,
  registeredAt: z.string().datetime(),
  deadlineMs: z.number().int().min(100).max(300_000),
  guardian: processGuardianIdentitySchema.optional(),
});

export const cleanupEvidenceSchema = z.object({
  schema: z.literal("conductor.cleanup-evidence/v1"),
  evidenceId: z.string().uuid(),
  subject: cleanupSubjectSchema,
  status: z.enum(["proven", "failed", "unknown"]),
  method: z.enum([
    "process-runner",
    "windows-job-owner-exit",
    "external-resource-command",
    "workspace-remove",
    "cleanup-deadline",
    "legacy-unverified",
  ]),
  observedAt: z.string().datetime(),
  detail: z.string().min(1).max(4_000).optional(),
  termination: processTerminationEvidenceSchema.optional(),
});

export const attemptCleanupRecordSchema = z.object({
  schema: z.literal("conductor.attempt-cleanup/v1"),
  attemptId: z.string().min(1),
  jobId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  status: z.enum(["not-required", "pending", "proven", "failed", "unknown"]),
  requirements: z.array(cleanupRequirementSchema),
  evidence: z.array(cleanupEvidenceSchema),
});

export type CleanupSubject = z.infer<typeof cleanupSubjectSchema>;
export type CleanupRequirement = z.infer<typeof cleanupRequirementSchema>;
export type CleanupEvidence = z.infer<typeof cleanupEvidenceSchema>;
export type AttemptCleanupRecord = z.infer<typeof attemptCleanupRecordSchema>;
export type AttemptCleanupStatus = AttemptCleanupRecord["status"];

export function createAttemptCleanupRecord(input: {
  attemptId: string;
  jobId: string;
  now?: Date;
}): AttemptCleanupRecord {
  return attemptCleanupRecordSchema.parse({
    schema: "conductor.attempt-cleanup/v1",
    attemptId: input.attemptId,
    jobId: input.jobId,
    revision: 0,
    updatedAt: (input.now ?? new Date()).toISOString(),
    status: "not-required",
    requirements: [],
    evidence: [],
  });
}

export function deriveCleanupStatus(
  requirements: CleanupRequirement[],
  evidence: CleanupEvidence[],
): AttemptCleanupStatus {
  if (requirements.length === 0) return "not-required";

  const latest = new Map<string, CleanupEvidence>();
  for (const observation of evidence) {
    latest.set(subjectKey(observation.subject), observation);
  }
  const states = requirements.map(
    (requirement) => latest.get(subjectKey(requirement.subject))?.status,
  );
  if (states.includes("failed")) return "failed";
  if (states.includes("unknown")) return "unknown";
  if (states.includes(undefined)) return "pending";
  return "proven";
}

export function sameCleanupSubject(
  left: CleanupSubject,
  right: CleanupSubject,
): boolean {
  return subjectKey(left) === subjectKey(right);
}

export function latestCleanupEvidence(
  record: AttemptCleanupRecord,
  subject: CleanupSubject,
): CleanupEvidence | undefined {
  for (let index = record.evidence.length - 1; index >= 0; index -= 1) {
    const entry = record.evidence[index]!;
    if (sameCleanupSubject(entry.subject, subject)) return entry;
  }
  return undefined;
}

function subjectKey(subject: CleanupSubject): string {
  return `${subject.kind}\0${subject.id}`;
}
