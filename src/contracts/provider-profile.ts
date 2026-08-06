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

export function loadProviderProfileFile(
  _filePath: string,
): ProviderProfileFile {
  throw new Error("Provider profile loading is not implemented");
}

export function resolveProviderProfile(
  _profileFile: ProviderProfileFile,
  _profileId: string,
): ProviderProfile {
  throw new Error("Provider profile resolution is not implemented");
}

export function fingerprintProviderProfile(_profile: ProviderProfile): string {
  throw new Error("Provider profile fingerprinting is not implemented");
}

export function calculateProviderCostMicroUsd(
  _usage: ProviderTokenUsage,
  _rateCard: ProviderRateCard,
): number {
  throw new Error("Provider cost calculation is not implemented");
}

export function estimateProviderRequestCostMicroUsd(
  _inputTokenUpperBound: number,
  _maxOutputTokens: number,
  _rateCard: ProviderRateCard,
): number {
  throw new Error("Provider request cost estimation is not implemented");
}
