import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Conductor } from "../src/orchestrator/conductor.js";
import type { JobContract } from "../src/contracts/job.js";
import {
  ArtifactStore,
  IdempotencyConflictError,
} from "../src/storage/artifact-store.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import {
  GitWorkspaceManager,
  type GitWorkspace,
} from "../src/workspaces/git-workspace.js";
import { createTestRepository } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("./fixtures/mutate-worker.ts", import.meta.url),
);

test("runs a durable proposal in an exact-revision worktree and replays idempotently", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-data-"));
  const store = new ArtifactStore(dataRoot);
  const workspaces = new GitWorkspaceManager(store.workspaceRoot());
  const conductor = new Conductor(
    store,
    workspaces,
    new WorkerRegistry([new FixtureAdapter()]),
  );
  let retainedWorkspace: GitWorkspace | undefined;

  try {
    const request = {
      objective: "Create generated.txt as a worker proposal",
      repositoryPath: repository.root,
      adapterId: "fixture",
      idempotencyKey: "durable-proposal-test",
      retainWorkspace: true,
    };
    const submissions = await Promise.all([
      conductor.submitJob(request),
      conductor.submitJob(request),
    ]);
    expect(
      submissions.filter((submission) => !submission.idempotentReplay),
    ).toHaveLength(1);
    expect(
      new Set(submissions.map((submission) => submission.attemptId)).size,
    ).toBe(1);
    const submitted = submissions.find(
      (submission) => !submission.idempotentReplay,
    )!;
    expect(submitted.status).toBe("reserved");
    const result = await conductor.waitForAttempt(submitted.attemptId);
    retainedWorkspace = {
      path: result.workspacePath!,
      repositoryRoot: repository.root,
      baseRevision: repository.revision,
    };
    expect(result.status).toBe("completed");
    expect(result.idempotentReplay).toBe(false);
    expect(result.workspacePath).toBeTruthy();
    expect(await exists(path.join(repository.root, "generated.txt"))).toBe(
      false,
    );
    expect(
      await readFile(path.join(result.workspacePath!, "generated.txt"), "utf8"),
    ).toBe("worker proposal\n");
    expect(await readFile(result.artifacts.stdout, "utf8")).toContain(
      "worker_complete",
    );
    expect(await readFile(result.artifacts.proposalPatch, "utf8")).toContain(
      "generated.txt",
    );

    const manifest = await conductor.getAttempt(result.attemptId);
    expect(manifest.workspace?.baseRevision).toBe(repository.revision);
    expect(manifest.reviewDisposition).toBe("not-requested");

    const replay = await conductor.runJob(request);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.attemptId).toBe(result.attemptId);

    await expect(
      conductor.runJob({ ...request, objective: "A conflicting objective" }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const removed = await conductor.removeAttemptWorkspace(result.attemptId);
    expect(removed.workspace?.retained).toBe(false);
    expect(await exists(result.workspacePath!)).toBe(false);
    retainedWorkspace = undefined;
  } finally {
    if (retainedWorkspace) await workspaces.remove(retainedWorkspace);
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

class FixtureAdapter implements WorkerAdapter {
  readonly description = {
    id: "fixture",
    label: "Fixture worker",
    executable: process.execPath,
    mutationMode: "worktree" as const,
    outputFormat: "jsonl" as const,
    safetyMode: "test-fixture",
  };

  buildInvocation(_contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: [fixture, workspacePath],
      cwd: workspacePath,
    };
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
