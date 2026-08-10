import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { freezeJobRequest } from "../src/contracts/job.js";
import { captureWorkerExecutionProfile } from "../src/review/worker-profile.js";
import { createDefaultWorkerRegistry } from "../src/workers/defaults.js";
import { OpenAIResponsesAdapter } from "../src/workers/openai-responses.js";

const secret = "adapter-secret-that-must-not-leak";

test("OpenAI adapter selects only an owner profile and keeps its key out of evidence", async () => {
  const fixture = createFixture();
  try {
    const adapter = new OpenAIResponsesAdapter({
      executable: process.execPath,
      runnerPath: fixture.runnerPath,
      profilesFile: fixture.profilesPath,
      environment: { OPENAI_API_KEY: secret },
    });
    const contract = freezeJobRequest(
      {
        objective: "Make one bounded API-backed edit",
        repositoryPath: fixture.directory,
        adapterId: "openai-responses",
        adapterOptions: { profile: "luna-medium-v1" },
        scope: {
          allowedPaths: ["src/generated.ts"],
          forbiddenPaths: ["private"],
          protectedPaths: ["test"],
        },
        contextRefs: ["docs/brief.md"],
        constraints: ["Keep the proposal bounded"],
        idempotencyKey: "openai-adapter-oracle",
      },
      {
        repositoryRoot: fixture.directory,
        baseRevision: "d".repeat(40),
      },
    );
    const invocation = adapter.buildInvocation(contract, fixture.directory, {
      attemptId: "attempt-test",
      workspaceBaseRevision: "d".repeat(40),
      sourceBaseRevision: "d".repeat(40),
      proposalContributionAttemptIds: [],
    });
    const serializedArguments = JSON.stringify(invocation.args);
    expect(adapter.description).toMatchObject({
      id: "openai-responses",
      available: true,
      hostExecution: "file-edit-only",
      modelIdentity: "required",
    });
    expect(invocation.executable).toBe(process.execPath);
    expect(invocation.cwd).toBe(fixture.directory);
    expect(invocation.env).toEqual({ OPENAI_API_KEY: secret });
    expect(serializedArguments).not.toContain(secret);
    expect(serializedArguments).not.toContain("gpt-5.6-luna");
    expect(serializedArguments).not.toContain("api.openai.com");
    expect(serializedArguments).not.toContain("reasoningEffort");
    expect(serializedArguments).not.toContain("--reasoning-effort");
    expect(serializedArguments).not.toContain("250000");
    expect(invocation.args).toContain("--profile-id");
    expect(invocation.args).toContain("luna-medium-v1");
    expect(invocation.args).toContain("--profiles-file");

    const evidence = adapter.profileEvidence(contract, invocation);
    expect(evidence.modelSelector).toBe("gpt-5.6-luna");
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(evidence.files).toEqual(
      expect.arrayContaining([
        { role: "harness", path: fixture.runnerPath },
        { role: "configuration", path: fixture.profilesPath },
      ]),
    );

    const captured = await captureWorkerExecutionProfile({
      adapter,
      contract,
      invocation,
    });
    expect(captured).toMatchObject({
      status: "complete",
      modelSelector: "gpt-5.6-luna",
      unresolvedReasons: [],
    });
    expect(JSON.stringify(captured)).not.toContain(secret);
  } finally {
    fixture.cleanup();
  }
});

test("OpenAI adapter rejects job-level provider widening", () => {
  const fixture = createFixture();
  try {
    const adapter = new OpenAIResponsesAdapter({
      executable: process.execPath,
      runnerPath: fixture.runnerPath,
      profilesFile: fixture.profilesPath,
      environment: { OPENAI_API_KEY: secret },
    });
    for (const widened of [
      { profile: "luna-medium-v1", model: "gpt-5.6-sol" },
      { profile: "luna-medium-v1", endpoint: "https://example.invalid" },
      { profile: "luna-medium-v1", reasoningEffort: "max" },
      { profile: "luna-medium-v1", maxCostMicroUsd: 5_000_000 },
    ]) {
      const contract = freezeJobRequest(
        {
          objective: "Attempt to widen a profile",
          repositoryPath: fixture.directory,
          adapterId: "openai-responses",
          adapterOptions: widened,
          scope: { allowedPaths: ["src/generated.ts"] },
          idempotencyKey: JSON.stringify(widened),
        },
        {
          repositoryRoot: fixture.directory,
          baseRevision: "e".repeat(40),
        },
      );
      expect(() =>
        adapter.buildInvocation(contract, fixture.directory),
      ).toThrow("only accepts the owner provider profile");
    }
  } finally {
    fixture.cleanup();
  }
});

test("the default registry advertises the API adapter only from owner configuration", () => {
  const fixture = createFixture();
  const previousProfiles = process.env.CONDUCTOR_PROVIDER_PROFILES_FILE;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBun = process.env.CONDUCTOR_OPENAI_RESPONSES_BUN_BIN;
  try {
    process.env.CONDUCTOR_PROVIDER_PROFILES_FILE = fixture.profilesPath;
    process.env.OPENAI_API_KEY = secret;
    delete process.env.CONDUCTOR_OPENAI_RESPONSES_BUN_BIN;
    const description = createDefaultWorkerRegistry()
      .list()
      .find((entry) => entry.id === "openai-responses");
    expect(description).toMatchObject({
      available: true,
      executable: process.execPath,
    });
  } finally {
    restore("CONDUCTOR_PROVIDER_PROFILES_FILE", previousProfiles);
    restore("OPENAI_API_KEY", previousKey);
    restore("CONDUCTOR_OPENAI_RESPONSES_BUN_BIN", previousBun);
    fixture.cleanup();
  }
});

function createFixture() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "conductor-openai-adapter-"),
  );
  const runnerPath = path.join(directory, "runner.ts");
  const profilesPath = path.join(directory, "profiles.json");
  writeFileSync(runnerPath, "export {};\n", "utf8");
  writeFileSync(
    profilesPath,
    `${JSON.stringify({
      schema: "conductor.provider-profiles/v1",
      profiles: {
        "luna-medium-v1": {
          provider: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.6-luna",
          reasoningEffort: "medium",
          serviceTier: "default",
          apiKeyEnvName: "OPENAI_API_KEY",
          rateCard: {
            id: "openai-standard-2026-07-30",
            effectiveDate: "2026-07-30",
            currency: "USD",
            uncachedInputMicroUsdPerMillion: 200_000,
            cachedInputMicroUsdPerMillion: 20_000,
            cacheWriteMicroUsdPerMillion: 250_000,
            outputMicroUsdPerMillion: 1_200_000,
          },
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
        },
      },
    })}\n`,
    "utf8",
  );
  return {
    directory,
    runnerPath,
    profilesPath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
