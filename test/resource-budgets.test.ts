import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JobContract } from "../src/contracts/job.js";
import {
  DEFAULT_OWNER_RESOURCE_PROFILE,
  ownerResourceProfileSchema,
  type OwnerResourceProfile,
  type ResourceLimits,
} from "../src/contracts/resources.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository, runTestJob } from "./helpers.js";

test("owner policy freezes exact limits and rejects command-count widening", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-budget-"));
  const profile = resourceProfile({ maxCommands: 1, minimumFreeDiskBytes: 0 });
  const conductor = createConductor(
    dataRoot,
    new InlineAdapter("process.exit(0)"),
    profile,
  );
  try {
    const command = {
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    };
    await expect(
      conductor.prepareJob({
        objective: "Too many commands",
        repositoryPath: repository.root,
        adapterId: "inline",
        setupCommands: [command],
        acceptanceCommands: [command],
      }),
    ).rejects.toThrow("owner profile allows 1");

    const contract = await conductor.prepareJob({
      objective: "Freeze one bounded command",
      repositoryPath: repository.root,
      adapterId: "inline",
      setupCommands: [command],
      timeoutMs: 86_400_000,
      idempotencyKey: "frozen-budget",
    });
    expect(contract.schema).toBe("conductor.job/v2");
    expect(contract.resources.maxCommands).toBe(1);
    expect(contract.resources.attemptTimeoutMs).toBe(
      profile.limits.attemptTimeoutMs,
    );
    expect(contract.resources.profileFingerprint).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("one total attempt deadline covers the worker instead of resetting per phase", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-deadline-"));
  const conductor = createConductor(
    dataRoot,
    new InlineAdapter("setTimeout(() => process.exit(0), 5_000)"),
    resourceProfile({ attemptTimeoutMs: 1_000, minimumFreeDiskBytes: 0 }),
  );
  try {
    const started = performance.now();
    const result = await runTestJob(conductor, {
      objective: "Exercise the total deadline",
      repositoryPath: repository.root,
      adapterId: "inline",
      idempotencyKey: "total-deadline",
      retainWorkspace: false,
    });
    expect(result.status).toBe("failed");
    expect(result.failure?.kind).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(4_500);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 15_000);

test("oversized proposals fail before an oversized patch artifact is written", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-patch-limit-"),
  );
  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "fs.writeFileSync(path.join(process.cwd(),'large.txt'),'x'.repeat(20_000))",
  ].join(";");
  const conductor = createConductor(
    dataRoot,
    new InlineAdapter(script),
    resourceProfile({ maxPatchBytes: 1_024, minimumFreeDiskBytes: 0 }),
  );
  try {
    const result = await runTestJob(conductor, {
      objective: "Generate a deliberately oversized proposal",
      repositoryPath: repository.root,
      adapterId: "inline",
      idempotencyKey: "patch-limit",
      retainWorkspace: false,
    });
    expect(result.status).toBe("failed");
    expect(result.failure?.kind).toBe("resource-limit");
    expect(result.failure?.message).toContain("output exceeded 1024 bytes");
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 20_000);

test("attempt reservation stops at the frozen per-job ceiling", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-attempt-limit-"),
  );
  const conductor = createConductor(
    dataRoot,
    new InlineAdapter("process.exit(0)"),
    resourceProfile({ maxAttemptsPerJob: 1, minimumFreeDiskBytes: 0 }),
  );
  try {
    const contract = await conductor.prepareJob({
      objective: "Reserve exactly one attempt",
      repositoryPath: repository.root,
      adapterId: "inline",
      idempotencyKey: "attempt-limit",
    });
    await conductor.store.reserveAttempt(contract);
    await expect(conductor.store.reserveAttempt(contract)).rejects.toThrow(
      "Attempt budget exhausted",
    );
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

class InlineAdapter implements WorkerAdapter {
  readonly description = {
    id: "inline",
    label: "Inline fixture worker",
    executable: process.execPath,
    mutationMode: "worktree" as const,
    outputFormat: "text" as const,
    safetyMode: "test-fixture",
    available: true,
    modelIdentity: "not-applicable" as const,
  };

  constructor(private readonly script: string) {}

  buildInvocation(_contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: ["-e", this.script],
      cwd: workspacePath,
    };
  }
}

function createConductor(
  dataRoot: string,
  adapter: WorkerAdapter,
  profile: OwnerResourceProfile,
) {
  const store = new ArtifactStore(dataRoot);
  return new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([adapter]),
    undefined,
    undefined,
    profile,
  );
}

function resourceProfile(
  overrides: Partial<ResourceLimits>,
): OwnerResourceProfile {
  return ownerResourceProfileSchema.parse({
    ...structuredClone(DEFAULT_OWNER_RESOURCE_PROFILE),
    profileId: `test-${Object.keys(overrides).sort().join("-")}`,
    limits: {
      ...DEFAULT_OWNER_RESOURCE_PROFILE.limits,
      ...overrides,
    },
  });
}
