import path from "node:path";
import { realpath } from "node:fs/promises";

import type { CommandSpec, ExecutionBoundary } from "../contracts/job.js";
import type { ExternalResource } from "../contracts/attempt.js";
import { selectRequestedEnvironment } from "../runtime/environment.js";
import { runProcess } from "../runtime/process-runner.js";
import type {
  ProcessExecutionResult,
  ProcessGuardianIdentity,
  ProcessResult,
} from "../runtime/process-runner.js";
import { buildSandboxedCommand } from "../sandbox/docker.js";
import type { CommandEvidence } from "./types.js";

export class ExecutionPolicy {
  private readonly executables: Set<string>;
  private readonly environmentNames: Set<string>;

  constructor(
    input: {
      allowedExecutables?: readonly string[];
      allowedEnvironmentNames?: readonly string[];
    } = {},
  ) {
    for (const executable of input.allowedExecutables ?? []) {
      if (!path.isAbsolute(executable)) {
        throw new Error(
          `Allowed command executable must be absolute: ${executable}`,
        );
      }
    }
    this.executables = new Set(
      (input.allowedExecutables ?? []).map(normalizePolicyValue),
    );
    this.environmentNames = new Set(
      (input.allowedEnvironmentNames ?? []).map(normalizeEnvironmentName),
    );
  }

  static fromEnvironment(
    extras: {
      allowedExecutables?: readonly string[];
      allowedEnvironmentNames?: readonly string[];
    } = {},
  ): ExecutionPolicy {
    return new ExecutionPolicy({
      allowedExecutables: [
        ...parseList(process.env.CONDUCTOR_COMMAND_ALLOWLIST),
        ...(extras.allowedExecutables ?? []),
      ],
      allowedEnvironmentNames: [
        ...parseList(process.env.CONDUCTOR_COMMAND_ENV_ALLOWLIST),
        ...(extras.allowedEnvironmentNames ?? []),
      ],
    });
  }

  validate(command: CommandSpec): void {
    if (!path.isAbsolute(command.executable)) {
      throw new Error(
        `Command executable must be absolute: ${command.executable}`,
      );
    }
    if (!this.executables.has(normalizePolicyValue(command.executable))) {
      throw new Error(
        `Executable is not allowed by runtime policy: ${command.executable}`,
      );
    }
    for (const name of command.inheritEnv) {
      if (!this.environmentNames.has(normalizeEnvironmentName(name))) {
        throw new Error(
          `Environment name is not allowed by runtime policy: ${name}`,
        );
      }
    }
  }
}

