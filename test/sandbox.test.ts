import { expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AttemptManifest } from "../src/contracts/attempt.js";
import type { JobContract } from "../src/contracts/job.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import { DurableDispatcher } from "../src/queue/dispatcher.js";
import { QueueStore } from "../src/queue/queue-store.js";
import {
  buildSandboxedCommand,
  SandboxProfiles,
} from "../src/sandbox/docker.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository, runTestJob } from "./helpers.js";

const digest = "a".repeat(64);

test("external sandbox profiles freeze a least-authority Docker invocation", () => {
  const profiles = createProfiles();
  const binding = profiles.resolve("generated-code");
  const built = buildSandboxedCommand({
    boundary: binding,
    command: {
      executable: "/usr/local/bin/node",
      args: ["test.js"],
      cwd: "test",
      inheritEnv: [],
    },
    workspacePath: "C:\\safe\\workspace",
    cleanupCwd: "C:\\safe",
    relativeCwd: "test",
    identity: "attempt-setup-0",
  });

  expect(built.invocation.executable).toBe(process.execPath);
  for (const required of [
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "no-new-privileges=true",
    "--ipc",
  ]) {
    expect(built.invocation.args).toContain(required);
  }
  expect(built.invocation.args).not.toContain("--privileged");
  expect(built.invocation.args).not.toContain("--env");
  expect(built.invocation.args.at(-2)).toBe("/usr/local/bin/node");
  expect(built.invocation.cleanup?.args.slice(0, 2)).toEqual(["rm", "--force"]);
  expect(built.resource.resourceId).toBe(built.evidence.containerName);
});

