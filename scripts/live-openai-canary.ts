import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConductorRuntimeFromEnvironment } from "../src/mcp/runtime.js";
import type { OpenAIResponsesRunEvidence } from "../src/workers/openai-responses-runner.js";

const temporary = await mkdtemp(
  path.join(os.tmpdir(), "conductor-live-openai-"),
);
const repository = path.join(temporary, "repository");
const profileId =
  process.env.CONDUCTOR_OPENAI_CANARY_PROFILE ?? "luna-medium-canary-v1";
const secret = process.env.OPENAI_API_KEY;
if (!secret) throw new Error("OPENAI_API_KEY is required for the paid canary");

const runtime = createConductorRuntimeFromEnvironment();
let attemptId: string | undefined;

try {
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
          adapterId: "openai-responses",
          adapterOptions: { profile: profileId },
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
          executionBoundary: { kind: "host-worktree" },
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
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.email", "conductor@example.invalid"]);
  await git(repository, ["config", "user.name", "Conductor Canary"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "OpenAI canary baseline"]);

  const sourceRun = await runtime.sources.compileAndEnqueue({
    repositoryPath: repository,
    baseRef: "HEAD",
    allowedAdapterIds: ["openai-responses"],
    includeExtensions: [".js"],
  });
  const jobId = sourceRun.enqueued[0]?.jobId;
  if (!jobId) throw new Error("Canary source package produced no job");
  const terminal = (await runtime.dispatcher.runUntilIdle()).find(
    (candidate) => candidate.jobId === jobId,
  );
  if (!terminal) throw new Error("Canary job disappeared from the queue");
  if (!terminal.attemptId) throw new Error("Canary produced no attempt");
  attemptId = terminal.attemptId;
  const attempt = await runtime.conductor.getAttempt(attemptId);
  const verification = await runtime.conductor.getVerification(attemptId);
  const stdout = await readFile(attempt.artifacts.stdout, "utf8");
  const workerEvidence = parseWorkerEvidence(stdout);
  await assertSecretAbsent(attempt.artifacts, secret);
  const review = verification.eligibleForReview
    ? await runtime.conductor.getReviewBundle(attemptId)
    : undefined;
  console.log(
    JSON.stringify(
      {
        schema: "conductor.live-openai-canary/v1",
        profileId,
        sourceRunId: sourceRun.runId,
        sourceRevision: sourceRun.revision,
        jobId,
        attemptId,
        queueStatus: terminal.status,
        attemptStatus: attempt.status,
        verificationStatus: attempt.verificationStatus,
        eligibleForReview: verification.eligibleForReview,
        changedPaths: verification.scope.changedPaths,
        model: workerEvidence.requestedModel,
        reasoningEffort: workerEvidence.reasoningEffort,
        requestCount: workerEvidence.requestCount,
        retryCount: workerEvidence.retryCount,
        toolCallCount: workerEvidence.toolCallCount,
        usage: workerEvidence.usage,
        costMicroUsd: workerEvidence.costMicroUsd,
        maxCostMicroUsd: workerEvidence.maxCostMicroUsd,
        workerFailure: workerEvidence.failure,
        secretAbsentFromEvidence: true,
        reviewAuthority: review?.packet.authority ?? null,
        runRoot: runtime.conductor.store.root,
        artifacts: attempt.artifacts,
      },
      null,
      2,
    ),
  );
  if (
    terminal.status !== "completed" ||
    attempt.status !== "completed" ||
    attempt.verificationStatus !== "eligible"
  ) {
    process.exitCode = 1;
  }
} finally {
  if (attemptId) {
    await runtime.conductor
      .removeAttemptWorkspace(attemptId)
      .catch(() => undefined);
  }
  await rm(temporary, { recursive: true, force: true });
}

function parseWorkerEvidence(stdout: string): OpenAIResponsesRunEvidence {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const parsed = JSON.parse(
    lines.at(-1) ?? "null",
  ) as OpenAIResponsesRunEvidence;
  if (parsed.schema !== "conductor.openai-responses-run/v1") {
    throw new Error("Canary worker did not emit typed Responses evidence");
  }
  return parsed;
}

async function assertSecretAbsent(
  artifacts: Record<string, string | undefined>,
  apiKey: string,
): Promise<void> {
  for (const artifact of Object.values(artifacts)) {
    if (!artifact) continue;
    const contents = await readFile(artifact, "utf8").catch(() => "");
    if (contents.includes(apiKey)) {
      throw new Error(
        `API key leaked into Conductor evidence: ${path.basename(artifact)}`,
      );
    }
  }
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`));
    });
  });
}
