import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JobContract } from "../src/contracts/job.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import { DurableDispatcher } from "../src/queue/dispatcher.js";
import { QueueStore } from "../src/queue/queue-store.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import type {
  WorkerAdapter,
  WorkerAttemptContext,
} from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository, runTestJob } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("./fixtures/lineage-worker.ts", import.meta.url),
);

test("dependent work consumes a hash-bound proposal lineage without widening child scope", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-lineage-"));
  const adapter = new LineageAdapter();
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([adapter]),
  );
  const queue = new QueueStore(store);
  const dispatcher = new DurableDispatcher(conductor, queue, {
    maxConcurrent: 2,
    pollIntervalMs: 25,
    leaseMs: 1_000,
  });

  try {
    const parent = await dispatcher.enqueue(
      request(repository.root, "lineage-parent", ["parent.txt"], {
        action: "write",
        path: "parent.txt",
        content: "parent proposal\n",
      }),
    );
    const middle = await dispatcher.enqueue({
      ...request(repository.root, "lineage-middle", ["middle.txt"], {
        action: "derive",
        readPath: "parent.txt",
        writePath: "middle.txt",
        suffix: " plus middle",
      }),
      queue: { dependsOnJobIds: [parent.item.jobId] },
    });
    const child = await dispatcher.enqueue({
      ...request(repository.root, "lineage-child", ["child.txt"], {
        action: "derive",
        readPath: "middle.txt",
        writePath: "child.txt",
        suffix: " plus child",
      }),
      queue: { dependsOnJobIds: [middle.item.jobId] },
    });

    await dispatcher.runUntilIdle();
    const parentItem = await queue.read(parent.item.jobId);
    const middleItem = await queue.read(middle.item.jobId);
    const childItem = await queue.read(child.item.jobId);
    expect(childItem.status).toBe("completed");
    const parentAttemptId = parentItem.attemptId!;
    const middleAttemptId = middleItem.attemptId!;
    const childAttempt = await conductor.getAttempt(childItem.attemptId!);
    expect(childAttempt.lineage).toMatchObject({
      status: "composed",
      directParentAttemptIds: [middleAttemptId],
    });
    expect(
      childAttempt.lineage?.contributions.map((entry) => entry.attemptId),
    ).toEqual([parentAttemptId, middleAttemptId]);
    expect(childAttempt.workspace?.baseRevision).not.toBe(repository.revision);
    expect(
      JSON.parse(await readFile(childAttempt.artifacts.changedPaths, "utf8")),
    ).toEqual(["child.txt"]);
    expect(
      await readFile(
        path.join(childAttempt.workspace!.path, "parent.txt"),
        "utf8",
      ),
    ).toMatch(/^parent proposal\r?\n$/);
    expect(
      await readFile(
        path.join(childAttempt.workspace!.path, "child.txt"),
        "utf8",
      ),
    ).toBe("parent proposal plus middle plus child\n");
    expect(await exists(path.join(repository.root, "parent.txt"))).toBe(false);
    expect(adapter.contexts.at(-1)).toMatchObject({
      workspaceBaseRevision: childAttempt.workspace?.baseRevision,
      sourceBaseRevision: repository.revision,
      proposalContributionAttemptIds: [parentAttemptId, middleAttemptId],
    });
    expect(
      (await conductor.getReviewPacket(childAttempt.attemptId)).attempt.lineage,
    ).toMatchObject({
      derivedRevision: childAttempt.workspace?.baseRevision,
      status: "composed",
    });
    const contribution = childAttempt.lineage!.contributions[0]!;
    for (const target of [
      contribution.patchPath,
      contribution.verificationPath,
    ]) {
      const original = await readFile(target);
      await writeFile(target, Buffer.concat([original, Buffer.from("tamper")]));
      await expect(
        conductor.getReviewPacket(childAttempt.attemptId),
      ).rejects.toThrow();
      await writeFile(target, original);
      await conductor.getReviewPacket(childAttempt.attemptId);
    }

    const reconstruction = await conductor.workspaces.create({
      repositoryRoot: repository.root,
      baseRevision: repository.revision,
      attemptId: "lineage-reconstruction",
    });
    const reconstructed = await conductor.workspaces.composeProposalBaseline(
      reconstruction,
      childAttempt.lineage!.contributions,
    );
    expect(reconstructed.baseRevision).toBe(
      childAttempt.workspace!.baseRevision,
    );
    await conductor.workspaces.remove(reconstructed);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 15_000);

