import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JobContract } from "../src/contracts/job.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { ExecutionPolicy } from "../src/verification/command-executor.js";
import { verificationRecordSchema } from "../src/verification/types.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository, runTestJob } from "./helpers.js";

const standardFixture = fileURLToPath(
  new URL("./fixtures/mutate-worker.ts", import.meta.url),
);
const protectedFixture = fileURLToPath(
  new URL("./fixtures/mutate-protected-worker.ts", import.meta.url),
);

test("setup, scope, and acceptance evidence gate review eligibility", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-verification-"),
  );
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([
      new FixtureAdapter("fixture", standardFixture),
      new FixtureAdapter("fixture-protected", protectedFixture),
    ]),
    new ExecutionPolicy({ allowedExecutables: [process.execPath] }),
  );
  const retainedAttempts: string[] = [];

  try {
    const eligible = await runTestJob(conductor, {
      objective: "Create the allowed generated file",
      repositoryPath: repository.root,
      adapterId: "fixture",
      idempotencyKey: "verification-eligible",
      scope: {
        allowedPaths: ["generated.txt"],
        protectedPaths: ["seed.txt"],
      },
      setupCommands: [evalCommand("console.log('prepared')")],
      acceptanceCommands: [
        evalCommand(
          "const fs=require('node:fs'); process.exit(fs.existsSync('generated.txt')?0:1)",
        ),
      ],
    });
    retainedAttempts.push(eligible.attemptId);
    expect(eligible.status).toBe("completed");
    expect(eligible.verificationStatus).toBe("eligible");
    const eligibleEvidence = await readVerification(
      eligible.artifacts.verification,
    );
    expect(eligibleEvidence.setup).toMatchObject({
      status: "passed",
      repositoryClean: true,
    });
    expect(eligibleEvidence.scope).toMatchObject({
      status: "passed",
      changedPaths: ["generated.txt"],
      violations: [],
    });
    expect(eligibleEvidence.acceptance).toMatchObject({
      status: "passed",
      proposalStable: true,
    });
    expect(eligibleEvidence.eligibleForReview).toBe(true);
    expect(await exists(eligibleEvidence.setup.commands[0]!.stdout!)).toBe(
      true,
    );
    expect(await conductor.getVerification(eligible.attemptId)).toEqual(
      eligibleEvidence,
    );
    const boundedPatch = await conductor.readAttemptArtifact(
      eligible.attemptId,
      "proposalPatch",
      16,
    );
    expect(boundedPatch.name).toBe("proposalPatch");
    expect(boundedPatch.truncated).toBe(true);
    expect(Buffer.byteLength(boundedPatch.text)).toBeLessThanOrEqual(16);
    await conductor.removeAttemptWorkspace(eligible.attemptId);
    retainedAttempts.pop();

    const scopeViolation = await runTestJob(conductor, {
      objective: "Attempt to change a protected file",
      repositoryPath: repository.root,
      adapterId: "fixture-protected",
      idempotencyKey: "verification-scope-failure",
      scope: {
        allowedPaths: ["generated.txt"],
        protectedPaths: ["seed.txt"],
      },
      acceptanceCommands: [
        evalCommand(
          "require('node:fs').writeFileSync('acceptance-ran.txt','should not run')",
        ),
      ],
    });
    retainedAttempts.push(scopeViolation.attemptId);
    expect(scopeViolation.status).toBe("completed");
    expect(scopeViolation.verificationStatus).toBe("ineligible");
    const scopeEvidence = await readVerification(
      scopeViolation.artifacts.verification,
    );
    expect(scopeEvidence.scope.status).toBe("failed");
    expect(scopeEvidence.scope.violations).toContainEqual({
      path: "seed.txt",
      kind: "protected",
      rule: "seed.txt",
    });
    expect(scopeEvidence.acceptance.status).toBe("not-run");
    expect(
      await exists(
        path.join(scopeViolation.workspacePath!, "acceptance-ran.txt"),
      ),
    ).toBe(false);
    await conductor.removeAttemptWorkspace(scopeViolation.attemptId);
    retainedAttempts.pop();

    const verifierMutation = await runTestJob(conductor, {
      objective: "Create the allowed generated file before a mutating check",
      repositoryPath: repository.root,
      adapterId: "fixture",
      idempotencyKey: "verification-mutating-check",
      scope: { allowedPaths: ["generated.txt"] },
      acceptanceCommands: [
        evalCommand(
          "require('node:fs').writeFileSync('acceptance-mutation.txt','mutation')",
        ),
      ],
    });
    retainedAttempts.push(verifierMutation.attemptId);
    expect(verifierMutation.status).toBe("completed");
    expect(verifierMutation.verificationStatus).toBe("ineligible");
    const mutationEvidence = await readVerification(
      verifierMutation.artifacts.verification,
    );
    expect(mutationEvidence.acceptance).toMatchObject({
      status: "passed",
      proposalStable: false,
    });
    expect(mutationEvidence.eligibleForReview).toBe(false);
    await conductor.removeAttemptWorkspace(verifierMutation.attemptId);
    retainedAttempts.pop();

    const dirtySetup = await runTestJob(conductor, {
      objective: "Worker must not run after setup mutates repository state",
      repositoryPath: repository.root,
      adapterId: "fixture",
      idempotencyKey: "verification-dirty-setup",
      retainWorkspace: false,
      setupCommands: [
        evalCommand(
          "require('node:fs').writeFileSync('setup-mutation.txt','dirty')",
        ),
      ],
    });
    expect(dirtySetup.status).toBe("failed");
    expect(dirtySetup.failure?.kind).toBe("setup-failed");
    expect(dirtySetup.verificationStatus).toBe("ineligible");
    expect(dirtySetup.workspaceRetained).toBe(false);
    expect(await exists(dirtySetup.workspacePath!)).toBe(false);
    const setupEvidence = await readVerification(
      dirtySetup.artifacts.verification,
    );
    expect(setupEvidence.setup).toMatchObject({
      status: "failed",
      repositoryClean: false,
    });
    expect(setupEvidence.acceptance.status).toBe("not-run");
  } finally {
    for (const attemptId of retainedAttempts.reverse()) {
      await conductor.removeAttemptWorkspace(attemptId).catch(() => undefined);
    }
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 15_000);

class FixtureAdapter implements WorkerAdapter {
  readonly description;

  constructor(
    id: string,
    private readonly fixture: string,
  ) {
    this.description = {
      id,
      label: id,
      executable: process.execPath,
      mutationMode: "worktree" as const,
      outputFormat: "jsonl" as const,
      safetyMode: "test-fixture",
      available: true,
    };
  }

  buildInvocation(_contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: [this.fixture, workspacePath],
      cwd: workspacePath,
    };
  }
}

function evalCommand(source: string) {
  return { executable: process.execPath, args: ["-e", source] };
}

async function readVerification(target: string) {
  return verificationRecordSchema.parse(
    JSON.parse(await readFile(target, "utf8")),
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
