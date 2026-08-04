import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JobContract } from "../src/contracts/job.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { ExecutionPolicy } from "../src/verification/command-executor.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository, runTestJob } from "./helpers.js";

const sourceFixture = fileURLToPath(
  new URL("./fixtures/mutate-worker.ts", import.meta.url),
);

test("sealed review evidence rejects mutation, replacement, deletion, addition, and packet tampering", async () => {
  const environment = await createEnvironment("tamper-matrix");
  try {
    const result = await runEligibleJob(environment, true);
    const first = await environment.conductor.getReviewBundle(result.attemptId);
    expect(first.packet.schema).toBe("conductor.review-packet/v2");
    expect(first.packet.attempt.workerProfile).toMatchObject({
      status: "complete",
      profileFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const purposes = new Set(
      first.packet.bindings.flatMap((binding) => binding.purposes),
    );
    for (const purpose of [
      "job",
      "attempt",
      "cleanup",
      "proposal-patch",
      "repository-status",
      "changed-paths",
      "verification",
      "worker-stdout",
      "worker-stderr",
      "command-stdout",
      "command-stderr",
      "worker-executable",
      "worker-harness",
      "worker-configuration",
    ] as const) {
      expect(purposes).toContain(purpose);
    }

    const mutableBindings = first.packet.bindings.filter((binding) =>
      binding.path.startsWith(environment.dataRoot),
    );
    for (const binding of mutableBindings) {
      const original = await readFile(binding.path);
      await writeFile(binding.path, mutate(original));
      await expect(
        environment.conductor.getReviewBundle(result.attemptId),
      ).rejects.toThrow();
      await writeFile(binding.path, original);
      await environment.conductor.getReviewBundle(result.attemptId);
    }

    const stdout = result.artifacts.stdout;
    const originalStdout = await readFile(stdout);
    await writeFile(stdout, sameSizeReplacement(originalStdout));
    await expect(
      environment.conductor.getReviewBundle(result.attemptId),
    ).rejects.toThrow("Sealed review evidence changed");
    await writeFile(stdout, originalStdout);

    const repositoryStatus = result.artifacts.repositoryStatus;
    const originalStatus = await readFile(repositoryStatus);
    await rm(repositoryStatus);
    await expect(
      environment.conductor.getReviewBundle(result.attemptId),
    ).rejects.toThrow();
    await writeFile(repositoryStatus, originalStatus);

    const attemptDirectory = path.dirname(result.artifacts.manifest);
    const added = path.join(attemptDirectory, "unsealed-addition.txt");
    await writeFile(added, "unexpected\n", "utf8");
    await expect(
      environment.conductor.getReviewBundle(result.attemptId),
    ).rejects.toThrow("Attempt evidence inventory changed");
    await rm(added);

    for (const target of [environment.harnessPath, environment.configPath]) {
      const original = await readFile(target);
      await writeFile(target, mutate(original));
      await expect(
        environment.conductor.getReviewBundle(result.attemptId),
      ).rejects.toThrow("Worker profile validation failed");
      await writeFile(target, original);
    }

    const packetPath = path.join(attemptDirectory, "review-packet.json");
    const originalPacket = await readFile(packetPath, "utf8");
    const changedPacket = JSON.parse(originalPacket) as { sealedAt: string };
    changedPacket.sealedAt = "2026-08-04T00:00:00.000Z";
    await writeFile(
      packetPath,
      `${JSON.stringify(changedPacket, null, 2)}\n`,
      "utf8",
    );
    await expect(
      environment.conductor.getReviewBundle(result.attemptId),
    ).rejects.toThrow("Review packet seal changed");
    await writeFile(packetPath, originalPacket, "utf8");

    const legacy = { schema: "conductor.review-packet/v1" };
    await writeFile(packetPath, `${JSON.stringify(legacy)}\n`, "utf8");
    await expect(
      environment.conductor.getReviewBundle(result.attemptId),
    ).rejects.toThrow("legacy packet");
    await writeFile(packetPath, originalPacket, "utf8");
    await environment.conductor.getReviewBundle(result.attemptId);

    const manifest = await environment.conductor.getAttempt(result.attemptId);
    const terminalSnapshot = path.join(
      attemptDirectory,
      "transitions",
      manifest.revision.toString().padStart(12, "0"),
      "attempt.json",
    );
    const originalSnapshot = await readFile(terminalSnapshot, "utf8");
    const redirected = JSON.parse(originalSnapshot) as {
      artifacts: { stdout: string };
    };
    redirected.artifacts.stdout = environment.configPath;
    await writeFile(
      terminalSnapshot,
      `${JSON.stringify(redirected, null, 2)}\n`,
      "utf8",
    );
    await expect(
      environment.conductor.getReviewBundle(result.attemptId),
    ).rejects.toThrow("Attempt artifact path changed");
    await writeFile(terminalSnapshot, originalSnapshot, "utf8");
    await environment.conductor.getReviewBundle(result.attemptId);
  } finally {
    await environment.cleanup();
  }
}, 90_000);

test("a sealed bundle survives restart after automatic worktree removal", async () => {
  const environment = await createEnvironment("restart-no-worktree");
  try {
    const result = await runEligibleJob(environment, false);
    expect(result.workspaceRetained).toBe(false);
    const simultaneous = await Promise.all(
      Array.from({ length: 20 }, () =>
        environment.conductor.getReviewBundle(result.attemptId),
      ),
    );
    const first = simultaneous[0]!;
    expect(
      simultaneous.every(
        (candidate) => candidate.packet.sealSha256 === first.packet.sealSha256,
      ),
    ).toBe(true);
    const restarted = new Conductor(
      environment.store,
      new GitWorkspaceManager(environment.store.workspaceRoot()),
      new WorkerRegistry([environment.adapter]),
      environment.policy,
    );
    const second = await restarted.getReviewBundle(result.attemptId);
    expect(second.packet).toEqual(first.packet);
    expect(second.patch).toEqual(first.patch);
  } finally {
    await environment.cleanup();
  }
}, 60_000);

test("model-bearing adapters without an explicit model remain ineligible", async () => {
  const environment = await createEnvironment("missing-model", true);
  try {
    const result = await runTestJob(environment.conductor, {
      objective: "Attempt work without a bound model selector",
      repositoryPath: environment.repository.root,
      adapterId: "sealed-fixture",
      idempotencyKey: "missing-model",
      retainWorkspace: true,
      scope: { allowedPaths: ["generated.txt"] },
    });
    expect(result.status).toBe("completed");
    expect(result.verificationStatus).toBe("ineligible");
    const attempt = await environment.conductor.getAttempt(result.attemptId);
    expect(attempt.workerProfile).toMatchObject({
      status: "unresolved",
      unresolvedReasons: [expect.stringContaining("explicit model selector")],
    });
    await expect(
      environment.conductor.getReviewBundle(result.attemptId),
    ).rejects.toThrow("not eligible for review");
  } finally {
    await environment.cleanup();
  }
}, 30_000);

async function runEligibleJob(
  environment: Awaited<ReturnType<typeof createEnvironment>>,
  retainWorkspace: boolean,
) {
  return runTestJob(environment.conductor, {
    objective: "Create a fully sealed review proposal",
    repositoryPath: environment.repository.root,
    adapterId: "sealed-fixture",
    adapterOptions:
      environment.adapter.description.modelIdentity === "required"
        ? { model: "fixture-model" }
        : {},
    idempotencyKey: `sealed-${retainWorkspace}`,
    retainWorkspace,
    scope: { allowedPaths: ["generated.txt"] },
    setupCommands: [
      {
        executable: process.execPath,
        args: ["-e", "console.log('setup evidence')"],
      },
    ],
    acceptanceCommands: [
      {
        executable: process.execPath,
        args: ["-e", "console.log('acceptance evidence')"],
      },
    ],
  });
}

async function createEnvironment(name: string, modelRequired = false) {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), `conductor-review-${name}-`),
  );
  const profileRoot = await mkdtemp(
    path.join(os.tmpdir(), `conductor-profile-${name}-`),
  );
  const harnessPath = path.join(profileRoot, "worker.ts");
  const configPath = path.join(profileRoot, "worker-profile.json");
  await copyFile(sourceFixture, harnessPath);
  await writeFile(configPath, '{"profile":"sealed-fixture"}\n', "utf8");
  const adapter = new SealedFixtureAdapter(
    harnessPath,
    configPath,
    modelRequired,
  );
  const store = new ArtifactStore(dataRoot);
  const policy = new ExecutionPolicy({
    allowedExecutables: [process.execPath],
  });
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([adapter]),
    policy,
  );
  return {
    repository,
    dataRoot,
    profileRoot,
    harnessPath,
    configPath,
    adapter,
    store,
    policy,
    conductor,
    cleanup: async () => {
      await rm(repository.root, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
      await rm(profileRoot, { recursive: true, force: true });
    },
  };
}

