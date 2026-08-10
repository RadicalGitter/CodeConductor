import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  calculateProviderCostMicroUsd,
  estimateProviderRequestCostMicroUsd,
  fingerprintProviderProfile,
  loadProviderProfileFile,
  resolveProviderProfile,
  type ProviderProfile,
  type ProviderTokenUsage,
} from "../contracts/provider-profile.js";

export interface OpenAIResponsesWorkerRequest {
  profileId: string;
  profileFingerprint: string;
  profile: ProviderProfile;
  workspacePath: string;
  objective: string;
  allowedPaths: string[];
  contextRefs: string[];
  constraints: string[];
  escalateWhen: string[];
  sourceBaseRevision: string;
  workspaceBaseRevision: string;
}

export interface OpenAIResponsesRunEvidence {
  schema: "conductor.openai-responses-run/v1";
  status: "completed" | "failed";
  profileId: string;
  profileFingerprint: string;
  provider: "openai-responses";
  requestedModel: string;
  returnedModels: string[];
  reasoningEffort: ProviderProfile["reasoningEffort"];
  requestedServiceTier: ProviderProfile["serviceTier"];
  returnedServiceTiers: string[];
  rateCardId: string;
  requestIds: string[];
  responseIds: string[];
  requestCount: number;
  retryCount: number;
  toolCallCount: number;
  durationMs: number;
  usage: ProviderTokenUsage;
  costMicroUsd: number;
  maxCostMicroUsd: number;
  evidenceLimitations: string[];
  failure?: {
    kind:
      | "invalid-request"
      | "missing-secret"
      | "budget-exceeded"
      | "provider-error"
      | "malformed-response"
      | "tool-error";
    message: string;
  };
}

export interface OpenAIResponsesRunnerDependencies {
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  environment?: Record<string, string | undefined>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type FailureKind = NonNullable<OpenAIResponsesRunEvidence["failure"]>["kind"];

interface RunState {
  startedAt: number;
  requestIds: string[];
  responseIds: string[];
  returnedModels: string[];
  returnedServiceTiers: string[];
  requestCount: number;
  retryCount: number;
  toolCallCount: number;
  usage: ProviderTokenUsage;
  evidenceLimitations: string[];
}

const transientStatuses = new Set([408, 409, 429]);
const emptyUsage = (): ProviderTokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

export async function runOpenAIResponsesWorker(
  request: OpenAIResponsesWorkerRequest,
  dependencies: OpenAIResponsesRunnerDependencies = {},
): Promise<OpenAIResponsesRunEvidence> {
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const environment = dependencies.environment ?? process.env;
  const state: RunState = {
    startedAt: now(),
    requestIds: [],
    responseIds: [],
    returnedModels: [],
    returnedServiceTiers: [],
    requestCount: 0,
    retryCount: 0,
    toolCallCount: 0,
    usage: emptyUsage(),
    evidenceLimitations: [],
  };
  const secret = environment[request.profile.apiKeyEnvName];
  if (!secret) {
    return evidence(
      request,
      state,
      now,
      "missing-secret",
      "API key is not configured",
    );
  }

  let workspaceRoot: string;
  let readablePaths: Set<string>;
  let writablePaths: Set<string>;
  try {
    workspaceRoot = realpathSync(request.workspacePath);
    readablePaths = new Set(
      [...request.contextRefs, ...request.allowedPaths].map(
        normalizeRelativePath,
      ),
    );
    writablePaths = new Set(request.allowedPaths.map(normalizeRelativePath));
  } catch {
    return evidence(
      request,
      state,
      now,
      "invalid-request",
      "Workspace or positive path scope is invalid",
    );
  }

  if (!requestFitsBudget(request, state.usage)) {
    return evidence(
      request,
      state,
      now,
      "budget-exceeded",
      "Conservative request estimate exceeds the provider budget",
    );
  }

  const input: unknown[] = [
    {
      role: "user",
      content: buildInitialPrompt(request),
    },
  ];

  for (;;) {
    if (state.requestCount >= request.profile.budget.maxRequests) {
      return evidence(
        request,
        state,
        now,
        "budget-exceeded",
        "Request count ceiling reached before completion",
      );
    }
    if (!requestFitsBudget(request, state.usage)) {
      return evidence(
        request,
        state,
        now,
        "budget-exceeded",
        "Continuation request would exceed the provider budget",
      );
    }

    const providerResult = await sendProviderRequest({
      request,
      state,
      input,
      secret,
      fetchImpl,
      sleep,
    });
    if (providerResult.failure) {
      return evidence(
        request,
        state,
        now,
        providerResult.failure.kind,
        providerResult.failure.message,
      );
    }
    const response = providerResult.response!;
    const parsed = await parseProviderResponse(
      response,
      state,
      request.profile.serviceTier,
    );
    if (parsed.failure) {
      return evidence(
        request,
        state,
        now,
        parsed.failure.kind,
        parsed.failure.message,
      );
    }

    state.usage = addUsage(state.usage, parsed.usage!);
    const actualCost = calculateProviderCostMicroUsd(
      state.usage,
      request.profile.rateCard,
    );
    if (
      state.usage.inputTokens > request.profile.budget.maxInputTokens ||
      state.usage.outputTokens > request.profile.budget.maxOutputTokens ||
      actualCost > request.profile.budget.maxCostMicroUsd
    ) {
      return evidence(
        request,
        state,
        now,
        "budget-exceeded",
        "Reported provider usage exceeds the owner budget",
      );
    }

    const responseOutput = parsed.output!;
    input.push(...responseOutput);
    const functionCalls = responseOutput.filter(isFunctionCall);
    if (functionCalls.length === 0) {
      return evidence(request, state, now);
    }

    for (const call of functionCalls) {
      state.toolCallCount += 1;
      if (state.toolCallCount > request.profile.budget.maxToolCalls) {
        return evidence(
          request,
          state,
          now,
          "budget-exceeded",
          "Tool call ceiling reached before mutation",
        );
      }
      const output = executeToolCall({
        call,
        workspaceRoot,
        readablePaths,
        writablePaths,
        maxBytes: request.profile.budget.maxToolOutputBytes,
      });
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output,
      });
    }
  }
}