export async function executeCommand(input: {
  command: CommandSpec;
  phase: "setup" | "acceptance";
  index: number;
  workspacePath: string;
  artifactDirectory: string;
  defaultTimeoutMs: number;
  policy: ExecutionPolicy;
  signal: AbortSignal;
  onGuardianReady?: (identity: ProcessGuardianIdentity) => void | Promise<void>;
  onProcessResult?: (result: ProcessResult) => void | Promise<void>;
  executionBoundary?: ExecutionBoundary;
  attemptId?: string;
  onExternalResource?: (resource: ExternalResource) => void | Promise<void>;
  onExternalResourceReleased?: (
    resourceId: string,
    cleanup: ProcessExecutionResult,
  ) => void | Promise<void>;
}): Promise<CommandEvidence> {
  const executionBoundary = input.executionBoundary ?? {
    kind: "host-worktree" as const,
  };
  const lexicalCwd = path.resolve(
    input.workspacePath,
    input.command.cwd ?? ".",
  );
  let resolvedCwd: string;
  try {
    resolvedCwd = await resolveInsideWorkspace(
      input.workspacePath,
      input.command.cwd,
    );
  } catch (error) {
    return {
      phase: input.phase,
      index: input.index,
      command: input.command,
      resolvedCwd: lexicalCwd,
      executionBoundary:
        executionBoundary.kind === "host-worktree"
          ? executionBoundary
          : sandboxEvidenceWithoutContainer(executionBoundary),
      status: "policy-denied",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const prefix = `${input.phase}-${String(input.index + 1).padStart(2, "0")}`;
  const stdout = path.join(input.artifactDirectory, `${prefix}.stdout.log`);
  const stderr = path.join(input.artifactDirectory, `${prefix}.stderr.log`);
  const base = {
    phase: input.phase,
    index: input.index,
    command: input.command,
    resolvedCwd,
  };

  let invocation;
  let boundaryEvidence: CommandEvidence["executionBoundary"];
  try {
    if (executionBoundary.kind === "external-sandbox") {
      const sandboxed = buildSandboxedCommand({
        boundary: executionBoundary,
        command: input.command,
        workspacePath: input.workspacePath,
        cleanupCwd: input.artifactDirectory,
        relativeCwd: input.command.cwd,
        identity: `${input.attemptId ?? "attempt"}-${input.phase}-${input.index}`,
      });
      invocation = sandboxed.invocation;
      boundaryEvidence = sandboxed.evidence;
      await input.onExternalResource?.(sandboxed.resource);
    } else {
      input.policy.validate(input.command);
      invocation = {
        executable: input.command.executable,
        args: input.command.args,
        cwd: resolvedCwd,
        env: selectRequestedEnvironment(input.command.inheritEnv),
      };
      boundaryEvidence = { kind: "host-worktree" };
    }
  } catch (error) {
    return {
      ...base,
      executionBoundary:
        executionBoundary.kind === "host-worktree"
          ? executionBoundary
          : sandboxEvidenceWithoutContainer(executionBoundary),
      status: "policy-denied",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (input.signal.aborted) {
    return {
      ...base,
      executionBoundary: boundaryEvidence,
      status: "cancelled",
    };
  }

  try {
    const process = await runProcess(invocation, {
      stdoutPath: stdout,
      stderrPath: stderr,
      timeoutMs: input.command.timeoutMs ?? input.defaultTimeoutMs,
      signal: input.signal,
      onGuardianReady: input.onGuardianReady,
    });
    await input.onProcessResult?.(process);
    if (executionBoundary.kind === "external-sandbox") {
      if (!process.cleanup) {
        throw new Error(
          "External sandbox cleanup returned no process evidence",
        );
      }
      await input.onExternalResourceReleased?.(
        (
          boundaryEvidence as Extract<
            CommandEvidence["executionBoundary"],
            { kind: "external-sandbox" }
          >
        ).containerName,
        process.cleanup,
      );
    }
    return {
      ...base,
      executionBoundary: boundaryEvidence,
      status: process.cancelled
        ? "cancelled"
        : process.timedOut
          ? "timed-out"
          : process.exitCode === 0
            ? "passed"
            : "failed",
      process,
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      ...base,
      executionBoundary: boundaryEvidence!,
      status: "failed",
      stdout,
      stderr,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sandboxEvidenceWithoutContainer(
  boundary: Extract<ExecutionBoundary, { kind: "external-sandbox" }>,
): CommandEvidence["executionBoundary"] {
  return {
    kind: "external-sandbox",
    profileId: boundary.profileId,
    profileFingerprint: boundary.profileFingerprint,
    driver: "docker",
    image: boundary.image,
    containerName: "not-started",
    network: "none",
    readOnlyRoot: true,
  };
}

export async function resolveInsideWorkspace(
  workspacePath: string,
  relativeCwd?: string,
): Promise<string> {
  const root = await realpath(path.resolve(workspacePath));
  const candidate = await realpath(path.resolve(root, relativeCwd ?? "."));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Command cwd leaves the assigned worktree: ${relativeCwd}`);
  }
  return candidate;
}

function normalizePolicyValue(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function normalizeEnvironmentName(value: string): string {
  return process.platform === "win32" ? value.toUpperCase() : value;
}

function parseList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}
