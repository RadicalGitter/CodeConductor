import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";

const control = process.stdin;
const EVENT_PREFIX = "\u001eCONDUCTOR_EVENT ";
const expectedNonce = process.argv[2];
let worker;
let stopping = false;
let started = false;
let buffer = "";
let workerStdout;
let workerStderr;
let outputLimit;

control.setEncoding("utf8");
control.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\n");
  if (newline < 0 || started) return;
  started = true;
  const message = JSON.parse(buffer.slice(0, newline));
  if (
    message.schema !== "conductor.guardian-start/v1" ||
    !expectedNonce ||
    message.nonce !== expectedNonce
  ) {
    throw new Error("Invalid process guardian start message");
  }
  workerStdout = openSync(message.stdoutPath, "a");
  workerStderr = openSync(message.stderrPath, "a");
  const limits = message.outputLimits ?? {};
  worker = spawn(message.invocation.executable, message.invocation.args, {
    cwd: message.invocation.cwd,
    env: message.invocation.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  captureBounded(worker.stdout, workerStdout, "stdout", limits.stdoutBytes);
  captureBounded(worker.stderr, workerStderr, "stderr", limits.stderrBytes);
  worker.once("spawn", () => {
    send({ type: "worker-spawn", nonce: message.nonce, pid: worker.pid });
  });
  worker.once("error", (error) => {
    send({
      type: "worker-error",
      nonce: message.nonce,
      message: error.message,
    });
  });
  worker.once("close", (exitCode, signal) => {
    if (stopping) return;
    void finishWorker(exitCode, signal);
  });
});

control.once("end", () => void stop("owner-channel-closed"));
control.once("error", () => void stop("owner-channel-error"));
process.once("SIGINT", () => void stop("guardian-sigint"));
process.once("SIGTERM", () => void stop("guardian-sigterm"));
process.once("uncaughtException", (error) => {
  send({ type: "guardian-error", message: error.message });
  void stop("guardian-error");
});

async function stop(reason) {
  if (stopping) return;
  stopping = true;
  send({ type: "guardian-stop", reason });
  if (worker?.pid) {
    try {
      await terminateProcessTree(worker.pid);
      if (process.platform !== "win32") {
        send({
          type: "tree-cleanup",
          status: "unknown",
          method: "posix-process-group-empty",
          detail:
            "Process group is empty, but no cgroup proof excludes a descendant that created a new session",
        });
      }
    } catch (error) {
      if (process.platform !== "win32") {
        send({
          type: "tree-cleanup",
          status: "failed",
          method: "posix-process-group",
          detail: error.message,
        });
      }
    }
  }
  closeWorkerLogs();
  finish(125);
}

function captureBounded(stream, descriptor, name, configuredLimit) {
  const limit = Number.isSafeInteger(configuredLimit)
    ? configuredLimit
    : Number.MAX_SAFE_INTEGER;
  let written = 0;
  stream.on("data", (chunk) => {
    if (stopping) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, limit - written);
    const accepted = Math.min(remaining, bytes.length);
    if (accepted > 0) {
      writeSync(descriptor, bytes, 0, accepted);
      written += accepted;
    }
    if (bytes.length > remaining && !outputLimit) {
      outputLimit = {
        stream: name,
        limitBytes: limit,
        observedBytes: written + (bytes.length - accepted),
      };
      send({ type: "output-limit", ...outputLimit });
      void stop("output-limit");
    }
  });
}

async function finishWorker(exitCode, signal) {
  stopping = true;
  send({
    type: "worker-close",
    exitCode,
    signal,
  });
  if (process.platform !== "win32" && worker?.pid) {
    try {
      await terminateProcessTree(worker.pid);
      send({
        type: "tree-cleanup",
        status: "unknown",
        method: "posix-process-group-empty",
        detail:
          "Process group is empty, but no cgroup proof excludes a descendant that created a new session",
      });
    } catch (error) {
      send({
        type: "tree-cleanup",
        status: "failed",
        method: "posix-process-group",
        detail: error.message,
      });
    }
  }
  closeWorkerLogs();
  finish(exitCode ?? 1);
}

function closeWorkerLogs() {
  if (workerStdout !== undefined) {
    closeSync(workerStdout);
    workerStdout = undefined;
  }
  if (workerStderr !== undefined) {
    closeSync(workerStderr);
    workerStderr = undefined;
  }
}

function send(value) {
  process.stdout.write(
    `${EVENT_PREFIX}${JSON.stringify({ ...value, nonce: expectedNonce })}\n`,
  );
}

function finish(exitCode) {
  process.stdout.write("", () => process.exit(exitCode));
}

async function terminateProcessTree(pid) {
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
    if (error?.code !== "ESRCH") throw error;
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessGroupAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (isProcessGroupAlive(pid)) {
    throw new Error(`Process group ${pid} is still alive after SIGKILL`);
  }
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitForExit(child, acceptedExitCodes) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode !== null && acceptedExitCodes.has(exitCode)) resolve();
      else reject(new Error(`Process-tree termination exited ${exitCode}`));
    });
  });
}