async function sendProviderRequest(input: {
  request: OpenAIResponsesWorkerRequest;
  state: RunState;
  input: unknown[];
  secret: string;
  fetchImpl: NonNullable<OpenAIResponsesRunnerDependencies["fetch"]>;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<{
  response?: Response;
  failure?: { kind: FailureKind; message: string };
}> {
  const { request, state } = input;
  const url = `${request.profile.baseUrl.replace(/\/$/, "")}/responses`;
  const body = JSON.stringify({
    model: request.profile.model,
    input: input.input,
    store: false,
    parallel_tool_calls: false,
    reasoning: { effort: request.profile.reasoningEffort },
    service_tier: request.profile.serviceTier,
    max_output_tokens: request.profile.budget.maxOutputTokens,
    tools: toolDefinitions,
  });

  for (let retry = 0; retry <= request.profile.budget.maxRetries; retry += 1) {
    if (state.requestCount >= request.profile.budget.maxRequests) {
      return {
        failure: {
          kind: "budget-exceeded",
          message: "Request count ceiling reached during retries",
        },
      };
    }
    state.requestCount += 1;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.profile.budget.requestTimeoutMs,
    );
    let response: Response;
    try {
      response = await input.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.secret}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      if (retry >= request.profile.budget.maxRetries) {
        return {
          failure: {
            kind: "provider-error",
            message: "Provider request failed after bounded retries",
          },
        };
      }
      state.retryCount += 1;
      await input.sleep(100 * (retry + 1));
      continue;
    }
    clearTimeout(timeout);
    const requestId = response.headers.get("x-request-id");
    if (requestId) state.requestIds.push(requestId);
    if (response.ok) return { response };
    if (
      (transientStatuses.has(response.status) || response.status >= 500) &&
      retry < request.profile.budget.maxRetries
    ) {
      state.retryCount += 1;
      await input.sleep(100 * (retry + 1));
      continue;
    }
    return {
      failure: {
        kind: "provider-error",
        message: `Provider returned HTTP ${response.status}; body omitted`,
      },
    };
  }
  return {
    failure: { kind: "provider-error", message: "Provider retry loop ended" },
  };
}

