import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod/v4";

const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const relativePathSchema = z.string().min(1).refine(isSafeRelativePath, {
  message: "must be a relative path without traversal or glob syntax",
});

export const commandSpecSchema = z.object({
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: relativePathSchema.optional(),
  inheritEnv: z.array(environmentNameSchema).default([]),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
});

export type CommandSpec = z.infer<typeof commandSpecSchema>;

export const jobRequestSchema = z.object({
  objective: z.string().min(1),
  taskClass: z
    .enum(["implementation", "test", "documentation", "analysis", "review"])
    .default("implementation"),
  repositoryPath: z.string().min(1),
  baseRef: z.string().min(1).default("HEAD"),
  adapterId: z.string().min(1),
  adapterOptions: z.record(z.string(), z.unknown()).default({}),
  scope: z
    .object({
      allowedPaths: z.array(relativePathSchema).default([]),
      forbiddenPaths: z.array(relativePathSchema).default([]),
      protectedPaths: z.array(relativePathSchema).default([]),
    })
    .default({ allowedPaths: [], forbiddenPaths: [], protectedPaths: [] }),
  contextRefs: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  escalateWhen: z
    .array(z.string().min(1))
    .default([
      "Required work exceeds declared scope or conflicts with repository authority.",
    ]),
  setupCommands: z.array(commandSpecSchema).default([]),
  acceptanceCommands: z.array(commandSpecSchema).default([]),
  timeoutMs: z.number().int().positive().max(86_400_000).default(3_600_000),
  retainWorkspace: z.boolean().default(true),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export type JobRequest = z.infer<typeof jobRequestSchema>;

export const jobContractSchema = z.object({
  schema: z.literal("conductor.job/v1"),
  jobId: z.string().min(1),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(1),
  createdAt: z.string().datetime(),
  objective: z.string().min(1),
  taskClass: jobRequestSchema.shape.taskClass,
  repository: z.object({
    root: z.string().min(1),
    requestedRef: z.string().min(1),
    baseRevision: z.string().regex(/^[a-f0-9]{40,64}$/i),
  }),
  worker: z.object({
    adapterId: z.string().min(1),
    options: z.record(z.string(), z.unknown()),
  }),
  scope: jobRequestSchema.shape.scope,
  contextRefs: z.array(z.string()),
  constraints: z.array(z.string()),
  escalateWhen: z.array(z.string().min(1)).min(1),
  setupCommands: z.array(commandSpecSchema),
  acceptanceCommands: z.array(commandSpecSchema),
  execution: z.object({
    timeoutMs: z.number().int().positive(),
    retainWorkspace: z.boolean(),
  }),
  authority: z.literal("proposal-only"),
});

export type JobContract = z.infer<typeof jobContractSchema>;

export interface FreezeJobRequestOptions {
  repositoryRoot: string;
  baseRevision: string;
  now?: Date;
  generatedId?: string;
}

export function freezeJobRequest(
  input: unknown,
  options: FreezeJobRequestOptions,
): JobContract {
  const request = jobRequestSchema.parse(input);
  const requestFingerprint = fingerprint(request);
  const idempotencyKey =
    request.idempotencyKey ?? options.generatedId ?? randomUUID();
  const jobId = `job_${shortHash(idempotencyKey)}`;

  return jobContractSchema.parse({
    schema: "conductor.job/v1",
    jobId,
    requestFingerprint,
    idempotencyKey,
    createdAt: (options.now ?? new Date()).toISOString(),
    objective: request.objective,
    taskClass: request.taskClass,
    repository: {
      root: options.repositoryRoot,
      requestedRef: request.baseRef,
      baseRevision: options.baseRevision,
    },
    worker: {
      adapterId: request.adapterId,
      options: request.adapterOptions,
    },
    scope: request.scope,
    contextRefs: request.contextRefs,
    constraints: request.constraints,
    escalateWhen: request.escalateWhen,
    setupCommands: request.setupCommands,
    acceptanceCommands: request.acceptanceCommands,
    execution: {
      timeoutMs: request.timeoutMs,
      retainWorkspace: request.retainWorkspace,
    },
    authority: "proposal-only",
  });
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${canonicalJson(entryValue)}`,
    )
    .join(",")}}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function isSafeRelativePath(value: string): boolean {
  const portable = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    /[*?\[\]]/.test(portable)
  ) {
    return false;
  }
  const segments = portable.split("/").filter(Boolean);
  return (
    segments.length > 0 &&
    segments.every((segment) => segment !== "." && segment !== "..")
  );
}
