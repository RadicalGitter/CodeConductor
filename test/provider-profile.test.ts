import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  calculateProviderCostMicroUsd,
  estimateProviderRequestCostMicroUsd,
  fingerprintProviderProfile,
  loadProviderProfileFile,
  providerProfileFileSchema,
  resolveProviderProfile,
  type ProviderProfile,
  type ProviderRateCard,
} from "../src/contracts/provider-profile.js";

const rateCard: ProviderRateCard = {
  id: "openai-standard-2026-07-30",
  effectiveDate: "2026-07-30",
  currency: "USD",
  uncachedInputMicroUsdPerMillion: 200_000,
  cachedInputMicroUsdPerMillion: 20_000,
  cacheWriteMicroUsdPerMillion: 250_000,
  outputMicroUsdPerMillion: 1_200_000,
  longContext: {
    thresholdInputTokens: 272_000,
    inputMultiplierNumerator: 2,
    inputMultiplierDenominator: 1,
    outputMultiplierNumerator: 3,
    outputMultiplierDenominator: 2,
  },
};

const profile: ProviderProfile = {
  provider: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  serviceTier: "default",
  apiKeyEnvName: "OPENAI_API_KEY",
  rateCard,
  budget: {
    requestTimeoutMs: 600_000,
    maxRequests: 24,
    maxRetries: 2,
    maxToolCalls: 24,
    maxInputTokens: 200_000,
    maxOutputTokens: 16_384,
    maxToolOutputBytes: 1_048_576,
    maxCostMicroUsd: 250_000,
  },
};

test("provider profiles load strictly and resolve only owner-bound ids", () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "conductor-provider-profile-"),
  );
  try {
    const target = path.join(directory, "profiles.json");
    writeFileSync(
      target,
      `${JSON.stringify({
        schema: "conductor.provider-profiles/v1",
        profiles: { "luna-medium-v1": profile },
      })}\n`,
      "utf8",
    );
    const loaded = loadProviderProfileFile(target);
    expect(resolveProviderProfile(loaded, "luna-medium-v1")).toEqual(profile);
    expect(() => resolveProviderProfile(loaded, "missing")).toThrow(
      "Unknown provider profile",
    );

    const widened = JSON.parse(readFileSync(target, "utf8")) as Record<
      string,
      unknown
    >;
    widened.endpointFromJob = "https://example.invalid";
    writeFileSync(target, JSON.stringify(widened), "utf8");
    expect(() => loadProviderProfileFile(target)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy v1 profiles default to Standard service without widening job authority", () => {
  const { serviceTier: _serviceTier, ...legacyProfile } = profile;
  const parsed = providerProfileFileSchema.parse({
    schema: "conductor.provider-profiles/v1",
    profiles: { legacy: legacyProfile },
  });
  expect(parsed.profiles.legacy?.serviceTier).toBe("default");
});

test("profile fingerprints are canonical and secret values are not profile data", () => {
  const reordered: ProviderProfile = {
    budget: { ...profile.budget },
    rateCard: { ...profile.rateCard },
    apiKeyEnvName: profile.apiKeyEnvName,
    reasoningEffort: profile.reasoningEffort,
    serviceTier: profile.serviceTier,
    model: profile.model,
    baseUrl: profile.baseUrl,
    provider: profile.provider,
  };
  expect(fingerprintProviderProfile(profile)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprintProviderProfile(profile)).toBe(
    fingerprintProviderProfile(reordered),
  );
  expect(fingerprintProviderProfile(profile)).not.toBe(
    fingerprintProviderProfile({
      ...profile,
      budget: {
        ...profile.budget,
        maxCostMicroUsd: profile.budget.maxCostMicroUsd + 1,
      },
    }),
  );
  expect(JSON.stringify(profile)).not.toContain("sk-");
  expect(profile.apiKeyEnvName).toBe("OPENAI_API_KEY");
});

test("cost accounting separates cache categories and applies long-context pricing", () => {
  expect(
    calculateProviderCostMicroUsd(
      {
        inputTokens: 200_000,
        cachedInputTokens: 20_000,
        cacheWriteTokens: 10_000,
        outputTokens: 10_000,
        reasoningTokens: 40_000,
      },
      rateCard,
    ),
  ).toBe(48_900);

  expect(
    calculateProviderCostMicroUsd(
      {
        inputTokens: 300_000,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10_000,
        reasoningTokens: 5_000,
      },
      rateCard,
    ),
  ).toBe(138_000);

  expect(
    calculateProviderCostMicroUsd(
      {
        inputTokens: 300_000,
        cachedInputTokens: 100_000,
        cacheWriteTokens: 0,
        outputTokens: 10_000,
        reasoningTokens: 5_000,
      },
      rateCard,
    ),
  ).toBe(102_000);

  expect(
    calculateProviderCostMicroUsd(
      {
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      rateCard,
    ),
  ).toBe(1);

  expect(() =>
    calculateProviderCostMicroUsd(
      {
        inputTokens: 1,
        cachedInputTokens: 1,
        cacheWriteTokens: 1,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      rateCard,
    ),
  ).toThrow();
  expect(estimateProviderRequestCostMicroUsd(10_000, 5_000, rateCard)).toBe(
    8_000,
  );
});

test("the checked example exposes Luna medium/max without embedding a key", () => {
  const target = path.resolve("config/provider-profiles.example.json");
  const raw = readFileSync(target, "utf8");
  const parsed = providerProfileFileSchema.parse(JSON.parse(raw));
  expect(Object.keys(parsed.profiles).sort()).toEqual([
    "luna-max-v1",
    "luna-medium-v1",
  ]);
  const max = parsed.profiles["luna-max-v1"];
  expect(max?.reasoningEffort).toBe("max");
  expect(max?.serviceTier).toBe("priority");
  expect(max?.budget.maxInputTokens).toBe(1_050_000);
  expect(max?.budget.maxCostMicroUsd).toBeLessThanOrEqual(1_250_000);
  expect(raw).not.toContain("sk-");

  const environmentExample = readFileSync(path.resolve(".env.example"), "utf8");
  expect(environmentExample).toContain("CONDUCTOR_PROVIDER_PROFILES_FILE=");
  expect(environmentExample).toContain("OPENAI_API_KEY=");
  expect(environmentExample).not.toContain("sk-");
});
