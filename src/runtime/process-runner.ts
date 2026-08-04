import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { selectParentEnvironment } from "./environment.js";
import { resolveExecutablePath } from "./executable.js";

export interface ProcessInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cleanup?: {
    executable: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    allowMissingMessage?: string;
    timeoutMs?: number;
  };
}

export interface ProcessGuardianIdentity {
  schema: "conductor.process-guardian/v1";
  nonce: string;
  guardianPid: number;
  parentPid: number;
  createdAt: string;
}

export interface ProcessRunOptions {
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void | Promise<void>;
  onGuardianReady?: (identity: ProcessGuardianIdentity) => void | Promise<void>;
}

export interface ProcessResult {
  pid?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export async function runProcess(
  invocation: ProcessInvocation,
  options: ProcessRunOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      durationMs: 0,
    };
  }

  await mkdir(path.dirname(options.stdoutPath), { recursive: true });
  await mkdir(path.dirname(options.stderrPath), { recursive: true });
  const stdout = await open(options.stdoutPath, "w");
  const stderr = await open(options.stderrPath, "w");
  const started = performance.now();

  let timedOut = false;
  let cancelled = false;
  let termination: Promise<void> | undefined;
  let control: Writable | undefined;

  try {
    const nonce = randomUUID();
    const guardianEntry = fileURLToPath(
      new URL("./process-guardian.mjs", import.meta.url),
    );
    const guardianExecutable = resolveExecutablePath(
      process.env.CONDUCTOR_GUARDIAN_NODE_BIN ?? "node",
    );
    if (!guardianExecutable) {
      throw new Error(
        "A real Node executable is required for process guardians",
      );
    }
    const guardian = spawn(guardianExecutable, [guardianEntry, nonce], {
      cwd: invocation.cwd,
      env: selectParentEnvironment(),
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["pipe", "pipe", "pipe", stdout.fd, stderr.fd],
    });
    guardian.stderr!.pipe(stderr.createWriteStream());
    control = guardian.stdin!;
    let workerPid: number | undefined;
    let workerClose:
      { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
    let callbackChain = Promise.resolve();

    readGuardianEvents(
      guardian.stdout!,
      stderr.createWriteStream(),
      (event) => {
        if (event.nonce !== nonce) return;
        if (event.type === "worker-spawn" && event.pid) {
          workerPid = event.pid;
          callbackChain = callbackChain.then(() =>
            options.onSpawn?.(event.pid!),
          );
        } else if (event.type === "worker-close") {
          workerClose = {
            exitCode: event.exitCode ?? null,
            signal: event.signal ?? null,
          };
        }
      },
    );

    const terminate = (reason: "timeout" | "cancelled"): void => {
      if (!guardian.pid || termination) return;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      control?.end();
      termination = terminateProcessTree(guardian.pid);
      void termination.catch(() => undefined);
    };

    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    const onAbort = (): void => terminate("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await new Promise<ProcessResult>((resolve, reject) => {
        guardian.once("error", reject);
        guardian.once("spawn", () => {
          if (!guardian.pid) {
            reject(new Error("Process guardian started without a pid"));
            return;
          }
          const identity: ProcessGuardianIdentity = {
            schema: "conductor.process-guardian/v1",
            nonce,
            guardianPid: guardian.pid,
            parentPid: process.pid,
            createdAt: new Date().toISOString(),
          };
          callbackChain = callbackChain
            .then(() => options.onGuardianReady?.(identity))
            .then(() => {
              control!.write(
                `${JSON.stringify({
                  schema: "conductor.guardian-start/v1",
                  nonce,
                  invocation: {
                    executable: invocation.executable,
                    args: invocation.args,
                    cwd: invocation.cwd,
                    env: {
                      ...selectParentEnvironment(),
                      ...invocation.env,
                    },
                  },
                })}\n`,
              );
            })
            .catch(reject);
        });
        guardian.once("close", (exitCode, signal) => {
          void callbackChain.then(
            () =>
              resolve({
                pid: workerPid,
                exitCode: workerClose?.exitCode ?? exitCode,
                signal: workerClose?.signal ?? signal,
                timedOut,
                cancelled,
                durationMs: Math.round(performance.now() - started),
              }),
            reject,
          );
        });
      });
      await termination;
      if (invocation.cleanup) {
        await runCleanupInvocation(invocation.cleanup);
      }
      return { ...result, timedOut, cancelled };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      control.end();
    }
  } finally {
    await Promise.allSettled([stdout.close(), stderr.close()]);
  }
}

type GuardianEvent = {
  type?: string;
  nonce?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

function readGuardianEvents(
  stream: Readable,
  output: Writable,
  receive: (event: GuardianEvent) => void,
): void {
  const prefix = "\u001eCONDUCTOR_EVENT ";
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.startsWith(prefix)) {
        receive(JSON.parse(line.slice(prefix.length)) as GuardianEvent);
      } else {
        output.write(`${line}\n`);
      }
      newline = buffer.indexOf("\n");
    }
  });
  stream.once("end", () => {
    if (buffer) output.write(buffer);
    output.end();
  });
}

export async function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Refusing to terminate invalid process id: ${pid}`);
  }

  if (process.platform === "win32") {
    try {
      await waitForExit(
        spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        }),
        new Set([0, 128]),
      );
    } catch (error) {
      for (let attempt = 0; attempt < 20 && isProcessAlive(pid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (isProcessAlive(pid)) throw error;
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function runCleanupInvocation(
  invocation: NonNullable<ProcessInvocation["cleanup"]>,
): Promise<void> {
  const identity = randomUUID();
  const stdoutPath = path.join(
    invocation.cwd,
    `.conductor-cleanup-${identity}.stdout.log`,
  );
  const stderrPath = path.join(
    invocation.cwd,
    `.conductor-cleanup-${identity}.stderr.log`,
  );
  try {
    const result = await runProcess(
      {
        executable: invocation.executable,
        args: invocation.args,
        cwd: invocation.cwd,
        env: invocation.env,
      },
      {
        stdoutPath,
        stderrPath,
        timeoutMs: invocation.timeoutMs ?? 30_000,
      },
    );
    const stderr = await readFile(stderrPath, "utf8");
    if (result.timedOut) {
      throw new Error("External resource cleanup timed out");
    }
    if (result.exitCode === 0) return;
    if (
      invocation.allowMissingMessage &&
      stderr.includes(invocation.allowMissingMessage)
    ) {
      return;
    }
    throw new Error(
      `External resource cleanup exited ${result.exitCode}: ${stderr.trim()}`,
    );
  } finally {
    await Promise.allSettled([
      rm(stdoutPath, { force: true }),
      rm(stderrPath, { force: true }),
    ]);
  }
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  acceptedExitCodes: Set<number>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode !== null && acceptedExitCodes.has(exitCode)) resolve();
      else
        reject(
          new Error(`Process-tree termination exited with code ${exitCode}`),
        );
    });
  });
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
