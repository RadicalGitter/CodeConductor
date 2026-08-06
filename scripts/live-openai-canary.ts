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
  await mkdir(path.join(repository, "src"), { recursive: true });
  await mkdir(path.join(repository, "docs"), { recursive: true });
  await mkdir(path.join(repository, "test"), { recursive: true });
  await writeFile(
    path.join(repository, "AGENTS.md"),
    "# Canary\n\nImplement only the bounded function. Do not edit tests.\n",
    "utf8",
  );
  await writeFile(
    path.join(repository, "docs", "brief.md"),
    "The exported answerToCanary() function must return the integer 42.\n",
    "utf8",
  );
  await writeFile(
    path.join(repository, "src", "answer.mjs"),
    'export function answerToCanary() {\n  throw new Error("not implemented");\n}\n',
    "utf8",
  );
  await writeFile(
    path.join(repository, "test", "answer.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { answerToCanary } from "../src/answer.mjs";',
      "",
      'test("returns the bounded canary answer", () => {',
      "  assert.equal(answerToCanary(), 42);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(repository, "canary.js"),
    [
      "/* @conductor-contract",
      JSON.stringify(
        {
          id: "openai-responses-paid-canary",
          objective:
            "Implement answerToCanary() in src/answer.mjs from the selected brief. Make the smallest possible edit.",
          taskClass: "implementation",
          adapterId: "openai-responses",
          adapterOptions: { profile: profileId },
          scope: {
            allowedPaths: ["src/answer.mjs"],
            forbiddenPaths: [],
            protectedPaths: ["AGENTS.md", "docs", "test", "canary.js"],
          },
          contextRefs: ["docs/brief.md", "src/answer.mjs"],
          constraints: ["Use no dependencies and preserve the ESM export."],
          escalateWhen: ["The brief conflicts with the protected test."],
          setup: [],
          acceptance: [
            {
              profile: "node-test",
              args: ["test/answer.test.mjs"],
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

  await runtime.dispatcher.start();
  const sourceRun = await runtime.sources.compileAndEnqueue({
    repositoryPath: repository,
    baseRef: "HEAD",
    allowedAdapterIds: ["openai-responses"],
    includeExtensions: [".js"],
  });
  const jobId = sourceRun.enqueued[0]?.jobId;
  if (!jobId) throw new Error("Canary source package produced no job");
  const terminal = await waitForTerminal(jobId);
  if (!terminal.attemptId) throw new Error("Canary produced no attempt");
  attemptId = terminal.attemptId;
  const attempt = await runtime.conductor.getAttempt(attemptId);
  const verification = await runtime.conductor.getVerification(attemptId);
  const stdout = await readFile(attempt.artifacts.stdout, "utf8");
  const workerEvidence = parseWorkerEvidence(stdout);
  await assertSecretAbsent(attempt.artifacts, secret);
  const review = await runtime.conductor.getReviewBundle(attemptId);
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
        secretAbsentFromEvidence: true,
        reviewAuthority: review.packet.authority,
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
  await runtime.dispatcher.stop().catch(() => undefined);
  if (attemptId) {
    await runtime.conductor
      .removeAttemptWorkspace(attemptId)
      .catch(() => undefined);
  }
  await rm(temporary, { recursive: true, force: true });
}

async function waitForTerminal(jobId: string) {
  for (;;) {
    const item = (await runtime.dispatcher.list()).find(
      (candidate) => candidate.jobId === jobId,
    );
    if (
      item &&
      ["completed", "failed", "needs-input", "cancelled"].includes(item.status)
    ) {
      return item;
    }
    await Bun.sleep(250);
  }
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
