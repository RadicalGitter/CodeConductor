import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod/v4";

const identifierSchema = z.string().regex(/^[a-zA-Z0-9_.-]+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    host.toLowerCase(),
  );
}

export const loopbackHostSchema = z.string().min(1).refine(isLoopbackHost, {
  message: "only 127.0.0.1, localhost, and ::1 are permitted",
});

export const modelServiceEndpointSchema = z
  .object({
    host: loopbackHostSchema,
    port: z.number().int().min(1).max(65_535),
    basePath: z
      .string()
      .regex(/^\/(?!\/)/)
      .default("/"),
  })
  .strict();

export const modelServiceContextSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("models-entry"),
      field: z
        .string()
        .regex(/^[a-zA-Z0-9_.-]+$/)
        .default("context"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("probe"),
      path: z.string().regex(/^\/(?!\/)/),
      field: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
    })
    .strict(),
]);

export const modelServiceLaunchSchema = z
  .object({
    executable: z.string().min(1).refine(path.isAbsolute),
    args: z.array(z.string()).max(256),
    cwd: z.string().min(1).refine(path.isAbsolute).optional(),
  })
  .strict();

export const modelServiceProfileSchema = z
  .object({
    schema: z.literal("conductor.model-service-profile/v1"),
    profileId: identifierSchema,
    endpoint: modelServiceEndpointSchema,
    expected: z
      .object({
        model: z.string().min(1),
        context: z.number().int().positive().max(4_194_304),
        contextSource: modelServiceContextSourceSchema,
      })
      .strict(),
    launch: modelServiceLaunchSchema.optional(),
    readiness: z
      .object({
        startupTimeoutMs: z.number().int().min(1_000).max(1_800_000),
        probeIntervalMs: z.number().int().min(100).max(30_000),
        requestTimeoutMs: z.number().int().min(250).max(30_000).default(5_000),
      })
      .strict(),
    stopTimeoutMs: z.number().int().min(500).max(600_000).default(15_000),
    checkpointDirectory: z.string().min(1).refine(path.isAbsolute).optional(),
  })
  .strict();

export const modelServiceProfileFileSchema = z
  .object({
    schema: z.literal("conductor.model-service-profiles/v1"),
    profiles: z.record(identifierSchema, modelServiceProfileSchema),
  })
  .strict();

export type ModelServiceProfile = z.infer<typeof modelServiceProfileSchema>;
export type ModelServiceProfileFile = z.infer<
  typeof modelServiceProfileFileSchema
>;
export type ModelServiceLaunch = z.infer<typeof modelServiceLaunchSchema>;

export const modelServiceStateSchema = z.enum([
  "offline",
  "starting",
  "ready",
  "busy",
  "stopping",
  "wrong-model",
  "error",
]);

export type ModelServiceState = z.infer<typeof modelServiceStateSchema>;

const ownershipSchema = z
  .object({
    instanceId: z.string().uuid(),
    ownerPid: z.number().int().positive(),
    workerPid: z.number().int().positive(),
    guardian: z
      .object({
        schema: z.literal("conductor.process-guardian/v2"),
        nonce: z.string().uuid(),
        guardianPid: z.number().int().positive(),
        parentPid: z.number().int().positive(),
        createdAt: z.string().datetime(),
        containment: z
          .object({
            schema: z.literal("conductor.process-containment/v1"),
            kind: z.enum(["windows-job", "posix-process-group"]),
            ownerPid: z.number().int().positive(),
            kernelEnforced: z.boolean(),
            killOnOwnerClose: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    launchedAt: z.string().datetime(),
  })
  .strict();

const operationSchema = z
  .object({
    operationId: z.string().uuid(),
    kind: z.enum(["start", "stop"]),
    status: z.enum(["requested", "completed", "failed"]),
    requestedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    detail: z.string().optional(),
  })
  .strict();

export const modelServiceRecordSchema = z
  .object({
    schema: z.literal("conductor.model-service/v2"),
    profileId: identifierSchema,
    profileFingerprint: sha256Schema,
    state: modelServiceStateSchema,
    expected: z
      .object({
        model: z.string().min(1),
        context: z.number().int().positive(),
      })
      .strict()
      .optional(),
    observed: z
      .object({
        reachable: z.boolean(),
        model: z.string().optional(),
        context: z.number().int().positive().optional(),
        observedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
    launchEvidence: z
      .object({
        fingerprint: sha256Schema,
        files: z.array(
          z
            .object({
              path: z.string().min(1),
              bytes: z.number().int().nonnegative(),
              sha256: sha256Schema,
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    ownership: ownershipSchema.optional(),
    operation: operationSchema.optional(),
    failure: z
      .object({
        kind: z.enum([
          "unconfigured",
          "spawn-failed",
          "startup-timeout",
          "wrong-model",
          "context-unverified",
          "probe-failed",
          "stop-refused",
          "stop-unverified",
          "stale-owner",
        ]),
        message: z.string().min(1),
      })
      .strict()
      .optional(),
    readyAt: z.string().datetime().optional(),
    stoppedAt: z.string().datetime().optional(),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ModelServiceRecord = z.infer<typeof modelServiceRecordSchema>;

export function fingerprintModelServiceProfile(
  profile: ModelServiceProfile,
): string {
  return createHash("sha256").update(canonicalJson(profile)).digest("hex");
}

export function fingerprintModelServiceLaunch(
  launch: ModelServiceLaunch,
): string {
  return createHash("sha256").update(canonicalJson(launch)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
