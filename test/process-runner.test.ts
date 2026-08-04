import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess } from "../src/runtime/process-runner.js";

test("captures stdout and stderr without a shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-process-"));
  try {
    const result = await runProcess(
      {
        executable: process.execPath,
        args: ["-e", "console.log('out'); console.error('err')"],
        cwd: root,
      },
      {
        stdoutPath: path.join(root, "stdout.log"),
        stderrPath: path.join(root, "stderr.log"),
        timeoutMs: 5_000,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(root, "stdout.log"), "utf8")).toContain(
      "out",
    );
    expect(await readFile(path.join(root, "stderr.log"), "utf8")).toContain(
      "err",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation terminates descendants, not only the direct worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-tree-"));
  const canary = path.join(root, "survived.txt");
  const fixture = fileURLToPath(
    new URL("./fixtures/child-tree.ts", import.meta.url),
  );
  const controller = new AbortController();

  try {
    const result = await runProcess(
      {
        executable: process.execPath,
        args: [fixture, canary],
        cwd: root,
      },
      {
        stdoutPath: path.join(root, "stdout.log"),
        stderrPath: path.join(root, "stderr.log"),
        timeoutMs: 5_000,
        signal: controller.signal,
        onSpawn: () => {
          setTimeout(() => controller.abort(), 300);
        },
      },
    );
    expect(result.cancelled).toBe(true);
    await Bun.sleep(1_000);
    expect(await exists(canary)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