async function parseProviderResponse(
  response: Response,
  state: RunState,
  requestedServiceTier: ProviderProfile["serviceTier"],
): Promise<{
  output?: unknown[];
  usage?: ProviderTokenUsage;
  failure?: { kind: FailureKind; message: string };
}> {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    parsed = value as Record<string, unknown>;
  } catch {
    return {
      failure: {
        kind: "malformed-response",
        message: "Provider response is not a JSON object",
      },
    };
  }
  if (typeof parsed.id !== "string" || !Array.isArray(parsed.output)) {
    return {
      failure: {
        kind: "malformed-response",
        message: "Provider response is missing an id or output array",
      },
    };
  }
  state.responseIds.push(parsed.id);
  if (
    typeof parsed.model === "string" &&
    !state.returnedModels.includes(parsed.model)
  ) {
    state.returnedModels.push(parsed.model);
  }
  if (
    typeof parsed.service_tier === "string" &&
    parsed.service_tier.length > 0
  ) {
    if (!state.returnedServiceTiers.includes(parsed.service_tier)) {
      state.returnedServiceTiers.push(parsed.service_tier);
    }
    if (!serviceTiersMatch(requestedServiceTier, parsed.service_tier)) {
      addLimitation(
        state.evidenceLimitations,
        "Provider response reported a different service tier than requested",
      );
    }
  } else {
    addLimitation(
      state.evidenceLimitations,
      "Provider did not report its service tier",
    );
  }
  const usage = parseUsage(parsed.usage, state.evidenceLimitations);
  if (!usage) {
    return {
      failure: {
        kind: "malformed-response",
        message: "Provider response is missing valid usage",
      },
    };
  }
  return { output: parsed.output, usage };
}

function serviceTiersMatch(requested: string, returned: string): boolean {
  const normalize = (value: string) =>
    value === "fast" || value === "priority" ? "priority" : value.toLowerCase();
  return normalize(requested) === normalize(returned);
}

function parseUsage(
  value: unknown,
  limitations: string[],
): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const usage = value as Record<string, unknown>;
  const inputDetails = objectRecord(usage.input_tokens_details);
  const outputDetails = objectRecord(usage.output_tokens_details);
  const inputTokens = nonnegativeInteger(usage.input_tokens);
  const outputTokens = nonnegativeInteger(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens =
    nonnegativeInteger(inputDetails?.cached_tokens) ?? 0;
  const cacheWriteTokens =
    nonnegativeInteger(inputDetails?.cache_write_tokens) ?? 0;
  const reasoningTokens =
    nonnegativeInteger(outputDetails?.reasoning_tokens) ?? 0;
  if (!inputDetails || inputDetails.cache_write_tokens === undefined) {
    addLimitation(limitations, "Provider did not report cache-write tokens");
  }
  if (!outputDetails || outputDetails.reasoning_tokens === undefined) {
    addLimitation(limitations, "Provider did not report reasoning tokens");
  }
  if (cachedInputTokens + cacheWriteTokens > inputTokens) return undefined;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
  };
}

