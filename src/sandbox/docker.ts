import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";

import {
  externalSandboxBindingSchema,
  fingerprint,
  type CommandSpec,
  type ExecutionBoundary,
} from "../contracts/job.js";
import type { ExternalResource } from "../contracts/attempt.js";
import { resolveExecutablePath } from "../runtime/executable.js";
import {
  terminateProcessTree,
  type ProcessInvocation,
} from "../runtime/process-runner.js";

const dockerProfileSchema = z.object({
  image: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
  minimumEngineVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  allowedExecutables: z.array(z.string().regex(/^\//)).min(1).max(64),
  user: z.string().regex(/^\d+:\d+$/),
  memoryBytes: z.number().int().min(67_108_864).max(68_719_476_736),
  cpus: z.number().min(0.1).max(64),
  pidsLimit: z.number().int().min(16).max(4096),
  tmpfsBytes: z.number().int().min(1_048_576).max(8_589_934_592),
});

export const sandboxProfileFileSchema = z.object({
  schema: z.literal("conductor.sandbox-profiles/v1"),
  dockerExecutable: z.string().min(1),
  profiles: z.record(
    z.string().regex(/^[a-zA-Z0-9_.-]+$/),
    dockerProfileSchema,
  ),
});

export class SandboxProfiles {
  private readonly bindings = new Map<
    string,
    z.infer<typeof externalSandboxBindingSchema>
  >();

  constructor(
    input?: unknown,
    private readonly runtimeVerifier: (
      binding: z.infer<typeof externalSandboxBindingSchema>,
    ) => Promise<void> = verifyDockerBinding,
  ) {
    if (input === undefined) return;
    const parsed = sandboxProfileFileSchema.parse(input);
    const dockerExecutable = resolveExecutablePath(parsed.dockerExecutable);
    if (!dockerExecutable || !path.isAbsolute(dockerExecutable)) {
      throw new Error(
        `Docker executable is unavailable: ${parsed.dockerExecutable}`,
      );
    }
    for (const [profileId, profile] of Object.entries(parsed.profiles)) {
      const policy = {
        driver: "docker" as const,
        dockerExecutable,
        ...profile,
        workspaceMount: "/workspace" as const,
        network: "none" as const,
        readOnlyRoot: true as const,
        capDropAll: true as const,
        noNewPrivileges: true as const,
      };
      this.bindings.set(
        profileId,
        externalSandboxBindingSchema.parse({
          kind: "external-sandbox",
          schema: "conductor.external-sandbox-binding/v1",
          profileId,
          profileFingerprint: fingerprint(policy),
          ...policy,
        }),
      );
    }
  }

  static fromEnvironment(): SandboxProfiles {
    const target = process.env.CONDUCTOR_SANDBOX_PROFILES_FILE;
    return target
      ? new SandboxProfiles(JSON.parse(readFileSync(target, "utf8")))
      : new SandboxProfiles();
  }

  resolve(profileId: string) {
    const binding = this.bindings.get(profileId);
    if (!binding)
      throw new Error(`Unknown external sandbox profile: ${profileId}`);
    return structuredClone(binding);
  }

  async verify(
    binding: z.infer<typeof externalSandboxBindingSchema>,
  ): Promise<void> {
    await this.runtimeVerifier(binding);
  }

  list() {
    return [...this.bindings.values()].map((binding) =>
      structuredClone(binding),
    );
  }
}

export interface SandboxedInvocation {
  invocation: ProcessInvocation;
  evidence: {
    kind: "external-sandbox";
    profileId: string;
    profileFingerprint: string;
    driver: "docker";
    image: string;
    containerName: string;
    network: "none";
    readOnlyRoot: true;
  };
  resource: ExternalResource;
}

export function buildSandboxedCommand(input: {
  boundary: Extract<ExecutionBoundary, { kind: "external-sandbox" }>;
  command: CommandSpec;
  workspacePath: string;
  cleanupCwd: string;
  relativeCwd?: string;
  identity: string;
}): SandboxedInvocation {
  const { boundary, command } = input;
  validateSandboxCommand(boundary, command);
  if (!path.isAbsolute(input.cleanupCwd)) {
    throw new Error("Sandbox cleanup cwd must be an absolute durable path");
  }
  if (/[,\r\n]/.test(input.workspacePath)) {
    throw new Error(
      "Workspace path cannot be represented as a Docker bind mount",
    );
  }
  const relativeCwd = (input.relativeCwd ?? ".").replaceAll("\\", "/");
  const containerCwd = path.posix.resolve(boundary.workspaceMount, relativeCwd);
  if (
    containerCwd !== boundary.workspaceMount &&
    !containerCwd.startsWith(`${boundary.workspaceMount}/`)
  ) {
    throw new Error("Sandbox command cwd leaves the workspace mount");
  }
  const containerName = `conductor-${createHash("sha256")
    .update(input.identity)
    .digest("hex")
    .slice(0, 24)}`;
  const dockerArgs = [
    "run",
    "--name",
    containerName,
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    String(boundary.pidsLimit),
    "--memory",
    `${boundary.memoryBytes}b`,
    "--cpus",
    String(boundary.cpus),
    "--user",
    boundary.user,
    "--ipc",
    "none",
    "--workdir",
    containerCwd,
    "--mount",
    `type=bind,source=${input.workspacePath},target=${boundary.workspaceMount}`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${boundary.tmpfsBytes}`,
    boundary.image,
    command.executable,
    ...command.args,
  ];
  return {
    invocation: {
      executable: boundary.dockerExecutable,
      args: dockerArgs,
      cwd: input.workspacePath,
      env: {},
      cleanup: {
        executable: boundary.dockerExecutable,
        args: ["rm", "--force", containerName],
        cwd: input.cleanupCwd,
        env: {},
        allowMissingMessage: "No such container",
        timeoutMs: 24_000,
      },
    },
    evidence: {
      kind: "external-sandbox",
      profileId: boundary.profileId,
      profileFingerprint: boundary.profileFingerprint,
      driver: "docker",
      image: boundary.image,
      containerName,
      network: "none",
      readOnlyRoot: true,
    },
    resource: {
      schema: "conductor.external-resource/v1",
      resourceId: containerName,
      driver: "docker",
      profileId: boundary.profileId,
      profileFingerprint: boundary.profileFingerprint,
      image: boundary.image,
      status: "active",
      registeredAt: new Date().toISOString(),
      cleanup: {
        executable: boundary.dockerExecutable,
        args: ["rm", "--force", containerName],
        cwd: input.cleanupCwd,
      },
    },
  };
}

export function validateSandboxCommand(
  boundary: Extract<ExecutionBoundary, { kind: "external-sandbox" }>,
  command: CommandSpec,
): void {
  if (command.inheritEnv.length > 0) {
    throw new Error(
      "External sandbox commands cannot inherit host environment values",
    );
  }
  if (
    !command.executable.startsWith("/") ||
    !boundary.allowedExecutables.includes(command.executable)
  ) {
    throw new Error(
      `Container executable is not allowed by sandbox profile: ${command.executable}`,
    );
  }
}

async function verifyDockerBinding(
  binding: z.infer<typeof externalSandboxBindingSchema>,
): Promise<void> {
  const version = await capture(binding.dockerExecutable, [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  if (compareVersions(version, binding.minimumEngineVersion) < 0) {
    throw new Error(
      `Docker Engine ${version} is below required ${binding.minimumEngineVersion}`,
    );
  }
  await capture(binding.dockerExecutable, ["image", "inspect", binding.image]);
}

function capture(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    const timeout = setTimeout(() => {
      if (child.pid)
        void terminateProcessTree(child.pid).catch(() => undefined);
      finish(() => reject(new Error("Sandbox runtime probe timed out")));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const append = (current: string, chunk: string): string => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 1_048_576) {
        if (child.pid)
          void terminateProcessTree(child.pid).catch(() => undefined);
        finish(() =>
          reject(new Error("Sandbox runtime probe output exceeded 1 MiB")),
        );
        return current;
      }
      return current + chunk;
    };
    child.stdout.on(
      "data",
      (chunk: string) => (stdout = append(stdout, chunk)),
    );
    child.stderr.on(
      "data",
      (chunk: string) => (stderr = append(stderr, chunk)),
    );
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (exitCode) => {
      finish(() => {
        if (exitCode === 0) resolve(stdout.trim());
        else
          reject(new Error(`Sandbox runtime probe failed: ${stderr.trim()}`));
      });
    });
  });
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value.split(".").map((part) => Number(part.replace(/\D.*$/, "")));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) - (b[index] ?? 0);
    }
  }
  return 0;
}
