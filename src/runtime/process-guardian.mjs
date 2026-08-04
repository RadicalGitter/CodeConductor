import { spawn } from "node:child_process";

const control = process.stdin;
const EVENT_PREFIX = "\u001eCONDUCTOR_EVENT ";
const expectedNonce = process.argv[2];
let worker;
let stopping = false;
let started = false;
let buffer = "";

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
  worker = spawn(message.invocation.executable, message.invocation.args, {
    cwd: message.invocation.cwd,
    env: message.invocation.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", 3, 4],
  });
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
    send({
      type: "worker-close",
      exitCode,
      signal,
    });
    finish(exitCode ?? 1);
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
  if (worker?.pid)
    await terminateProcessTree(worker.pid).catch(() => undefined);
  finish(125);
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