function executeToolCall(input: {
  call: FunctionCall;
  workspaceRoot: string;
  readablePaths: Set<string>;
  writablePaths: Set<string>;
  maxBytes: number;
}): string {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.call.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    args = parsed as Record<string, unknown>;
  } catch {
    return "tool error: arguments must be a JSON object";
  }
  try {
    if (input.call.name === "read_file") {
      if (Object.keys(args).length !== 1 || typeof args.path !== "string") {
        return "tool error: read_file requires only a string path";
      }
      const relative = normalizeRelativePath(args.path);
      if (!input.readablePaths.has(relative))
        return `tool error: path out of scope: ${relative}`;
      const target = resolveExistingFile(input.workspaceRoot, relative);
      const content = readFileSync(target);
      if (content.byteLength > input.maxBytes)
        return "tool error: file exceeds tool byte ceiling";
      return content.toString("utf8");
    }
    if (input.call.name === "write_file") {
      if (
        Object.keys(args).length !== 2 ||
        typeof args.path !== "string" ||
        typeof args.content !== "string"
      ) {
        return "tool error: write_file requires only string path and content";
      }
      const relative = normalizeRelativePath(args.path);
      if (!input.writablePaths.has(relative))
        return `tool error: path out of scope: ${relative}`;
      if (Buffer.byteLength(args.content, "utf8") > input.maxBytes) {
        return "tool error: content exceeds tool byte ceiling";
      }
      atomicScopedWrite(input.workspaceRoot, relative, args.content);
      return `wrote ${relative}`;
    }
    return `tool error: unknown tool ${input.call.name}`;
  } catch {
    return `tool error: ${input.call.name} refused the requested path`;
  }
}

interface FunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

function isFunctionCall(value: unknown): value is FunctionCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.type === "function_call" &&
    typeof item.call_id === "string" &&
    typeof item.name === "string" &&
    typeof item.arguments === "string"
  );
}

function requestFitsBudget(
  request: OpenAIResponsesWorkerRequest,
  usage: ProviderTokenUsage,
): boolean {
  const current = calculateProviderCostMicroUsd(
    usage,
    request.profile.rateCard,
  );
  const next = estimateProviderRequestCostMicroUsd(
    request.profile.budget.maxInputTokens,
    request.profile.budget.maxOutputTokens,
    request.profile.rateCard,
  );
  return current + next <= request.profile.budget.maxCostMicroUsd;
}

function evidence(
  request: OpenAIResponsesWorkerRequest,
  state: RunState,
  now: () => number,
  failureKind?: FailureKind,
  failureMessage?: string,
): OpenAIResponsesRunEvidence {
  return {
    schema: "conductor.openai-responses-run/v1",
    status: failureKind ? "failed" : "completed",
    profileId: request.profileId,
    profileFingerprint: request.profileFingerprint,
    provider: "openai-responses",
    requestedModel: request.profile.model,
    returnedModels: [...state.returnedModels],
    reasoningEffort: request.profile.reasoningEffort,
    requestedServiceTier: request.profile.serviceTier,
    returnedServiceTiers: [...state.returnedServiceTiers],
    rateCardId: request.profile.rateCard.id,
    requestIds: [...state.requestIds],
    responseIds: [...state.responseIds],
    requestCount: state.requestCount,
    retryCount: state.retryCount,
    toolCallCount: state.toolCallCount,
    durationMs: Math.max(0, now() - state.startedAt),
    usage: { ...state.usage },
    costMicroUsd: calculateProviderCostMicroUsd(
      state.usage,
      request.profile.rateCard,
    ),
    maxCostMicroUsd: request.profile.budget.maxCostMicroUsd,
    evidenceLimitations: [...state.evidenceLimitations],
    ...(failureKind
      ? { failure: { kind: failureKind, message: failureMessage! } }
      : {}),
  };
}

function buildInitialPrompt(request: OpenAIResponsesWorkerRequest): string {
  return `Complete this bounded coding proposal:\n${request.objective}\n\nAllowed write paths:\n- ${request.allowedPaths.join("\n- ")}\n\nSelected context/read paths:\n- ${request.contextRefs.join("\n- ")}\n\nConstraints:\n- ${request.constraints.join("\n- ")}\n\nStop when:\n- ${request.escalateWhen.join("\n- ")}\n\nUse only read_file and write_file. The frozen source revision is ${request.sourceBaseRevision}; the workspace baseline is ${request.workspaceBaseRevision}.`;
}

