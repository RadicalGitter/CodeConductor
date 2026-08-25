import { createHash } from "node:crypto";

import { z } from "zod/v4";

import { loopbackHostSchema } from "../contracts/model-service.js";

export const consoleSettingsSchema = z
  .object({
    console: z
      .object({
        host: loopbackHostSchema,
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
    dispatcherConcurrency: z.number().int().min(1).max(32).optional(),
    modelServiceId: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .optional(),
    includeModelState: z.boolean().default(true),
  })
  .strict();

export type ConsoleSettings = z.infer<typeof consoleSettingsSchema>;

export const consoleSettingsDocumentSchema = z
  .object({
    schema: z.literal("conductor.console-settings/v1"),
    revision: z.number().int().nonnegative(),
    settings: consoleSettingsSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ConsoleSettingsDocument = z.infer<
  typeof consoleSettingsDocumentSchema
>;

export const DEFAULT_CONSOLE_SETTINGS: ConsoleSettings =
  consoleSettingsSchema.parse({
    console: { host: "127.0.0.1", port: 8_787 },
    includeModelState: true,
  });

export interface EffectiveConsoleSettings {
  settings: ConsoleSettings;
  revision: number;
  document: ConsoleSettingsDocument | null;
  provenance: {
    document: "defaults" | "owner-document";
    consoleHost: "defaults" | "owner-document" | "environment";
    consolePort: "defaults" | "owner-document" | "environment";
    fingerprint?: string;
  };
}

export function validateConsoleSettings(input: unknown): ConsoleSettings {
  return consoleSettingsSchema.parse(input);
}

export function resolveConsoleSettings(
  document: ConsoleSettingsDocument | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): EffectiveConsoleSettings {
  const stored = document?.settings ?? DEFAULT_CONSOLE_SETTINGS;
  const hostOverride = environment.CONDUCTOR_CONSOLE_HOST;
  const portOverride = environment.CONDUCTOR_CONSOLE_PORT;
  const effective = consoleSettingsSchema.parse({
    ...stored,
    console: {
      host: hostOverride ?? stored.console.host,
      port:
        portOverride === undefined ? stored.console.port : Number(portOverride),
    },
  });
  return {
    settings: effective,
    revision: document?.revision ?? 0,
    document: document ?? null,
    provenance: {
      document: document ? "owner-document" : "defaults",
      consoleHost: hostOverride
        ? "environment"
        : document
          ? "owner-document"
          : "defaults",
      consolePort: portOverride
        ? "environment"
        : document
          ? "owner-document"
          : "defaults",
      fingerprint: document
        ? createHash("sha256").update(JSON.stringify(document)).digest("hex")
        : undefined,
    },
  };
}
