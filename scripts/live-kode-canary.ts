import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Conductor } from "../src/orchestrator/conductor.js";
import { DurableDispatcher } from "../src/queue/dispatcher.js";
import { QueueStore } from "../src/queue/queue-store.js";
import { CommandProfiles } from "../src/sources/command-profiles.js";
import { ContractSourceCompiler } from "../src/sources/compiler.js";
import { ContractSourcePoller } from "../src/sources/poller.js";
import { ContractSourceService } from "../src/sources/service.js";
import { SourceWatchStore } from "../src/sources/watch-store.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { ExecutionPolicy } from "../src/verification/command-executor.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { KodeAdapter } from "../src/workers/kode.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { resolveExecutablePath } from "../src/runtime/executable.js";

const endpoint =
  process.env.CONDUCTOR_CANARY_ENDPOINT ?? "http://127.0.0.1:7332/v1";
const kodeEntry = path.resolve(
  process.env.CONDUCTOR_CANARY_KODE_ENTRY ??
    "Z:\\Programmering\\Kode-CLI\\dist\\index.js",
);
const nodeExecutable = resolveExecutablePath("node");
if (!nodeExecutable)
  throw new Error("node executable is required for live canary");
const temporary = await mkdtemp(path.join(os.tmpdir(), "conductor-live-kode-"));
const repository = path.join(temporary, "gameplay-repository");
const kodeConfig = path.join(temporary, "kode-config");
const runRoot = path.resolve(
  process.env.CONDUCTOR_CANARY_DATA_DIR ??
    path.join(os.homedir(), ".conductor", "canaries", timestamp()),
);
let attemptId: string | undefined;
let conductor: Conductor | undefined;

