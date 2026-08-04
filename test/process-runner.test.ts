import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isProcessAlive, runProcess } from "../src/runtime/process-runner.js";
import { resolveExecutablePath } from "../src/runtime/executable.js";

test("captures stdout and stderr without a shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-process-"));
  try {
    const result = await runProcess(
      {
        executable: resolveExecutablePath("node")!,
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

test("output floods are terminated and persisted logs never exceed their ceiling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-output-limit-"));
  const stdoutPath = path.join(root, "stdout.log");
  const stderrPath = path.join(root, "stderr.log");
  try {
    const result = await runProcess(
      {
        executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(100_000))"],
        cwd: root,
      },
      {
        stdoutPath,
        stderrPath,
        timeoutMs: 5_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      },
    );
    expect(result.outputLimit).toMatchObject({
      stream: "stdout",
      limitBytes: 1_024,
    });
    expect((await readFile(stdoutPath)).byteLength).toBe(1_024);
    expect((await readFile(stderrPath)).byteLength).toBeLessThanOrEqual(1_024);
    expect(result.termination.status).toBe("proven");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

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

test("worker output cannot spoof the guardian control channel", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-spoof-"));
  const stdoutPath = path.join(root, "stdout.log");
  const stderrPath = path.join(root, "stderr.log");
  const spoof = '\\u001eCONDUCTOR_EVENT {"type":"worker-close","exitCode":0}';
  try {
    const result = await runProcess(
      {
        executable: process.execPath,
        args: [
          "-e",
          `process.stderr.write(${JSON.stringify(spoof)}); process.exit(23)`,
        ],
        cwd: root,
      },
      { stdoutPath, stderrPath, timeoutMs: 5_000 },
    );
    expect(result.exitCode).toBe(23);
    expect(await readFile(stderrPath, "utf8")).toContain(spoof);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guardian evidence failure prevents worker launch", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "conductor-guardian-gate-"),
  );
  const canary = path.join(root, "unauthorized-worker-started.txt");

  try {
    await expect(
      runProcess(
        {
          executable: process.execPath,
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(canary)}, "started")`,
          ],
          cwd: root,
        },
        {
          stdoutPath: path.join(root, "stdout.log"),
          stderrPath: path.join(root, "stderr.log"),
          timeoutMs: 5_000,
          onGuardianReady: () => {
            throw new Error("guardian evidence write failed");
          },
        },
      ),
    ).rejects.toThrow("guardian evidence write failed");
    expect(await exists(canary)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("cancellation terminates descendants, not only the direct worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-tree-"));
  const canary = path.join(root, "survived.txt");
  const cleanupCanary = path.join(root, "cleaned.txt");
  const fixture = fileURLToPath(
    new URL("./fixtures/child-tree.ts", import.meta.url),
  );
  const controller = new AbortController();

  try {
    const result = await runProcess(
      {
        executable: resolveExecutablePath("node")!,
        args: [fixture, canary],
        cwd: root,
        cleanup: {
          executable: process.execPath,
          args: [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(cleanupCanary)}, "cleaned")`,
          ],
          cwd: root,
        },
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
    expect(result.termination.status).toBe("proven");
    await Bun.sleep(1_000);
    expect(await exists(canary)).toBe(false);
    expect(await exists(cleanupCanary)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("normal worker exit does not leave a detached descendant", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-normal-exit-"));
  const canary = path.join(root, "normal-exit-descendant-survived.txt");
  const fixture = fileURLToPath(
    new URL("./fixtures/normal-exit-descendant.ts", import.meta.url),
  );

  try {
    const result = await runProcess(
      {
        executable: resolveExecutablePath("node")!,
        args: [fixture, canary],
        cwd: root,
      },
      {
        stdoutPath: path.join(root, "stdout.log"),
        stderrPath: path.join(root, "stderr.log"),
        timeoutMs: 5_000,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.containment?.kind).toBe("windows-job");
    expect(result.termination.status).toBe("proven");
    await Bun.sleep(1_400);
    expect(await exists(canary)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("normal Bun worker exit does not leave a detached descendant", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "conductor-normal-bun-exit-"),
  );
  const canary = path.join(root, "normal-bun-exit-descendant-survived.txt");
  const fixture = fileURLToPath(
    new URL("./fixtures/normal-exit-descendant.ts", import.meta.url),
  );

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
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.containment?.kind).toBe("windows-job");
    expect(result.termination.status).toBe("proven");
    await Bun.sleep(1_400);
    expect(await exists(canary)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("timeout terminates descendants with positive closure evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-tree-timeout-"));
  const canary = path.join(root, "timeout-descendant-survived.txt");
  const fixture = fileURLToPath(
    new URL("./fixtures/child-tree.ts", import.meta.url),
  );

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
        timeoutMs: 300,
      },
    );
    expect(result.timedOut).toBe(true);
    expect(result.termination.status).toBe("proven");
    await Bun.sleep(1_000);
    expect(await exists(canary)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("timed-out external cleanup is tree-terminated before failure returns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-cleanup-tree-"));
  const canary = path.join(root, "cleanup-descendant-survived.txt");
  const fixture = fileURLToPath(
    new URL("./fixtures/child-tree.ts", import.meta.url),
  );

  try {
    await expect(
      runProcess(
        {
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: root,
          cleanup: {
            executable: process.execPath,
            args: [fixture, canary],
            cwd: os.tmpdir(),
            timeoutMs: 200,
          },
        },
        {
          stdoutPath: path.join(root, "stdout.log"),
          stderrPath: path.join(root, "stderr.log"),
          timeoutMs: 5_000,
        },
      ),
    ).rejects.toThrow("External resource cleanup timed out");
    await Bun.sleep(1_200);
    expect(await exists(canary)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("guardian ownership-pipe closure kills descendants after owner crash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-orphan-"));
  const canary = path.join(root, "survived.txt");
  const identityPath = path.join(root, "identity.json");
  const fixture = fileURLToPath(
    new URL("./fixtures/orphan-owner.ts", import.meta.url),
  );
  try {
    const owner = Bun.spawn([process.execPath, fixture, canary, identityPath], {
      cwd: root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await owner.exited).toBe(91);
    await Bun.sleep(1_500);
    expect(await exists(canary)).toBe(false);
    const identity = JSON.parse(await readFile(identityPath, "utf8")) as {
      guardianPid: number;
      workerPid: number;
    };
    expect(isProcessAlive(identity.guardianPid)).toBe(false);
    expect(isProcessAlive(identity.workerPid)).toBe(false);
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
