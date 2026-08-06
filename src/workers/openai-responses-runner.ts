import type {
  ProviderProfile,
  ProviderTokenUsage,
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

export async function runOpenAIResponsesWorker(
  _request: OpenAIResponsesWorkerRequest,
  _dependencies: OpenAIResponsesRunnerDependencies = {},
): Promise<OpenAIResponsesRunEvidence> {
  throw new Error("OpenAI Responses worker runner is not implemented");
}
