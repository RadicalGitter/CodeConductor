import path from "node:path";
import { z } from "zod/v4";

import { jobRequestSchema, relativePathSchema } from "./job.js";

const sourceCommandSchema = z.object({
  profile: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
});

export const sourceContractSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  objective: z.string().min(1),
  taskClass: jobRequestSchema.shape.taskClass,
  adapterId: z.string().min(1),
  adapterOptions: jobRequestSchema.shape.adapterOptions,
  scope: z.object({
    allowedPaths: z.array(relativePathSchema).min(1),
    forbiddenPaths: z.array(relativePathSchema).default([]),
    protectedPaths: z.array(relativePathSchema).default([]),
  }),
  contextRefs: jobRequestSchema.shape.contextRefs,
  constraints: jobRequestSchema.shape.constraints,
  escalateWhen: jobRequestSchema.shape.escalateWhen,
  setup: z.array(sourceCommandSchema).default([]),
  acceptance: z.array(sourceCommandSchema).min(1),
  timeoutMs: jobRequestSchema.shape.timeoutMs,
  retainWorkspace: jobRequestSchema.shape.retainWorkspace,
  executionBoundary: jobRequestSchema.shape.executionBoundary,
  dependsOn: z.array(z.string().regex(/^[a-zA-Z0-9_.-]+$/)).default([]),
  priority: z.number().int().min(-100).max(100).default(0),
  enabled: z.boolean().default(true),
});

export type SourceContract = z.infer<typeof sourceContractSchema>;

export const sourceScanRequestSchema = z.object({
  repositoryPath: z.string().min(1),
  baseRef: z.string().min(1).default("HEAD"),
  allowedAdapterIds: z.array(z.string().min(1)).min(1),
  includeExtensions: z
    .array(z.string().regex(/^\.[a-zA-Z0-9]+$/))
    .default([
      ".cs",
      ".cpp",
      ".gd",
      ".h",
      ".hpp",
      ".js",
      ".jsx",
      ".lua",
      ".py",
      ".rs",
      ".ts",
      ".tsx",
    ]),
  maxFileBytes: z.number().int().positive().max(2_000_000).default(512_000),
});

export type SourceScanRequest = z.infer<typeof sourceScanRequestSchema>;

export const sourceWatchRequestSchema = sourceScanRequestSchema.extend({
  watchId: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .optional(),
  enabled: z.boolean().default(true),
});

export const sourceWatchSchema = z.object({
  schema: z.literal("conductor.source-watch/v1"),
  watchId: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  enabled: z.boolean(),
  scan: sourceScanRequestSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastScanAt: z.string().datetime().optional(),
  lastRevision: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/i)
    .optional(),
  lastRunId: z.string().min(1).optional(),
  lastError: z.string().min(1).optional(),
});

export type SourceWatch = z.infer<typeof sourceWatchSchema>;

export const compiledSourceContractSchema = z.object({
  schema: z.literal("conductor.compiled-source-contract/v1"),
  id: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.object({
    repositoryRoot: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{40,64}$/i),
    path: z.string().min(1),
    line: z.number().int().positive(),
  }),
  contract: sourceContractSchema,
});

export type CompiledSourceContract = z.infer<
  typeof compiledSourceContractSchema
>;

export const commandProfileFileSchema = z.object({
  schema: z.literal("conductor.command-profiles/v1"),
  profiles: z.record(
    z.string().regex(/^[a-zA-Z0-9_.-]+$/),
    z.object({
      executable: z.string().min(1).refine(isPortableAbsolute, {
        message:
          "profile executable must be an absolute host or container path",
      }),
      argsPrefix: z.array(z.string()).default([]),
      inheritEnv: z
        .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
        .default([]),
    }),
  ),
});

export type CommandProfileFile = z.infer<typeof commandProfileFileSchema>;

function isPortableAbsolute(value: string): boolean {
  return (
    path.posix.isAbsolute(value.replaceAll("\\", "/")) ||
    path.win32.isAbsolute(value)
  );
}
