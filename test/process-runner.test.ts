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

test("does not inherit arbitrary parent secrets unless explicitly injected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-environment-"));
  const name = "CONDUCTOR_TEST_SECRET_CANARY";
  const previous = process.env[name];
  process.env[name] = "must-not-leak";
  try {
    const hidden = await runProcess(
      {
        executable: process.execPath,
        args: ["-e", `console.log(process.env.${name} ?? "missing")`],
        cwd: root,
      },
      {
        stdoutPath: path.join(root, "hidden.stdout.log"),
        stderrPath: path.join(root, "hidden.stderr.log"),
        timeoutMs: 5_000,
      },
    );
    expect(hidden.exitCode).toBe(0);
    expect(
      await readFile(path.join(root, "hidden.stdout.log"), "utf8"),
    ).toContain("missing");

    const explicit = await runProcess(
      {
        executable: process.execPath,
        args: ["-e", `console.log(process.env.${name} ?? "missing")`],
        cwd: root,
        env: { [name]: "explicit-value" },
      },
      {
        stdoutPath: path.join(root, "explicit.stdout.log"),
        stderrPath: path.join(root, "explicit.stderr.log"),
        timeoutMs: 5_000,
      },
    );
    expect(explicit.exitCode).toBe(0);
    expect(
      await readFile(path.join(root, "explicit.stdout.log"), "utf8"),
    ).toContain("explicit-value");
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
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
