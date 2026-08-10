import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod/v4";

const identifierSchema = z.string().regex(/^[a-zA-Z0-9_.-]+$/);
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const providerRateCardSchema = z
  .object({
    id: identifierSchema,
    effectiveDate: z.string().date(),
    currency: z.literal("USD"),
    uncachedInputMicroUsdPerMillion: z.number().int().nonnegative(),
    cachedInputMicroUsdPerMillion: z.number().int().nonnegative(),
    cacheWriteMicroUsdPerMillion: z.number().int().nonnegative(),
    outputMicroUsdPerMillion: z.number().int().nonnegative(),
    longContext: z
      .object({
        thresholdInputTokens: z.number().int().positive(),
        inputMultiplierNumerator: z.number().int().positive(),
        inputMultiplierDenominator: z.number().int().positive(),
        outputMultiplierNumerator: z.number().int().positive(),
        outputMultiplierDenominator: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const providerBudgetSchema = z
  .object({
    requestTimeoutMs: z.number().int().positive().max(3_600_000),
    maxRequests: z.number().int().positive().max(128),
    maxRetries: z.number().int().nonnegative().max(16),
    maxToolCalls: z.number().int().positive().max(1_024),
    maxInputTokens: z.number().int().positive().max(1_050_000),
    maxOutputTokens: z.number().int().positive().max(128_000),
    maxToolOutputBytes: z.number().int().positive().max(16_777_216),
    maxCostMicroUsd: z.number().int().positive().max(5_000_000),
  })
  .strict();

export const providerProfileSchema = z
  .object({
    provider: z.literal("openai-responses"),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
    serviceTier: z.enum(["default", "priority", "fast"]).default("default"),
    apiKeyEnvName: environmentNameSchema,
    rateCard: providerRateCardSchema,
    budget: providerBudgetSchema,
  })
  .strict();

export const providerProfileFileSchema = z
  .object({
    schema: z.literal("conductor.provider-profiles/v1"),
    profiles: z.record(identifierSchema, providerProfileSchema),
  })
  .strict();

export type ProviderRateCard = z.infer<typeof providerRateCardSchema>;
export type ProviderBudget = z.infer<typeof providerBudgetSchema>;
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export type ProviderProfileFile = z.infer<typeof providerProfileFileSchema>;

export interface ProviderTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export function loadProviderProfileFile(filePath: string): ProviderProfileFile {
  return providerProfileFileSchema.parse(
    JSON.parse(readFileSync(filePath, "utf8")),
  );
}

export function resolveProviderProfile(
  profileFile: ProviderProfileFile,
  profileId: string,
): ProviderProfile {
  const profile = profileFile.profiles[profileId];
  if (!profile) throw new Error(`Unknown provider profile: ${profileId}`);
  return profile;
}

export function fingerprintProviderProfile(profile: ProviderProfile): string {
  return createHash("sha256").update(canonicalJson(profile)).digest("hex");
}

export function calculateProviderCostMicroUsd(
  usage: ProviderTokenUsage,
  rateCard: ProviderRateCard,
): number {
  assertUsage(usage);
  const uncachedInputTokens =
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens;
  const inputNumerator =
    BigInt(uncachedInputTokens) *
      BigInt(rateCard.uncachedInputMicroUsdPerMillion) +
    BigInt(usage.cachedInputTokens) *
      BigInt(rateCard.cachedInputMicroUsdPerMillion) +
    BigInt(usage.cacheWriteTokens) *
      BigInt(rateCard.cacheWriteMicroUsdPerMillion);
  const outputNumerator =
    BigInt(usage.outputTokens) * BigInt(rateCard.outputMicroUsdPerMillion);
  const longContext =
    rateCard.longContext &&
    usage.inputTokens > rateCard.longContext.thresholdInputTokens
      ? rateCard.longContext
      : undefined;
  const inputMultiplierNumerator = BigInt(
    longContext?.inputMultiplierNumerator ?? 1,
  );
  const inputMultiplierDenominator = BigInt(
    longContext?.inputMultiplierDenominator ?? 1,
  );
  const outputMultiplierNumerator = BigInt(
    longContext?.outputMultiplierNumerator ?? 1,
  );
  const outputMultiplierDenominator = BigInt(
    longContext?.outputMultiplierDenominator ?? 1,
  );
  const numerator =
    inputNumerator * inputMultiplierNumerator * outputMultiplierDenominator +
    outputNumerator * outputMultiplierNumerator * inputMultiplierDenominator;
  const denominator =
    1_000_000n * inputMultiplierDenominator * outputMultiplierDenominator;
  const cost = divideRoundUp(numerator, denominator);
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Provider cost exceeds the safe integer range");
  }
  return Number(cost);
}

export function estimateProviderRequestCostMicroUsd(
  inputTokenUpperBound: number,
  maxOutputTokens: number,
  rateCard: ProviderRateCard,
): number {
  return calculateProviderCostMicroUsd(
    {
      inputTokens: inputTokenUpperBound,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: maxOutputTokens,
      reasoningTokens: 0,
    },
    rateCard,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function assertUsage(usage: ProviderTokenUsage): void {
  for (const [name, value] of Object.entries(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Provider usage ${name} must be a non-negative integer`);
    }
  }
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens) {
    throw new Error(
      "Provider input usage categories exceed total input tokens",
    );
  }
}

function divideRoundUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