test("composition rejects evidence tampering before starting the child worker", async () => {
  const environment = await createEnvironment("tamper");
  try {
    const parent = await runTestJob(
      environment.conductor,
      request(environment.repository.root, "tamper-parent", ["parent.txt"], {
        action: "write",
        path: "parent.txt",
        content: "bound proposal\n",
      }),
    );
    const child = await environment.conductor.prepareJob(
      request(environment.repository.root, "tamper-child", ["child.txt"], {
        action: "write",
        path: "child.txt",
        content: "must not run\n",
      }),
    );
    const reserved = await environment.conductor.reservePreparedAttempt(
      child.jobId,
      [parent.attemptId],
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const parentAttempt = await environment.conductor.getAttempt(
      parent.attemptId,
    );
    await writeFile(
      parentAttempt.artifacts.proposalPatch,
      "tampered\n",
      "utf8",
    );

    await environment.conductor.startReservedAttempt(
      reserved.attemptId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const result = await environment.conductor.waitForAttempt(
      reserved.attemptId,
    );
    expect(result.status).toBe("needs-input");
    expect(result.failure?.kind).toBe("composition-failed");
    const attempt = await environment.conductor.getAttempt(reserved.attemptId);
    expect(attempt.lineage?.status).toBe("rejected");
    expect(await exists(path.join(attempt.workspace!.path, "child.txt"))).toBe(
      false,
    );
  } finally {
    await environment.cleanup();
  }
}, 15_000);

test("composition quarantines conflicting sibling proposals without running the child", async () => {
  const environment = await createEnvironment("conflict");
  try {
    const first = await runTestJob(
      environment.conductor,
      request(environment.repository.root, "conflict-first", ["seed.txt"], {
        action: "write",
        path: "seed.txt",
        content: "first sibling\n",
      }),
    );
    const second = await runTestJob(
      environment.conductor,
      request(environment.repository.root, "conflict-second", ["seed.txt"], {
        action: "write",
        path: "seed.txt",
        content: "second sibling\n",
      }),
    );
    const child = await environment.conductor.prepareJob(
      request(environment.repository.root, "conflict-child", ["child.txt"], {
        action: "write",
        path: "child.txt",
        content: "must not run\n",
      }),
    );
    const reserved = await environment.conductor.reservePreparedAttempt(
      child.jobId,
      [first.attemptId, second.attemptId],
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );

    await environment.conductor.startReservedAttempt(
      reserved.attemptId,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    const result = await environment.conductor.waitForAttempt(
      reserved.attemptId,
    );
    expect(result.status).toBe("needs-input");
    expect(result.failure?.kind).toBe("composition-failed");
    const attempt = await environment.conductor.getAttempt(reserved.attemptId);
    expect(attempt.lineage?.failure).toContain("git apply failed");
    expect(await exists(path.join(attempt.workspace!.path, "child.txt"))).toBe(
      false,
    );
  } finally {
    await environment.cleanup();
  }
}, 15_000);

class LineageAdapter implements WorkerAdapter {
  readonly contexts: WorkerAttemptContext[] = [];
  readonly description = {
    id: "lineage-fixture",
    label: "Lineage fixture",
    executable: process.execPath,
    mutationMode: "worktree" as const,
    outputFormat: "jsonl" as const,
    safetyMode: "test-fixture",
    available: true,
    modelIdentity: "not-applicable" as const,
  };

  buildInvocation(
    contract: JobContract,
    workspacePath: string,
    attemptContext?: WorkerAttemptContext,
  ) {
    if (attemptContext) this.contexts.push(attemptContext);
    return {
      executable: process.execPath,
      args: [fixture, workspacePath, JSON.stringify(contract.worker.options)],
      cwd: workspacePath,
    };
  }
}

function request(
  repositoryPath: string,
  idempotencyKey: string,
  allowedPaths: string[],
  instruction: Record<string, unknown>,
) {
  return {
    objective: `Run ${idempotencyKey}`,
    repositoryPath,
    adapterId: "lineage-fixture",
    adapterOptions: instruction,
    idempotencyKey,
    scope: { allowedPaths },
  };
}

async function createEnvironment(name: string) {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), `conductor-${name}-`));
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new LineageAdapter()]),
  );
  return {
    repository,
    dataRoot,
    conductor,
    cleanup: async () => {
      await rm(repository.root, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
