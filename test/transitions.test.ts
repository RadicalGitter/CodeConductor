import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Conductor } from "../src/orchestrator/conductor.js";
import { QueueStore } from "../src/queue/queue-store.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { TransitionConflictError } from "../src/storage/transitions.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository } from "./helpers.js";

test("legacy queue and attempt projections read as revision zero", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-legacy-"));
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([]),
  );
  const queue = new QueueStore(store);

  try {
    const contract = await store.reserveJob(
      legacyContract(repository.root, repository.revision),
    );
    const reserved = await store.reserveInitialAttempt(contract.contract);
    const enqueued = await queue.enqueue(contract.contract, {
      priority: 0,
      dependsOnJobIds: [],
    });
    for (const target of [
      reserved.manifest.artifacts.manifest,
      queue.itemPath(enqueued.item.jobId),
    ]) {
      const value = JSON.parse(await readFile(target, "utf8")) as Record<
        string,
        unknown
      >;
      delete value.revision;
      value.schema = target.includes("queue")
        ? "conductor.queue-item/v1"
        : "conductor.attempt/v1";
      await store.writeJsonAtomic(target, value);
    }

    expect(
      (await conductor.getAttempt(reserved.manifest.attemptId)).revision,
    ).toBe(0);
    const legacyQueueItem = await queue.read(enqueued.item.jobId);
    expect(legacyQueueItem.revision).toBe(0);
    const dispatching = await queue.update(legacyQueueItem, {
      status: "dispatching",
      dispatchOperationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(dispatching.schema).toBe("conductor.queue-item/v2");
    const running = await queue.update(dispatching, { status: "running" });
    const completed = await queue.update(running, { status: "completed" });
    const retried = await queue.update(completed, {
      status: "queued",
      dispatchOperationId: undefined,
    });
    await expect(
      queue.update(running, { status: "failed" }),
    ).rejects.toBeInstanceOf(TransitionConflictError);
    expect((await queue.read(retried.jobId)).status).toBe("queued");
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("a journaled transition survives projection failure and stale callbacks lose", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-journal-"));
  let fail = true;
  const faultedStore = new ArtifactStore(dataRoot, {
    transitionFailpoint(point) {
      if (fail && point === "after-snapshot") {
        fail = false;
        throw new Error("simulated projection crash");
      }
    },
  });

  try {
    const contract = await faultedStore.reserveJob(
      legacyContract(repository.root, repository.revision),
    );
    const reserved = await faultedStore.reserveInitialAttempt(
      contract.contract,
    );
    await expect(
      faultedStore.transitionAttempt(reserved.manifest, {
        status: "claimed",
        dispatchOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        launchOwner: {
          instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          processId: process.pid,
          claimedAt: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow("simulated projection crash");

    const recoveredStore = new ArtifactStore(dataRoot);
    const recovered = await recoveredStore.findAttempt(
      reserved.manifest.attemptId,
    );
    expect(recovered.status).toBe("claimed");
    expect(recovered.schema).toBe("conductor.attempt/v2");
    expect(recovered.revision).toBe(1);

    const terminal = await recoveredStore.transitionAttempt(recovered, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      verificationStatus: "ineligible",
    });
    expect(terminal.revision).toBe(2);
    await expect(
      recoveredStore.transitionAttempt(recovered, { status: "preparing" }),
    ).rejects.toBeInstanceOf(TransitionConflictError);
    await expect(
      recoveredStore.transitionAttempt(terminal, { status: "preparing" }),
    ).rejects.toThrow("Illegal attempt transition");
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

function legacyContract(repositoryPath: string, baseRevision: string) {
  const now = new Date().toISOString();
  return {
    schema: "conductor.job/v1" as const,
    jobId: "job_legacy_transition",
    requestFingerprint: "a".repeat(64),
    idempotencyKey: "legacy-transition",
    createdAt: now,
    objective: "Exercise additive legacy defaults",
    taskClass: "implementation" as const,
    repository: {
      root: repositoryPath,
      requestedRef: baseRevision,
      baseRevision,
    },
    worker: {
      adapterId: "fixture",
      options: {},
    },
    execution: {
      timeoutMs: 1_000,
      retainWorkspace: true,
      boundary: { kind: "host-worktree" as const },
    },
    scope: {
      allowedPaths: [],
      forbiddenPaths: [],
      protectedPaths: [],
    },
    contextRefs: [],
    constraints: [],
    escalateWhen: ["A required input is unavailable"],
    acceptanceCommands: [],
    setupCommands: [],
    authority: "proposal-only" as const,
  };
}
