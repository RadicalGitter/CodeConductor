import { z } from "zod/v4";

import { attemptStatusSchema } from "./attempt.js";
import { jobRequestSchema } from "./job.js";

export const queueOptionsSchema = z.object({
  priority: z.number().int().min(-100).max(100).default(0),
  dependsOnJobIds: z.array(z.string().min(1)).default([]),
});

export const queuedJobRequestSchema = jobRequestSchema.extend({
  queue: queueOptionsSchema.default({ priority: 0, dependsOnJobIds: [] }),
});

export type QueuedJobRequest = z.infer<typeof queuedJobRequestSchema>;

export const queueItemStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "needs-input",
  "cancelled",
]);

export const queueCompletionSchema = z.object({
  attemptId: z.string().min(1),
  attemptStatus: attemptStatusSchema,
  verificationStatus: z.enum(["not-run", "running", "eligible", "ineligible"]),
  finishedAt: z.string().datetime(),
  artifacts: z.object({
    manifest: z.string().min(1),
    proposalPatch: z.string().min(1),
    changedPaths: z.string().min(1),
    verification: z.string().min(1),
  }),
});

export const queueItemSchema = z.object({
  schema: z.literal("conductor.queue-item/v1"),
  jobId: z.string().min(1),
  status: queueItemStatusSchema,
  priority: z.number().int().min(-100).max(100),
  dependsOnJobIds: z.array(z.string().min(1)),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  attemptId: z.string().min(1).optional(),
  completion: queueCompletionSchema.optional(),
  message: z.string().min(1).optional(),
});

export type QueueItem = z.infer<typeof queueItemSchema>;
export type QueueItemStatus = z.infer<typeof queueItemStatusSchema>;

export const dispatcherLeaseSchema = z.object({
  schema: z.literal("conductor.dispatcher-lease/v1"),
  ownerId: z.string().min(1),
  processId: z.number().int().positive(),
  acquiredAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type DispatcherLease = z.infer<typeof dispatcherLeaseSchema>;
