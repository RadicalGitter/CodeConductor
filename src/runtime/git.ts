import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { selectParentEnvironment } from "./environment.js";
import { resolveExecutablePath } from "./executable.js";
import { terminateProcessTree } from "./process-runner.js";

export interface GitCaptureOptions {
  input?: Buffer;
  environment?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  trim?: boolean;
  signal?: AbortSignal;
}

export function runBoundedGit(
  cwd: string,
  args: string[],
  options: GitCaptureOptions = {},
): Promise<string> {
  if (options.signal?.aborted) {
    return Promise.reject(
      new Error(`git ${args[0] ?? "command"} was cancelled`),
    );
  }
  const executable = resolveExecutablePath("git");
  if (!executable) throw new Error("A real Git executable is required");
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
  const hooksPath = path.join(os.tmpdir(), "conductor-disabled-git-hooks");

  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["-c", `core.hooksPath=${hooksPath}`, "-C", cwd, ...args],
      {
        shell: false,
        windowsHide: true,
        env: isolatedGitEnvironment(options.environment),
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure: Error | undefined;
    let terminating = false;
    let termination: Promise<void> | undefined;

    const terminate = (error: Error): void => {
      if (failure) return;
      failure = error;
      if (!child.pid || terminating) return;
      terminating = true;
      termination = terminateProcessTree(child.pid);
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        terminate(
          new Error(
            `git ${args[0] ?? "command"} output exceeded ${maxOutputBytes} bytes`,
          ),
        );
        return;
      }
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout!.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => collect("stderr", chunk));
    if (options.input) child.stdin!.end(options.input);

    const timeout = setTimeout(
      () => terminate(new Error(`git ${args[0] ?? "command"} timed out`)),
      timeoutMs,
    );
    const onAbort = (): void =>
      terminate(new Error(`git ${args[0] ?? "command"} was cancelled`));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      void finish(code);
    });

    async function finish(code: number | null): Promise<void> {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        await termination;
      } catch (error) {
        reject(
          new Error(
            `${failure?.message ?? `git ${args[0] ?? "command"} termination requested`}; process-tree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      if (failure) reject(failure);
      else if (code !== 0) {
        reject(
          new Error(
            `git ${args[0] ?? "command"} failed (${code}): ${stderr.trim()}`,
          ),
        );
      } else resolve(options.trim === false ? stdout : stdout.trim());
    }
  });
}

export function isolatedGitEnvironment(
  extras: Record<string, string> = {},
): Record<string, string> {
  return {
    ...selectParentEnvironment(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    ...extras,
  };
}
