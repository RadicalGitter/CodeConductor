import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  schema: "conductor.process-guardian/v2";
  nonce: string;
  guardianPid: number;
  parentPid: number;
  createdAt: string;
  containment: ProcessContainment;
}

export interface ProcessContainment {
  schema: "conductor.process-containment/v1";
  kind: "windows-job" | "posix-process-group";
  ownerPid: number;
  kernelEnforced: boolean;
  killOnOwnerClose: boolean;
}

export interface ProcessTerminationEvidence {
  schema: "conductor.process-termination/v1";
  status: "proven" | "failed" | "unknown";
  method:
    | "not-started"
    | "windows-job-terminate-and-empty"
    | "windows-job-owner-exit"
    | "posix-process-group-empty"
    | "guardian-exit-unverified";
  observedAt: string;
  detail?: string;
}

export interface ProcessRunOptions {
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void | Promise<void>;
  onGuardianReady?: (identity: ProcessGuardianIdentity) => void | Promise<void>;
}

export interface ProcessExecutionResult {
  pid?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  containment?: ProcessContainment;
  termination: ProcessTerminationEvidence;
}

export interface ProcessResult extends ProcessExecutionResult {
  cleanup?: ProcessExecutionResult;
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
      termination: terminationEvidence("proven", "not-started"),
    };
  }

  await mkdir(path.dirname(options.stdoutPath), { recursive: true });
  await mkdir(path.dirname(options.stderrPath), { recursive: true });
  const stdout = await open(options.stdoutPath, "w");
  const stderr = await open(options.stderrPath, "w");
  const started = performance.now();
  const startControlPath = path.join(
    path.dirname(options.stderrPath),
    `.conductor-guardian-start-${randomUUID()}.json`,
  );
  const stopControlPath = path.join(
    path.dirname(options.stderrPath),
    `.conductor-guardian-stop-${randomUUID()}.json`,
  );

  let timedOut = false;
  let cancelled = false;
  let terminationRequest: Promise<void> | undefined;
  let control: Writable | undefined;

  try {
    const nonce = randomUUID();
    const guardianEntry = fileURLToPath(
      new URL("./process-guardian.mjs", import.meta.url),
    );
    const nodeExecutable = resolveExecutablePath(
      process.env.CONDUCTOR_GUARDIAN_NODE_BIN ?? "node",
    );
    if (!nodeExecutable) {
      throw new Error(
        "A real Node executable is required for process guardians",
      );
    }
    const guardianHost = resolveGuardianHost(
      nodeExecutable,
      guardianEntry,
      nonce,
      startControlPath,
      stopControlPath,
    );
    const guardian = spawn(guardianHost.executable, guardianHost.args, {
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
    let ownershipReady = process.platform !== "win32";
    let startScheduled = false;
    let treeCleanup: ProcessTerminationEvidence | undefined;
    let callbackChain = Promise.resolve();
    let callbackFailure: unknown;
    let stopControlWrite: Promise<void> | undefined;

    const requestWindowsStop = (reason: string): Promise<void> => {
      stopControlWrite ??= writeControlFile(stopControlPath, {
        schema: "conductor.guardian-stop/v1",
        nonce,
        reason,
        requestedAt: new Date().toISOString(),
      });
      return stopControlWrite;
    };

    readGuardianEvents(
      guardian.stdout!,
      stderr.createWriteStream(),
      (event) => {
        if (event.nonce !== nonce) return;
        if (event.type === "ownership-ready") {
          ownershipReady =
            event.kind === "windows-job" &&
            event.ownerPid === guardian.pid &&
            event.kernelEnforced === true &&
            event.killOnOwnerClose === true;
          if (ownershipReady && !startScheduled) {
            startScheduled = true;
            callbackChain = callbackChain
              .then(async () => {
                if (!guardian.pid) {
                  throw new Error("Process guardian host lost its pid");
                }
                await options.onGuardianReady?.(
                  createGuardianIdentity(
                    nonce,
                    guardian.pid,
                    guardianHost.containment(guardian.pid),
                  ),
                );
                if (timedOut || cancelled) return;
                await writeControlFile(startControlPath, {
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
                  stdoutPath: options.stdoutPath,
                  stderrPath: options.stderrPath,
                });
              })
              .catch(async (error) => {
                callbackFailure = error;
                await requestWindowsStop(
                  "guardian-initialization-failed",
                ).catch(() => undefined);
              });
          }
        } else if (event.type === "tree-cleanup") {
          treeCleanup = terminationEvidence(
            event.status === "proven"
              ? "proven"
              : event.status === "unknown"
                ? "unknown"
                : "failed",
            event.method === "windows-job-terminate-and-empty"
              ? "windows-job-terminate-and-empty"
              : event.method === "posix-process-group-empty"
                ? "posix-process-group-empty"
                : "guardian-exit-unverified",
            event.detail,
          );
        } else if (event.type === "worker-spawn" && event.pid) {
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
      if (terminationRequest) return;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      if (process.platform === "win32") {
        terminationRequest = requestWindowsStop(reason);
      } else {
        if (!guardian.pid) return;
        control?.end();
        terminationRequest = terminateProcessTree(guardian.pid);
      }
      void terminationRequest.catch(() => undefined);
    };

    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    const onAbort = (): void => terminate("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await new Promise<
        Omit<ProcessResult, "containment" | "termination">
      >((resolve, reject) => {
        guardian.once("error", reject);
        guardian.once("spawn", () => {
          if (!guardian.pid) {
            reject(new Error("Process guardian started without a pid"));
            return;
          }
          if (process.platform !== "win32") {
            if (timedOut || cancelled) {
              terminate(timedOut ? "timeout" : "cancelled");
              return;
            }
            callbackChain = callbackChain
              .then(() =>
                options.onGuardianReady?.(
                  createGuardianIdentity(
                    nonce,
                    guardian.pid!,
                    guardianHost.containment(guardian.pid!),
                  ),
                ),
              )
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
                    stdoutPath: options.stdoutPath,
                    stderrPath: options.stderrPath,
                  })}\n`,
                );
              })
              .catch(reject);
          }
        });
        guardian.once("close", (exitCode, signal) => {
          void callbackChain.then(() => {
            if (callbackFailure) {
              reject(callbackFailure);
              return;
            }
            resolve({
              pid: workerPid,
              exitCode: workerClose?.exitCode ?? exitCode,
              signal: workerClose?.signal ?? signal,
              timedOut,
              cancelled,
              durationMs: Math.round(performance.now() - started),
            });
          }, reject);
        });
      });
      let terminationFailure: string | undefined;
      try {
        await terminationRequest;
      } catch (error) {
        terminationFailure = errorMessage(error);
      }
      const finalTermination =
        treeCleanup ??
        (workerPid === undefined
          ? terminationEvidence("proven", "not-started")
          : terminationEvidence(
              terminationFailure ? "failed" : "unknown",
              "guardian-exit-unverified",
              terminationFailure ??
                (ownershipReady
                  ? "Guardian exited without a complete process-tree cleanup event"
                  : "Process containment never became ready"),
            ));
      const cleanup = invocation.cleanup
        ? await runCleanupInvocation(invocation.cleanup)
        : undefined;
      return {
        ...result,
        timedOut,
        cancelled,
        containment: guardianHost.containment(guardian.pid!),
        termination: finalTermination,
        cleanup,
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      control.end();
    }
  } finally {
    await Promise.allSettled([
      rm(startControlPath, { force: true }),
      rm(stopControlPath, { force: true }),
    ]);
    await Promise.allSettled([stdout.close(), stderr.close()]);
  }
}

type GuardianEvent = {
  type?: string;
  nonce?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  kind?: string;
  ownerPid?: number;
  kernelEnforced?: boolean;
  killOnOwnerClose?: boolean;
  status?: string;
  method?: string;
  detail?: string;
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
): Promise<ProcessExecutionResult> {
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
        timeoutMs: invocation.timeoutMs ?? 24_000,
      },
    );
    const stderr = await readFile(stderrPath, "utf8");
    if (result.timedOut) {
      throw new Error("External resource cleanup timed out");
    }
    if (result.termination.status !== "proven") {
      throw new Error(
        `External resource cleanup process termination is ${result.termination.status}`,
      );
    }
    if (result.exitCode === 0) return result;
    if (
      invocation.allowMissingMessage &&
      stderr.includes(invocation.allowMissingMessage)
    ) {
      return result;
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

function resolveGuardianHost(
  nodeExecutable: string,
  guardianEntry: string,
  nonce: string,
  startControlPath: string,
  stopControlPath: string,
): {
  executable: string;
  args: string[];
  containment: (ownerPid: number) => ProcessContainment;
} {
  if (process.platform !== "win32") {
    return {
      executable: nodeExecutable,
      args: [guardianEntry, nonce],
      containment: (ownerPid) => ({
        schema: "conductor.process-containment/v1",
        kind: "posix-process-group",
        ownerPid,
        kernelEnforced: false,
        killOnOwnerClose: false,
      }),
    };
  }

  const powershell = resolveExecutablePath(
    process.env.CONDUCTOR_WINDOWS_JOB_HOST_POWERSHELL ?? "pwsh",
  );
  if (!powershell) {
    throw new Error(
      "PowerShell 7 is required for Windows Job Object process ownership",
    );
  }
  const hostEntry = fileURLToPath(
    new URL("./windows-job-host.ps1", import.meta.url),
  );
  const argumentsBase64 = Buffer.from(
    JSON.stringify([guardianEntry, nonce]),
    "utf8",
  ).toString("base64");
  return {
    executable: powershell,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      hostEntry,
      "-Executable",
      nodeExecutable,
      "-ArgumentsBase64",
      argumentsBase64,
      "-Nonce",
      nonce,
      "-OwnerPid",
      String(process.pid),
      "-ControlPath",
      startControlPath,
      "-StopPath",
      stopControlPath,
    ],
    containment: (ownerPid) => ({
      schema: "conductor.process-containment/v1",
      kind: "windows-job",
      ownerPid,
      kernelEnforced: true,
      killOnOwnerClose: true,
    }),
  };
}

function createGuardianIdentity(
  nonce: string,
  guardianPid: number,
  containment: ProcessContainment,
): ProcessGuardianIdentity {
  return {
    schema: "conductor.process-guardian/v2",
    nonce,
    guardianPid,
    parentPid: process.pid,
    createdAt: new Date().toISOString(),
    containment,
  };
}

async function writeControlFile(target: string, value: unknown): Promise<void> {
  const staging = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(staging, JSON.stringify(value), {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

function terminationEvidence(
  status: ProcessTerminationEvidence["status"],
  method: ProcessTerminationEvidence["method"],
  detail?: string,
): ProcessTerminationEvidence {
  return {
    schema: "conductor.process-termination/v1",
    status,
    method,
    observedAt: new Date().toISOString(),
    detail,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
