import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JobContract } from "../src/contracts/job.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import { DurableDispatcher } from "../src/queue/dispatcher.js";
import { QueueStore } from "../src/queue/queue-store.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("./fixtures/delayed-worker.ts", import.meta.url),
);

test("durably schedules parallel jobs and gates dependent work", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-queue-"));
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new DelayedAdapter()]),
  );
  const queue = new QueueStore(store);
  const dispatcher = new DurableDispatcher(conductor, queue, {
    maxConcurrent: 2,
    pollIntervalMs: 25,
    leaseMs: 1_000,
    ownerId: "queue-test",
  });

  try {
    const first = await dispatcher.enqueue(
      request(repository.root, "first", 250),
    );
    const independent = await dispatcher.enqueue(
      request(repository.root, "independent", 250),
    );
    const dependent = await dispatcher.enqueue({
      ...request(repository.root, "dependent", 10),
      queue: { dependsOnJobIds: [first.item.jobId] },
    });

    const items = await dispatcher.runUntilIdle();
    expect(items.map((item) => item.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(items.every((item) => item.completion)).toBe(true);

    const firstAttempt = await conductor.getAttempt(
      (await queue.read(first.item.jobId)).attemptId!,
    );
    const independentAttempt = await conductor.getAttempt(
      (await queue.read(independent.item.jobId)).attemptId!,
    );
    const dependentAttempt = await conductor.getAttempt(
      (await queue.read(dependent.item.jobId)).attemptId!,
    );
    expect(
      Date.parse(independentAttempt.startedAt!) <
        Date.parse(firstAttempt.finishedAt!),
    ).toBe(true);
    expect(
      Date.parse(dependentAttempt.startedAt!) >=
        Date.parse(firstAttempt.finishedAt!),
    ).toBe(true);
    expect(dependent.item.dependsOnJobIds).toEqual([first.item.jobId]);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("single-owner lease and restart recovery prohibit duplicate orphan work", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-recovery-"));
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new DelayedAdapter()]),
  );
  const queue = new QueueStore(store);

  try {
    const firstLease = await queue.acquireLease("owner-one", 5_000);
    expect(firstLease).toBeTruthy();
    expect(await queue.acquireLease("owner-two", 5_000)).toBeUndefined();
    await store.writeJsonAtomic(
      path.join(dataRoot, "queue", "dispatcher.lock", "lease.json"),
      {
        ...firstLease,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    );
    expect(await queue.acquireLease("owner-two", 5_000)).toBeUndefined();
    await queue.releaseLease(firstLease!);
    const secondLease = await queue.acquireLease("owner-two", 5_000);
    expect(secondLease?.generation).toBe(firstLease!.generation + 1);
    await queue.releaseLease(firstLease!);
    expect(await queue.renewLease(secondLease!, 5_000)).toMatchObject({
      instanceId: secondLease!.instanceId,
    });
    await queue.releaseLease(secondLease!);

    const deadLease = await queue.acquireLease("owner-dead", 5_000);
    await store.writeJsonAtomic(
      path.join(dataRoot, "queue", "dispatcher.lock", "lease.json"),
      {
        ...deadLease,
        processId: 999_999_999,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    );
    const recoveredLease = await queue.acquireLease("owner-recovered", 5_000);
    expect(recoveredLease?.generation).toBe(deadLease!.generation + 1);
    await queue.releaseLease(recoveredLease!);

    const dispatcher = new DurableDispatcher(conductor, queue, {
      pollIntervalMs: 25,
      leaseMs: 1_000,
      ownerId: "recovery-test",
    });
    const enqueued = await dispatcher.enqueue(
      request(repository.root, "orphan", 10),
    );
    const reserved = await conductor.reservePreparedAttempt(
      enqueued.item.jobId,
    );
    await queue.update(enqueued.item, {
      status: "running",
      attemptId: reserved.attemptId,
    });

    await dispatcher.runUntilIdle();
    const recovered = await queue.read(enqueued.item.jobId);
    expect(recovered.status).toBe("completed");
    expect(recovered.attemptId).not.toBe(reserved.attemptId);
    expect((await conductor.getAttempt(reserved.attemptId)).status).toBe(
      "cancelled",
    );
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

class DelayedAdapter implements WorkerAdapter {
  readonly description = {
    id: "delayed",
    label: "Delayed fixture",
    executable: process.execPath,
    mutationMode: "worktree" as const,
    outputFormat: "jsonl" as const,
    safetyMode: "test-fixture",
    available: true,
  };

  buildInvocation(contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: [fixture, workspacePath, String(contract.worker.options.delayMs)],
      cwd: workspacePath,
    };
  }
}

function request(repositoryPath: string, key: string, delayMs: number) {
  return {
    objective: `Run queued fixture ${key}`,
    repositoryPath,
    adapterId: "delayed",
    adapterOptions: { delayMs },
    idempotencyKey: `queue-${key}`,
    scope: { allowedPaths: ["generated.txt"] },
  };
}
