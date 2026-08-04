import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JobContract } from "../src/contracts/job.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import {
  DurableDispatcher,
  type DispatchFailpointName,
} from "../src/queue/dispatcher.js";
import { QueueStore } from "../src/queue/queue-store.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("./fixtures/delayed-worker.ts", import.meta.url),
);
const crashFixture = fileURLToPath(
  new URL("./fixtures/crash-dispatcher.ts", import.meta.url),
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
}, 10_000);

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
    const dispatchOperationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const reserved = await conductor.reservePreparedAttempt(
      enqueued.item.jobId,
      [],
      dispatchOperationId,
    );
    const dispatching = await queue.update(enqueued.item, {
      status: "dispatching",
      dispatchOperationId,
    });
    await queue.update(dispatching, {
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

test("every pre-launch dispatch crash boundary recovers without duplicate work", async () => {
  const failpoints: DispatchFailpointName[] = [
    "after-queue-dispatching",
    "after-attempt-reserved",
    "after-queue-bound",
    "after-attempt-claimed",
  ];

  for (const [index, point] of failpoints.entries()) {
    const repository = await createTestRepository();
    const dataRoot = await mkdtemp(
      path.join(os.tmpdir(), `conductor-dispatch-${index}-`),
    );
    const adapter = new DelayedAdapter();
    const firstStore = new ArtifactStore(dataRoot);
    const firstConductor = new Conductor(
      firstStore,
      new GitWorkspaceManager(firstStore.workspaceRoot()),
      new WorkerRegistry([adapter]),
    );
    const firstQueue = new QueueStore(firstStore);
    let injected = false;
    const firstDispatcher = new DurableDispatcher(firstConductor, firstQueue, {
      pollIntervalMs: 25,
      leaseMs: 1_000,
      ownerId: `crash-before-${point}`,
      failpoint(reached) {
        if (!injected && reached === point) {
          injected = true;
          throw new Error("simulated abrupt stop");
        }
      },
    });

    try {
      const enqueued = await firstDispatcher.enqueue(
        request(repository.root, `crash-${index}`, 5),
      );
      await expect(firstDispatcher.runUntilIdle()).rejects.toThrow(
        `Dispatch failpoint ${point}`,
      );
      expect(injected).toBe(true);

      const recoveredStore = new ArtifactStore(dataRoot);
      const recoveredConductor = new Conductor(
        recoveredStore,
        new GitWorkspaceManager(recoveredStore.workspaceRoot()),
        new WorkerRegistry([adapter]),
      );
      const recoveredQueue = new QueueStore(recoveredStore);
      const recoveredDispatcher = new DurableDispatcher(
        recoveredConductor,
        recoveredQueue,
        {
          pollIntervalMs: 25,
          leaseMs: 1_000,
          ownerId: `crash-recovery-${point}`,
        },
      );
      await recoveredDispatcher.runUntilIdle();

      const finalItem = await recoveredQueue.read(enqueued.item.jobId);
      expect(finalItem.status).toBe("completed");
      const attempts = (await recoveredConductor.listAttempts()).filter(
        (attempt) => attempt.jobId === enqueued.item.jobId,
      );
      expect(
        attempts.filter((attempt) => attempt.status === "completed"),
      ).toHaveLength(1);
      expect(
        attempts.every((attempt) =>
          ["completed", "cancelled"].includes(attempt.status),
        ),
      ).toBe(true);
      expect(adapter.launches).toBe(1);
    } finally {
      await rm(repository.root, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
}, 30_000);

test("abrupt process termination at every pre-launch boundary converges after restart", async () => {
  const failpoints: DispatchFailpointName[] = [
    "after-queue-dispatching",
    "after-attempt-reserved",
    "after-queue-bound",
    "after-attempt-claimed",
  ];

  for (const [index, point] of failpoints.entries()) {
    const repository = await createTestRepository();
    const dataRoot = await mkdtemp(
      path.join(os.tmpdir(), `conductor-abrupt-${index}-`),
    );
    const key = `abrupt-dispatch-${index}`;

    try {
      const exitCode = await runCrashFixture([
        dataRoot,
        repository.root,
        key,
        point,
      ]);
      expect(exitCode).toBe(91);
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      const adapter = new DelayedAdapter("crash-fixture");
      const store = new ArtifactStore(dataRoot);
      const conductor = new Conductor(
        store,
        new GitWorkspaceManager(store.workspaceRoot()),
        new WorkerRegistry([adapter]),
      );
      const queue = new QueueStore(store);
      const dispatcher = new DurableDispatcher(conductor, queue, {
        pollIntervalMs: 25,
        leaseMs: 1_000,
        ownerId: `abrupt-recovery-${point}`,
      });
      const items = await dispatcher.runUntilIdle();
      expect(items).toHaveLength(1);
      expect(items[0]?.status).toBe("completed");
      const attempts = await conductor.listAttempts();
      expect(
        attempts.filter((attempt) => attempt.status === "completed"),
      ).toHaveLength(1);
      expect(
        attempts.every((attempt) =>
          ["completed", "cancelled"].includes(attempt.status),
        ),
      ).toBe(true);
      expect(adapter.launches).toBe(1);
    } finally {
      await rm(repository.root, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
}, 45_000);

test("active cancellation remains nonterminal until attempt evidence closes", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-cancel-"));
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new DelayedAdapter()]),
  );
  const queue = new QueueStore(store);
  const dispatcher = new DurableDispatcher(conductor, queue, {
    pollIntervalMs: 25,
    leaseMs: 1_000,
    ownerId: "cancellation-test",
  });

  try {
    await dispatcher.start();
    const enqueued = await dispatcher.enqueue(
      request(repository.root, "cancel-active", 2_000),
    );
    const running = await waitForStatus(queue, enqueued.item.jobId, "running");
    await waitForAttemptStatus(conductor, running.attemptId!, [
      "preparing",
      "running",
    ]);
    const cancelling = await dispatcher.cancel(enqueued.item.jobId);
    expect(cancelling.status).toBe("cancelling");

    const terminal = await waitForStatus(
      queue,
      enqueued.item.jobId,
      "cancelled",
    );
    expect(terminal.completion?.attemptStatus).toBe("cancelled");
  } finally {
    await dispatcher.stop({ cancelActive: true });
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 15_000);

class DelayedAdapter implements WorkerAdapter {
  launches = 0;
  readonly description;

  constructor(id = "delayed") {
    this.description = {
      id,
      label: "Delayed fixture",
      executable: process.execPath,
      mutationMode: "worktree" as const,
      outputFormat: "jsonl" as const,
      safetyMode: "test-fixture",
      available: true,
      modelIdentity: "not-applicable" as const,
    };
  }

  buildInvocation(contract: JobContract, workspacePath: string) {
    this.launches += 1;
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

async function waitForStatus(queue: QueueStore, jobId: string, status: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const item = await queue.read(jobId);
    if (item.status === status) return item;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Queue item ${jobId} did not reach ${status}`);
}

function runCrashFixture(args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [crashFixture, ...args], {
      cwd: path.dirname(crashFixture),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 91) resolve(code);
      else reject(new Error(`Crash fixture exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function waitForAttemptStatus(
  conductor: Conductor,
  attemptId: string,
  statuses: string[],
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const attempt = await conductor.getAttempt(attemptId);
    if (statuses.includes(attempt.status)) return attempt;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Attempt ${attemptId} did not reach one of: ${statuses.join(", ")}`,
  );
}