function normalizeRelativePath(candidate: string): string {
  if (
    !candidate ||
    candidate.includes("\0") ||
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate)
  ) {
    throw new Error("invalid path");
  }
  const portable = candidate.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("invalid path");
  }
  return portable;
}

function resolveExistingFile(workspaceRoot: string, relative: string): string {
  const target = realpathSync(path.resolve(workspaceRoot, relative));
  assertWithin(workspaceRoot, target);
  if (!statSync(target).isFile()) throw new Error("not a file");
  return target;
}

function atomicScopedWrite(
  workspaceRoot: string,
  relative: string,
  content: string,
): void {
  const target = path.resolve(workspaceRoot, relative);
  assertWithin(workspaceRoot, target);
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true });
  assertWithin(workspaceRoot, realpathSync(parent));
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error("symlink target");
    assertWithin(workspaceRoot, realpathSync(target));
  }
  const temporary = `${target}.conductor-openai-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertWithin(workspaceRoot: string, target: string): void {
  const relative = path.relative(workspaceRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes workspace");
  }
}

function addUsage(
  left: ProviderTokenUsage,
  right: ProviderTokenUsage,
): ProviderTokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function addLimitation(limitations: string[], limitation: string): void {
  if (!limitations.includes(limitation)) limitations.push(limitation);
}

const toolDefinitions = [
  {
    type: "function",
    name: "read_file",
    strict: true,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
] as const;

if (import.meta.main) {
  try {
    const cli = parseCliArguments(process.argv.slice(2));
    const profileFile = loadProviderProfileFile(cli.profilesFile);
    const profile = resolveProviderProfile(profileFile, cli.profileId);
    const result = await runOpenAIResponsesWorker(
      {
        profileId: cli.profileId,
        profileFingerprint: fingerprintProviderProfile(profile),
        profile,
        workspacePath: cli.workspacePath,
        objective: cli.objective,
        allowedPaths: cli.allowedPaths,
        contextRefs: cli.contextRefs,
        constraints: cli.constraints,
        escalateWhen: cli.escalateWhen,
        sourceBaseRevision: cli.sourceBaseRevision,
        workspaceBaseRevision: cli.workspaceBaseRevision,
      },
      { environment: process.env },
    );
    console.log(JSON.stringify(result));
    if (result.status === "failed") process.exitCode = 1;
  } catch {
    console.error("OpenAI Responses runner rejected invalid owner invocation");
    process.exitCode = 1;
  }
}

function parseCliArguments(arguments_: string[]): {
  profilesFile: string;
  profileId: string;
  workspacePath: string;
  objective: string;
  allowedPaths: string[];
  contextRefs: string[];
  constraints: string[];
  escalateWhen: string[];
  sourceBaseRevision: string;
  workspaceBaseRevision: string;
} {
  const singles = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const repeatable = new Set([
    "--allowed-path",
    "--context-ref",
    "--constraint",
    "--escalate-when",
  ]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error("invalid args");
    if (repeatable.has(flag)) {
      repeated.set(flag, [...(repeated.get(flag) ?? []), value]);
    } else if (singles.has(flag)) {
      throw new Error("duplicate arg");
    } else {
      singles.set(flag, value);
    }
  }
  const required = (name: string): string => {
    const value = singles.get(name);
    if (!value) throw new Error(`missing ${name}`);
    return value;
  };
  const allowedPaths = repeated.get("--allowed-path") ?? [];
  if (allowedPaths.length === 0) throw new Error("missing allowed path");
  return {
    profilesFile: required("--profiles-file"),
    profileId: required("--profile-id"),
    workspacePath: required("--workspace"),
    objective: required("--objective"),
    allowedPaths,
    contextRefs: repeated.get("--context-ref") ?? [],
    constraints: repeated.get("--constraint") ?? [],
    escalateWhen: repeated.get("--escalate-when") ?? [],
    sourceBaseRevision: required("--source-base-revision"),
    workspaceBaseRevision: required("--workspace-base-revision"),
  };
}
