import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderProfile } from "../src/contracts/provider-profile.js";
import {
  runOpenAIResponsesWorker,
  type OpenAIResponsesRunnerDependencies,
  type OpenAIResponsesWorkerRequest,
} from "../src/workers/openai-responses-runner.js";

const secret = "test-secret-that-must-not-appear";

test("Responses tool loop preserves output items and applies only bounded writes", async () => {
  const fixture = createFixture();
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: NonNullable<
    OpenAIResponsesRunnerDependencies["fetch"]
  > = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${secret}`,
    );
    if (bodies.length === 1) {
      return response(
        "resp-read",
        [
          {
            type: "function_call",
            id: "fc-read",
            call_id: "call-read",
            name: "read_file",
            arguments: JSON.stringify({ path: "context/brief.txt" }),
          },
        ],
        "req-read",
      );
    }
    if (bodies.length === 2) {
      return response(
        "resp-write",
        [
          {
            type: "function_call",
            id: "fc-write",
            call_id: "call-write",
            name: "write_file",
            arguments: JSON.stringify({
              path: "src/generated.txt",
              content: "implemented from selected context\n",
            }),
          },
        ],
        "req-write",
      );
    }
    return response(
      "resp-final",
      [
        {
          type: "message",
          id: "msg-final",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        },
      ],
      "req-final",
    );
  };

  try {
    const evidence = await runOpenAIResponsesWorker(fixture.request, {
      fetch: fetchImpl,
      environment: { OPENAI_API_KEY: secret },
      now: increasingClock(),
      sleep: async () => undefined,
    });
    expect(evidence.status).toBe("completed");
    expect(evidence.requestCount).toBe(3);
    expect(evidence.toolCallCount).toBe(2);
    expect(evidence.requestedServiceTier).toBe("priority");
    expect(evidence.returnedServiceTiers).toEqual(["priority"]);
    expect(evidence.requestIds).toEqual(["req-read", "req-write", "req-final"]);
    expect(evidence.responseIds).toEqual([
      "resp-read",
      "resp-write",
      "resp-final",
    ]);
    expect(evidence.usage).toEqual({
      inputTokens: 300,
      cachedInputTokens: 30,
      cacheWriteTokens: 15,
      outputTokens: 60,
      reasoningTokens: 15,
    });
    expect(evidence.costMicroUsd).toBe(128);
    expect(readFileSync(fixture.allowedTarget, "utf8")).toBe(
      "implemented from selected context\n",
    );

    expect(bodies[0]).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      parallel_tool_calls: false,
      reasoning: { effort: "medium" },
      service_tier: "priority",
      max_output_tokens: 4_096,
    });
    expect(JSON.stringify(bodies[0])).not.toContain("unselected-private-data");
    expect(bodies[0]?.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "read_file",
        strict: true,
        parameters: expect.objectContaining({ additionalProperties: false }),
      }),
      expect.objectContaining({
        type: "function",
        name: "write_file",
        strict: true,
        parameters: expect.objectContaining({ additionalProperties: false }),
      }),
    ]);
    expect(JSON.stringify((bodies[1] as { input: unknown }).input)).toContain(
      "call-read",
    );
    expect(JSON.stringify((bodies[2] as { input: unknown }).input)).toContain(
      "call-write",
    );
    expect(JSON.stringify(evidence)).not.toContain(secret);
  } finally {
    fixture.cleanup();
  }
});

test("out-of-scope tool calls return a bounded error without mutating", async () => {
  const fixture = createFixture();
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: NonNullable<
    OpenAIResponsesRunnerDependencies["fetch"]
  > = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (bodies.length === 1) {
      return response("resp-bad", [
        {
          type: "function_call",
          id: "fc-bad",
          call_id: "call-bad",
          name: "write_file",
          arguments: JSON.stringify({
            path: "private/secret.txt",
            content: "changed\n",
          }),
        },
      ]);
    }
    return response("resp-final", [
      {
        type: "message",
        id: "msg-final",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "stopped", annotations: [] }],
      },
    ]);
  };
  try {
    const evidence = await runOpenAIResponsesWorker(fixture.request, {
      fetch: fetchImpl,
      environment: { OPENAI_API_KEY: secret },
      now: increasingClock(),
      sleep: async () => undefined,
    });
    expect(evidence.status).toBe("completed");
    expect(readFileSync(fixture.privateTarget, "utf8")).toBe(
      "unselected-private-data\n",
    );
    expect(JSON.stringify((bodies[1] as { input: unknown }).input)).toContain(
      "out of scope",
    );
  } finally {
    fixture.cleanup();
  }
});

test("missing secrets and conservative budget failures happen before network", async () => {
  const fixture = createFixture();
  let calls = 0;
  const fetchImpl: NonNullable<
    OpenAIResponsesRunnerDependencies["fetch"]
  > = async () => {
    calls += 1;
    return response("unexpected", []);
  };
  try {
    const missing = await runOpenAIResponsesWorker(fixture.request, {
      fetch: fetchImpl,
      environment: {},
      now: increasingClock(),
      sleep: async () => undefined,
    });
    expect(missing).toMatchObject({
      status: "failed",
      failure: { kind: "missing-secret" },
    });
    expect(JSON.stringify(missing)).not.toContain(secret);

    const overBudget: OpenAIResponsesWorkerRequest = {
      ...fixture.request,
      profile: {
        ...fixture.profile,
        budget: { ...fixture.profile.budget, maxCostMicroUsd: 1 },
      },
    };
    const refused = await runOpenAIResponsesWorker(overBudget, {
      fetch: fetchImpl,
      environment: { OPENAI_API_KEY: secret },
      now: increasingClock(),
      sleep: async () => undefined,
    });
    expect(refused).toMatchObject({
      status: "failed",
      failure: { kind: "budget-exceeded" },
    });
    expect(calls).toBe(0);
  } finally {
    fixture.cleanup();
  }
});

test("transient provider failures retry within the owner profile ceiling", async () => {
  const fixture = createFixture();
  let calls = 0;
  const fetchImpl: NonNullable<
    OpenAIResponsesRunnerDependencies["fetch"]
  > = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("do not retain provider body", {
        status: 429,
        headers: { "x-request-id": "req-rate-limit" },
      });
    }
    return response("resp-final", [
      {
        type: "message",
        id: "msg-final",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "done", annotations: [] }],
      },
    ]);
  };
  try {
    const evidence = await runOpenAIResponsesWorker(fixture.request, {
      fetch: fetchImpl,
      environment: { OPENAI_API_KEY: secret },
      now: increasingClock(),
      sleep: async () => undefined,
    });
    expect(evidence.status).toBe("completed");
    expect(evidence.retryCount).toBe(1);
    expect(evidence.requestCount).toBe(2);
    expect(JSON.stringify(evidence)).not.toContain("provider body");
  } finally {
    fixture.cleanup();
  }
});

test("records provider service-tier fallback without pretending Fast was honored", async () => {
  const fixture = createFixture();
  try {
    const evidence = await runOpenAIResponsesWorker(fixture.request, {
      fetch: async () =>
        response(
          "resp-standard",
          [
            {
              type: "message",
              id: "msg-standard",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "done", annotations: [] }],
            },
          ],
          "req-standard",
          "default",
        ),
      environment: { OPENAI_API_KEY: secret },
      now: increasingClock(),
      sleep: async () => undefined,
    });
    expect(evidence).toMatchObject({
      status: "completed",
      requestedServiceTier: "priority",
      returnedServiceTiers: ["default"],
    });
    expect(evidence.evidenceLimitations).toContain(
      "Provider response reported a different service tier than requested",
    );
  } finally {
    fixture.cleanup();
  }
});

function createFixture() {
  const workspace = mkdtempSync(
    path.join(os.tmpdir(), "conductor-openai-runner-"),
  );
  mkdirSync(path.join(workspace, "context"));
  mkdirSync(path.join(workspace, "src"));
  mkdirSync(path.join(workspace, "private"));
  writeFileSync(path.join(workspace, "context", "brief.txt"), "selected\n");
  writeFileSync(
    path.join(workspace, "private", "secret.txt"),
    "unselected-private-data\n",
  );

  const profile: ProviderProfile = {
    provider: "openai-responses",
    baseUrl: "https://api.openai.test/v1",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    serviceTier: "priority",
    apiKeyEnvName: "OPENAI_API_KEY",
    rateCard: {
      id: "test-rate",
      effectiveDate: "2026-08-06",
      currency: "USD",
      uncachedInputMicroUsdPerMillion: 200_000,
      cachedInputMicroUsdPerMillion: 20_000,
      cacheWriteMicroUsdPerMillion: 250_000,
      outputMicroUsdPerMillion: 1_200_000,
    },
    budget: {
      requestTimeoutMs: 30_000,
      maxRequests: 8,
      maxRetries: 2,
      maxToolCalls: 8,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_096,
      maxToolOutputBytes: 32_768,
      maxCostMicroUsd: 100_000,
    },
  };
  const request: OpenAIResponsesWorkerRequest = {
    profileId: "test-medium",
    profileFingerprint: "f".repeat(64),
    profile,
    workspacePath: workspace,
    objective: "Write the bounded generated file",
    allowedPaths: ["src/generated.txt"],
    contextRefs: ["context/brief.txt"],
    constraints: ["Do not read private files"],
    escalateWhen: ["The selected context is insufficient"],
    sourceBaseRevision: "a".repeat(40),
    workspaceBaseRevision: "a".repeat(40),
  };
  return {
    workspace,
    profile,
    request,
    allowedTarget: path.join(workspace, "src", "generated.txt"),
    privateTarget: path.join(workspace, "private", "secret.txt"),
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

function response(
  id: string,
  output: unknown[],
  requestId = `req-${id}`,
  serviceTier = "priority",
): Response {
  return Response.json(
    {
      id,
      object: "response",
      status: "completed",
      model: "gpt-5.6-luna",
      service_tier: serviceTier,
      output,
      usage: {
        input_tokens: 100,
        input_tokens_details: {
          cached_tokens: 10,
          cache_write_tokens: 5,
        },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 120,
      },
    },
    { headers: { "x-request-id": requestId } },
  );
}

function increasingClock(): () => number {
  let value = 1_000;
  return () => {
    value += 5;
    return value;
  };
}