test("external jobs require a configured profile, container command allowlist, and file-only host worker", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-sandbox-"));
  const store = new ArtifactStore(dataRoot);
  const profiles = createProfiles();
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new SandboxFixtureAdapter("file-edit-only")]),
    undefined,
    profiles,
  );

  try {
    const contract = await conductor.prepareJob({
      objective: "Write code, then execute only its bounded container check",
      repositoryPath: repository.root,
      adapterId: "sandbox-fixture",
      idempotencyKey: "sandbox-contract",
      executionBoundary: {
        kind: "external-sandbox",
        profileId: "generated-code",
      },
      acceptanceCommands: [
        {
          executable: "/usr/local/bin/node",
          args: ["test.js"],
        },
      ],
    });
    expect(contract.execution.boundary).toMatchObject({
      kind: "external-sandbox",
      profileId: "generated-code",
      image: `example.invalid/conductor-test@sha256:${digest}`,
      network: "none",
      readOnlyRoot: true,
    });

    await expect(
      conductor.prepareJob({
        objective: "Attempt an unlisted container executable",
        repositoryPath: repository.root,
        adapterId: "sandbox-fixture",
        idempotencyKey: "sandbox-denied-command",
        executionBoundary: {
          kind: "external-sandbox",
          profileId: "generated-code",
        },
        acceptanceCommands: [{ executable: "/bin/sh", args: [] }],
      }),
    ).rejects.toThrow("not allowed by sandbox profile");

    const commandCapable = new Conductor(
      store,
      new GitWorkspaceManager(store.workspaceRoot()),
      new WorkerRegistry([new SandboxFixtureAdapter("command-capable")]),
      undefined,
      profiles,
    );
    await expect(
      commandCapable.prepareJob({
        objective: "Attempt host command-capable worker",
        repositoryPath: repository.root,
        adapterId: "sandbox-fixture",
        idempotencyKey: "sandbox-denied-worker",
        executionBoundary: {
          kind: "external-sandbox",
          profileId: "generated-code",
        },
      }),
    ).rejects.toThrow("file-edit-only host adapter");
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("orphan recovery releases every recorded external resource before retry", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-sandbox-recovery-"),
  );
  const cleanupCanary = path.join(dataRoot, "resource-released.txt");
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new SandboxFixtureAdapter("file-edit-only")]),
  );

  try {
    const contract = await conductor.prepareJob({
      objective: "Reserve an interrupted attempt",
      repositoryPath: repository.root,
      adapterId: "sandbox-fixture",
      idempotencyKey: "sandbox-recovery",
    });
    const reserved = await conductor.reservePreparedAttempt(contract.jobId);
    const manifest = await conductor.getAttempt(reserved.attemptId);
    const claimed = await claimAttemptForTest(store, manifest);
    const preparing = await store.transitionAttempt(claimed, {
      status: "preparing",
    });
    await store.transitionAttempt(preparing, {
      status: "running",
      guardian: {
        schema: "conductor.process-guardian/v1",
        nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        guardianPid: 999_999_999,
        parentPid: process.pid,
        createdAt: new Date().toISOString(),
      },
      externalResources: [
        {
          schema: "conductor.external-resource/v1",
          resourceId: "conductor-recovery-canary",
          driver: "docker",
          profileId: "test",
          profileFingerprint: "b".repeat(64),
          image: `example.invalid/test@sha256:${digest}`,
          status: "active",
          registeredAt: new Date().toISOString(),
          cleanup: {
            executable: process.execPath,
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(cleanupCanary)}, "released")`,
            ],
            cwd: dataRoot,
          },
        },
      ],
    });

    const recovery = await conductor.recoverInterruptedAttempt(
      reserved.attemptId,
      0,
    );
    expect(recovery.disposition).toBe("safe-to-retry");
    expect(recovery.manifest.externalResources[0]?.status).toBe("released");
    expect(await exists(cleanupCanary)).toBe(true);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("manual retry releases durable resources and fails closed when cleanup fails", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-retry-"));
  const cleanupCanary = path.join(dataRoot, "retry-resource-released.txt");
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new SandboxFixtureAdapter("file-edit-only")]),
  );
  const queue = new QueueStore(store);
  const dispatcher = new DurableDispatcher(conductor, queue, {
    pollIntervalMs: 25,
    leaseMs: 1_000,
    ownerId: "sandbox-retry-test",
  });

  try {
    const first = await dispatcher.enqueue({
      objective: "Retry after releasing an external resource",
      repositoryPath: repository.root,
      adapterId: "sandbox-fixture",
      idempotencyKey: "sandbox-manual-retry",
    });
    const reserved = await conductor.reservePreparedAttempt(first.item.jobId);
    const manifest = await conductor.getAttempt(reserved.attemptId);
    const claimed = await claimAttemptForTest(store, manifest);
    await store.transitionAttempt(claimed, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      verificationStatus: "ineligible",
      externalResources: [
        resource(
          "conductor-retry-canary",
          process.execPath,
          [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(cleanupCanary)}, "released")`,
          ],
          dataRoot,
        ),
      ],
    });
    const firstDispatching = await queue.update(first.item, {
      status: "dispatching",
      dispatchOperationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    const firstRunning = await queue.update(firstDispatching, {
      status: "running",
      attemptId: reserved.attemptId,
    });
    await queue.update(firstRunning, {
      status: "failed",
    });

    const retried = await dispatcher.retry(first.item.jobId);
    expect(retried.status).toBe("queued");
    expect(retried.attemptId).toBeUndefined();
    expect(await exists(cleanupCanary)).toBe(true);
    expect(
      (await conductor.getAttempt(reserved.attemptId)).externalResources[0]
        ?.status,
    ).toBe("released");

    const second = await dispatcher.enqueue({
      objective: "Refuse retry when external cleanup fails",
      repositoryPath: repository.root,
      adapterId: "sandbox-fixture",
      idempotencyKey: "sandbox-failed-cleanup",
    });
    const secondReserved = await conductor.reservePreparedAttempt(
      second.item.jobId,
    );
    const secondManifest = await conductor.getAttempt(secondReserved.attemptId);
    const secondClaimed = await claimAttemptForTest(store, secondManifest);
    await store.transitionAttempt(secondClaimed, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      verificationStatus: "ineligible",
      externalResources: [
        resource(
          "conductor-failed-cleanup",
          process.execPath,
          ["-e", "process.stderr.write('cleanup denied'); process.exit(7)"],
          dataRoot,
        ),
      ],
    });
    const secondDispatching = await queue.update(second.item, {
      status: "dispatching",
      dispatchOperationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    const secondRunning = await queue.update(secondDispatching, {
      status: "running",
      attemptId: secondReserved.attemptId,
    });
    await queue.update(secondRunning, {
      status: "failed",
    });

    await expect(dispatcher.retry(second.item.jobId)).rejects.toThrow(
      "still owns an external resource; retry or workspace removal is prohibited",
    );
    await expect(
      conductor.removeAttemptWorkspace(secondReserved.attemptId),
    ).rejects.toThrow(
      "still owns an external resource; retry or workspace removal is prohibited",
    );
    expect((await queue.read(second.item.jobId)).status).toBe("failed");
    expect(
      (await conductor.getAttempt(secondReserved.attemptId))
        .externalResources[0]?.status,
    ).toBe("active");
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("automatic workspace cleanup retains evidence when external cleanup is unproven", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-sandbox-retain-"),
  );
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new SandboxFixtureAdapter("file-edit-only")]),
    undefined,
    createProfiles(),
  );

  try {
    const result = await runTestJob(conductor, {
      objective: "Retain the worktree if named-resource cleanup cannot finish",
      repositoryPath: repository.root,
      adapterId: "sandbox-fixture",
      idempotencyKey: "sandbox-retain-on-cleanup-failure",
      retainWorkspace: false,
      executionBoundary: {
        kind: "external-sandbox",
        profileId: "generated-code",
      },
      setupCommands: [
        { executable: "/usr/local/bin/node", args: ["fixture.js"] },
      ],
    });
    const manifest = await conductor.getAttempt(result.attemptId);
    expect(result.status).toBe("failed");
    expect(manifest.workspace?.retained).toBe(true);
    expect(manifest.externalResources[0]?.status).toBe("active");
    expect(manifest.cleanupError).toContain(
      "External resource cleanup failed; its worktree must remain available",
    );
    expect(await exists(manifest.workspace!.path)).toBe(true);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function claimAttemptForTest(
  store: ArtifactStore,
  manifest: AttemptManifest,
): Promise<AttemptManifest> {
  return store.transitionAttempt(manifest, {
    status: "claimed",
    dispatchOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    launchOwner: {
      instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      processId: process.pid,
      claimedAt: new Date().toISOString(),
    },
  });
}

class SandboxFixtureAdapter implements WorkerAdapter {
  readonly description;

  constructor(hostExecution: "file-edit-only" | "command-capable") {
    this.description = {
      id: "sandbox-fixture",
      label: "Sandbox fixture",
      executable: process.execPath,
      mutationMode: "worktree" as const,
      outputFormat: "jsonl" as const,
      safetyMode: "test-fixture",
      available: true,
      hostExecution,
    };
  }

  buildInvocation(_contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspacePath,
    };
  }
}

function createProfiles(): SandboxProfiles {
  return new SandboxProfiles(
    {
      schema: "conductor.sandbox-profiles/v1",
      dockerExecutable: process.execPath,
      profiles: {
        "generated-code": {
          image: `example.invalid/conductor-test@sha256:${digest}`,
          minimumEngineVersion: "29.6.2",
          allowedExecutables: ["/usr/local/bin/node"],
          user: "65532:65532",
          memoryBytes: 268_435_456,
          cpus: 1,
          pidsLimit: 64,
          tmpfsBytes: 67_108_864,
        },
      },
    },
    async () => undefined,
  );
}

function resource(
  resourceId: string,
  executable: string,
  args: string[],
  cwd: string,
) {
  return {
    schema: "conductor.external-resource/v1" as const,
    resourceId,
    driver: "docker" as const,
    profileId: "test",
    profileFingerprint: "b".repeat(64),
    image: `example.invalid/test@sha256:${digest}`,
    status: "active" as const,
    registeredAt: new Date().toISOString(),
    cleanup: { executable, args, cwd },
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
