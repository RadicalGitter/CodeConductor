import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type Conductor,
  type RunJobResult,
} from "../src/orchestrator/conductor.js";

export async function createTestRepository(): Promise<{
  root: string;
  revision: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-repository-"));
  await command("git", ["init", "-b", "main"], root);
  await command(
    "git",
    ["config", "user.email", "conductor@example.invalid"],
    root,
  );
  await command("git", ["config", "user.name", "Conductor Test"], root);
  await writeFile(path.join(root, "seed.txt"), "baseline\n", "utf8");
  await command("git", ["add", "seed.txt"], root);
  await command("git", ["commit", "-m", "baseline"], root);
  return { root, revision: await command("git", ["rev-parse", "HEAD"], root) };
}

export function command(
  executable: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${executable} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export async function runTestJob(
  conductor: Conductor,
  input: unknown,
): Promise<RunJobResult> {
  const contract = await conductor.prepareJob(input);
  const existing = await conductor.store.latestAttempt(contract.jobId);
  if (existing) {
    const replay = await conductor.waitForAttempt(existing.attemptId);
    return { ...replay, idempotentReplay: true };
  }
  const dispatchOperationId = randomUUID();
  const reserved = await conductor.reservePreparedAttempt(
    contract.jobId,
    [],
    dispatchOperationId,
  );
  await conductor.startReservedAttempt(reserved.attemptId, dispatchOperationId);
  return conductor.waitForAttempt(reserved.attemptId);
}