try {
  const modelResponse = await fetch(`${endpoint}/models`);
  if (!modelResponse.ok) {
    throw new Error(`Model endpoint returned ${modelResponse.status}`);
  }
  const modelPayload = (await modelResponse.json()) as {
    data?: Array<{ id?: string; meta?: { n_ctx?: number } }>;
  };
  const served = modelPayload.data?.[0];
  if (!served?.id)
    throw new Error("Model endpoint returned no served model id");

  await mkdir(repository, { recursive: true });
  await mkdir(path.join(repository, "gameplay"), { recursive: true });
  await mkdir(path.join(repository, "test"), { recursive: true });
  await writeFile(
    path.join(repository, "AGENTS.md"),
    [
      "# Canary contract",
      "",
      "Implement only the requested gameplay function.",
      "Do not edit tests or repository instructions.",
      "Run the focused Node test before finishing.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(repository, "gameplay", "contracts.js"),
    [
      "/* @conductor-contract",
      JSON.stringify(
        {
          id: "implement-clamp-health",
          objective:
            "Implement clampHealth(value, maximum) in gameplay/health.js. Clamp maximum below zero to zero; otherwise return value clamped inclusively to zero..maximum.",
          taskClass: "implementation",
          adapterId: "kode",
          adapterOptions: { model: "main" },
          scope: {
            allowedPaths: ["gameplay/health.js"],
            forbiddenPaths: [],
            protectedPaths: ["AGENTS.md", "test", "gameplay/contracts.js"],
          },
          contextRefs: ["test/health.test.js", "gameplay/health.js"],
          constraints: [
            "Use no dependencies.",
            "Preserve the exported function name and module format.",
          ],
          escalateWhen: [
            "The test contract conflicts with repository instructions.",
            "A required edit falls outside gameplay/health.js.",
          ],
          setup: [],
          acceptance: [
            {
              profile: "node-test",
              args: ["test/health.test.js"],
              timeoutMs: 60_000,
            },
          ],
          timeoutMs: 900_000,
          retainWorkspace: true,
          dependsOn: [],
          priority: 0,
          enabled: true,
        },
        null,
        2,
      ),
      "@end-conductor-contract */",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(repository, "gameplay", "health.js"),
    [
      "export function clampHealth(value, maximum) {",
      '  throw new Error("not implemented");',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(repository, "test", "health.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { clampHealth } from "../gameplay/health.js";',
      "",
      'test("clamps gameplay health into zero..maximum", () => {',
      "  assert.equal(clampHealth(-4, 10), 0);",
      "  assert.equal(clampHealth(7, 10), 7);",
      "  assert.equal(clampHealth(14, 10), 10);",
      "  assert.equal(clampHealth(2, -1), 0);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.email", "conductor@example.invalid"]);
  await git(repository, ["config", "user.name", "Conductor Canary"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "gameplay canary baseline"]);

  await mkdir(kodeConfig, { recursive: true });
  const profile = {
    name: "Conductor Live Local",
    provider: "custom-openai",
    modelName: served.id,
    baseURL: endpoint,
    apiKey: "local-no-secret",
    maxTokens: 8_192,
    contextLength: served.meta?.n_ctx ?? 65_536,
    reasoningEffort: "high",
    isActive: true,
    createdAt: Date.now(),
  };
  await writeFile(
    path.join(kodeConfig, "config.json"),
    `${JSON.stringify(
      {
        numStartups: 1,
        hasCompletedOnboarding: true,
        thinkingMode: "enabled",
        modelProfiles: [profile],
        modelPointers: {
          main: served.id,
          task: served.id,
          compact: served.id,
          quick: served.id,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.env.KODE_CONFIG_DIR = kodeConfig;
  const store = new ArtifactStore(runRoot);
  const workspaces = new GitWorkspaceManager(store.workspaceRoot());
  conductor = new Conductor(
    store,
    workspaces,
    new WorkerRegistry([
      new KodeAdapter(nodeExecutable, kodeEntry, ["KODE_CONFIG_DIR"]),
    ]),
    new ExecutionPolicy({ allowedExecutables: [nodeExecutable] }),
  );
  const queue = new QueueStore(store);
  const dispatcher = new DurableDispatcher(conductor, queue, {
    maxConcurrent: 2,
    pollIntervalMs: 25,
    leaseMs: 1_000,
  });
  const profiles = new CommandProfiles({
    schema: "conductor.command-profiles/v1",
    profiles: {
      "node-test": {
        executable: nodeExecutable,
        argsPrefix: ["--test"],
        inheritEnv: [],
      },
    },
  });
  const sources = new ContractSourceService(
    new ContractSourceCompiler(workspaces, profiles),
    dispatcher,
    store,
  );
  const watches = new SourceWatchStore(store);
  const poller = new ContractSourcePoller(sources, watches, 1_000);
  const registered = await watches.register({
    watchId: "live-gameplay-canary",
    repositoryPath: repository,
    baseRef: "HEAD",
    allowedAdapterIds: ["kode"],
    includeExtensions: [".js"],
    enabled: true,
  });
  await poller.pollOnce();
  const watched = await watches.read(registered.watch.watchId);
  const items = await dispatcher.runUntilIdle();
  if (items.length !== 1) {
    throw new Error(`Expected one queued contract, found ${items.length}`);
  }
  const item = items[0]!;
  if (!item.attemptId) throw new Error("Queued canary has no attempt id");
  attemptId = item.attemptId;
  const attempt = await conductor.getAttempt(attemptId);
  const verification = await conductor.getVerification(attemptId);
  const changedPaths = JSON.parse(
    await readFile(attempt.artifacts.changedPaths, "utf8"),
  ) as string[];
  console.log(
    JSON.stringify(
      {
        schema: "conductor.live-kode-canary/v2",
        endpoint,
        model: served.id,
        contextTokens: served.meta?.n_ctx ?? null,
        watchId: watched.watchId,
        sourceRunId: watched.lastRunId ?? null,
        sourceRevision: watched.lastRevision ?? null,
        jobId: item.jobId,
        queueStatus: item.status,
        attemptStatus: attempt.status,
        verificationStatus: attempt.verificationStatus,
        changedPaths,
        eligibleForReview: verification.eligibleForReview,
        runRoot,
        artifacts: attempt.artifacts,
      },
      null,
      2,
    ),
  );
  if (
    item.status !== "completed" ||
    attempt.status !== "completed" ||
    attempt.verificationStatus !== "eligible"
  ) {
    process.exitCode = 1;
  }
} finally {
  if (attemptId && conductor) {
    await conductor.removeAttemptWorkspace(attemptId).catch(() => undefined);
  }
  await rm(temporary, { recursive: true, force: true });
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
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
      else
        reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
    });
  });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
