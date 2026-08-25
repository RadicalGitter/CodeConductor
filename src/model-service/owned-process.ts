import path from "node:path";

import {
  runProcess,
  type ProcessGuardianIdentity,
  type ProcessResult,
} from "../runtime/process-runner.js";

const MAX_SERVICE_LIFETIME_MS = 2_147_000_000;

export interface OwnedModelProcess {
  pid: number;
  guardian: ProcessGuardianIdentity;
  completion: Promise<ProcessResult>;
  stop(): Promise<ProcessResult>;
}

export interface OwnedModelProcessInput {
  executable: string;
  args: string[];
  cwd?: string;
  artifactDirectory: string;
  maxLogBytes?: number;
}

/**
 * Launch a long-lived model service under Conductor's ordinary process
 * guardian. Closing this process's ownership channel kills the complete tree;
 * stop authority is represented by the in-memory handle and is never rebuilt
 * from a PID after restart.
 */
export async function launchOwnedModelProcess(
  input: OwnedModelProcessInput,
): Promise<OwnedModelProcess> {
  const controller = new AbortController();
  let guardian: ProcessGuardianIdentity | undefined;
  let resolveSpawn!: (pid: number) => void;
  let rejectSpawn!: (error: unknown) => void;
  const spawned = new Promise<number>((resolve, reject) => {
    resolveSpawn = resolve;
    rejectSpawn = reject;
  });
  const cwd = path.resolve(input.cwd ?? path.dirname(input.executable));
  const completion = runProcess(
    {
      executable: input.executable,
      args: input.args,
      cwd,
    },
    {
      stdoutPath: path.join(
        input.artifactDirectory,
        "model-service.stdout.log",
      ),
      stderrPath: path.join(
        input.artifactDirectory,
        "model-service.stderr.log",
      ),
      timeoutMs: MAX_SERVICE_LIFETIME_MS,
      maxStdoutBytes: input.maxLogBytes ?? 64 * 1024 * 1024,
      maxStderrBytes: input.maxLogBytes ?? 64 * 1024 * 1024,
      signal: controller.signal,
      onGuardianReady: (identity) => {
        guardian = identity;
      },
      onSpawn: (pid) => resolveSpawn(pid),
    },
  );
  void completion.then((result) => {
    if (result.pid === undefined) {
      rejectSpawn(
        new Error("Model process guardian exited before worker spawn"),
      );
    }
  }, rejectSpawn);
  const pid = await spawned;
  if (!guardian) {
    controller.abort();
    await completion.catch(() => undefined);
    throw new Error("Model process spawned without durable guardian identity");
  }
  let stopping: Promise<ProcessResult> | undefined;
  return {
    pid,
    guardian,
    completion,
    stop: () => {
      stopping ??= (async () => {
        controller.abort();
        return completion;
      })();
      return stopping;
    },
  };
}
