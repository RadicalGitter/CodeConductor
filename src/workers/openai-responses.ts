import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  providerProfileFileSchema,
  type ProviderProfile,
  type ProviderProfileFile,
} from "../contracts/provider-profile.js";
import type { JobContract } from "../contracts/job.js";
import { resolveExecutablePath } from "../runtime/executable.js";
import type { ProcessInvocation } from "../runtime/process-runner.js";
import type {
  WorkerAdapter,
  WorkerAttemptContext,
  WorkerProfileEvidence,
} from "./adapter.js";

export interface OpenAIResponsesAdapterOptions {
  executable?: string;
  runnerPath?: string;
  profilesFile?: string;
  environment?: Record<string, string | undefined>;
}

export class OpenAIResponsesAdapter implements WorkerAdapter {
  readonly description;
  private readonly executable?: string;
  private readonly runnerPath: string;
  private readonly profilesFile?: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly profileFile?: ProviderProfileFile;

  constructor(options: OpenAIResponsesAdapterOptions = {}) {
    const requestedExecutable =
      options.executable ??
      process.env.CONDUCTOR_OPENAI_RESPONSES_BUN_BIN ??
      (process.versions.bun ? process.execPath : "bun");
    this.executable = resolveExecutablePath(requestedExecutable);
    this.runnerPath = path.resolve(
      options.runnerPath ??
        process.env.CONDUCTOR_OPENAI_RESPONSES_RUNNER ??
        fileURLToPath(new URL("./openai-responses-runner.ts", import.meta.url)),
    );
    this.profilesFile = options.profilesFile
      ? path.resolve(options.profilesFile)
      : process.env.CONDUCTOR_PROVIDER_PROFILES_FILE
        ? path.resolve(process.env.CONDUCTOR_PROVIDER_PROFILES_FILE)
        : undefined;
    this.environment = options.environment ?? process.env;
    this.profileFile = this.tryLoadProfiles();
    const hasUsableProfile = Object.values(
      this.profileFile?.profiles ?? {},
    ).some((profile) => Boolean(this.environment[profile.apiKeyEnvName]));
    this.description = {
      id: "openai-responses",
      label: "OpenAI Responses API",
      executable: this.executable ?? requestedExecutable,
      mutationMode: "worktree" as const,
      outputFormat: "jsonl" as const,
      safetyMode: "strict-profiled-file-tools",
      available:
        this.executable !== undefined &&
        isAbsoluteFile(this.runnerPath) &&
        this.profileFile !== undefined &&
        hasUsableProfile,
      hostExecution: "file-edit-only" as const,
      modelIdentity: "required" as const,
    };
  }

  buildInvocation(
    contract: JobContract,
    workspacePath: string,
    attemptContext?: WorkerAttemptContext,
  ): ProcessInvocation {
    const profileId = validateProfileSelection(contract.worker.options);
    const profile = this.selectProfile(profileId);
    if (!this.executable || !isAbsoluteFile(this.runnerPath)) {
      throw new Error("OpenAI Responses runner is unavailable");
    }
    const secret = this.environment[profile.apiKeyEnvName];
    if (!secret) {
      throw new Error("OpenAI Responses API key is not configured");
    }
    const sourceBaseRevision =
      attemptContext?.sourceBaseRevision ?? contract.repository.baseRevision;
    const workspaceBaseRevision =
      attemptContext?.workspaceBaseRevision ?? contract.repository.baseRevision;
    return {
      executable: this.executable,
      args: [
        this.runnerPath,
        "--profiles-file",
        this.profilesFile!,
        "--profile-id",
        profileId,
        "--workspace",
        workspacePath,
        "--objective",
        contract.objective,
        ...repeatedArguments("--allowed-path", contract.scope.allowedPaths),
        ...repeatedArguments("--context-ref", contract.contextRefs),
        ...repeatedArguments("--constraint", contract.constraints),
        ...repeatedArguments("--escalate-when", contract.escalateWhen),
        "--source-base-revision",
        sourceBaseRevision,
        "--workspace-base-revision",
        workspaceBaseRevision,
      ],
      cwd: workspacePath,
      env: { [profile.apiKeyEnvName]: secret },
    };
  }

  profileEvidence(
    contract: JobContract,
    _invocation: ProcessInvocation,
  ): WorkerProfileEvidence {
    const profile = this.selectProfile(
      validateProfileSelection(contract.worker.options),
    );
    return {
      files: [
        { role: "harness", path: this.runnerPath },
        { role: "configuration", path: this.profilesFile! },
      ],
      attributes: { profileId: contract.worker.options.profile as string },
      modelSelector: profile.model,
    };
  }

  private tryLoadProfiles(): ProviderProfileFile | undefined {
    if (!this.profilesFile || !isAbsoluteFile(this.profilesFile))
      return undefined;
    try {
      return providerProfileFileSchema.parse(
        JSON.parse(readFileSync(this.profilesFile, "utf8")),
      );
    } catch {
      return undefined;
    }
  }

  private selectProfile(profileId: string): ProviderProfile {
    const profile = this.profileFile?.profiles[profileId];
    if (!profile) {
      throw new Error(
        `OpenAI Responses adapter only accepts the owner provider profile; unknown profile: ${profileId}`,
      );
    }
    return profile;
  }
}

function validateProfileSelection(options: Record<string, unknown>): string {
  const keys = Object.keys(options);
  if (
    keys.length !== 1 ||
    keys[0] !== "profile" ||
    typeof options.profile !== "string" ||
    options.profile.trim() === ""
  ) {
    throw new Error(
      "OpenAI Responses adapter only accepts the owner provider profile ID",
    );
  }
  return options.profile.trim();
}

function repeatedArguments(flag: string, values: string[]): string[] {
  return values.flatMap((value) => [flag, value]);
}

function isAbsoluteFile(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
