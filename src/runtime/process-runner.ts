import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

export interface ProcessInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface ProcessRunOptions {
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void | Promise<void>;
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

  try {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, ...invocation.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.pipe(stdout.createWriteStream());
    child.stderr.pipe(stderr.createWriteStream());

    const terminate = (reason: "timeout" | "cancelled"): void => {
      if (!child.pid || termination) return;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      termination = terminateProcessTree(child.pid);
    };

    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    const onAbort = (): void => terminate("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await new Promise<ProcessResult>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", () => {
          if (child.pid) void options.onSpawn?.(child.pid);
        });
        child.once("close", (exitCode, signal) => {
          resolve({
            pid: child.pid,
            exitCode,
            signal,
            timedOut,
            cancelled,
            durationMs: Math.round(performance.now() - started),
          });
        });
      });
      await termination;
      return { ...result, timedOut, cancelled };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    await Promise.allSettled([stdout.close(), stderr.close()]);
  }
}

export async function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Refusing to terminate invalid process id: ${pid}`);
  }

  if (process.platform === "win32") {
    await waitForExit(
      spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      }),
      new Set([0, 128]),
    );
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