class SealedFixtureAdapter implements WorkerAdapter {
  readonly description;

  constructor(
    private readonly harnessPath: string,
    private readonly configPath: string,
    modelRequired: boolean,
  ) {
    this.description = {
      id: "sealed-fixture",
      label: "Sealed fixture",
      executable: process.execPath,
      mutationMode: "worktree" as const,
      outputFormat: "jsonl" as const,
      safetyMode: "test-fixture",
      available: true,
      modelIdentity: modelRequired
        ? ("required" as const)
        : ("not-applicable" as const),
    };
  }

  buildInvocation(_contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: [this.harnessPath, workspacePath],
      cwd: workspacePath,
    };
  }

  profileEvidence() {
    return {
      files: [
        { role: "harness" as const, path: this.harnessPath },
        { role: "configuration" as const, path: this.configPath },
      ],
      attributes: { fixture: "sealed" },
    };
  }
}

function mutate(value: Buffer): Buffer {
  if (value.length === 0) return Buffer.from("tampered\n");
  const changed = Buffer.from(value);
  changed[0] = changed[0] === 0x78 ? 0x79 : 0x78;
  return changed;
}

function sameSizeReplacement(value: Buffer): Buffer {
  if (value.length === 0) throw new Error("Expected non-empty fixture output");
  return mutate(value);
}
