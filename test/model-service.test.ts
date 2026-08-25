import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  modelServiceProfileFileSchema,
  type ModelServiceProfileFile,
} from "../src/contracts/model-service.js";
import { ModelServiceManager } from "../src/model-service/manager.js";
import {
  launchOwnedModelProcess,
  type OwnedModelProcess,
} from "../src/model-service/owned-process.js";
import type { ProcessResult } from "../src/runtime/process-runner.js";

const profileFile: ModelServiceProfileFile =
  modelServiceProfileFileSchema.parse({
    schema: "conductor.model-service-profiles/v1",
    profiles: {
      qwen: {
        schema: "conductor.model-service-profile/v1",
        profileId: "qwen",
        endpoint: { host: "127.0.0.1", port: 7332, basePath: "/" },
        expected: {
          model: "Qwen3.8-27B-NVFP4-MTP-MEDIUM",
          context: 262144,
          contextSource: { kind: "probe", path: "/slots", field: "0.n_ctx" },
        },
        launch: {
          executable: process.execPath,
          args: ["fake-model-service.js"],
        },
        readiness: {
          startupTimeoutMs: 2_000,
          probeIntervalMs: 100,
          requestTimeoutMs: 500,
        },
        stopTimeoutMs: 2_000,
      },
    },
  });

function offlineError(): Error {
  return Object.assign(new Error("offline"), { code: "ECONNREFUSED" });
}

test("owned process rejects when the guardian never spawns a worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-model-spawn-"));
  try {
    const launch = launchOwnedModelProcess({
      executable: path.join(root, "missing-model-service.exe"),
      args: [],
      cwd: root,
      artifactDirectory: root,
    });
    const result = await Promise.race([
      launch.then(
        () => "resolved",
        () => "rejected",
      ),
      Bun.sleep(5_000).then(() => "timed-out"),
    ]);
    expect(result).toBe("rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model manager fences concurrent starts and stops only its guardian handle", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "conductor-model-manager-"),
  );
  let online = false;
  let alive = false;
  let slotBusy = false;
  let spawnCount = 0;
  let finish!: (result: ProcessResult) => void;
  const completion = new Promise<ProcessResult>((resolve) => {
    finish = resolve;
  });
  const stopped: ProcessResult = {
    pid: 43210,
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: true,
    durationMs: 1,
    termination: {
      schema: "conductor.process-termination/v1",
      status: "proven",
      method: "windows-job-terminate-and-empty",
      observedAt: new Date().toISOString(),
    },
  };
  const handle: OwnedModelProcess = {
    pid: 43210,
    guardian: {
      schema: "conductor.process-guardian/v2",
      nonce: "73f29370-5c35-4fbe-a3d8-277bf45b46f5",
      guardianPid: 43209,
      parentPid: process.pid,
      createdAt: new Date().toISOString(),
      containment: {
        schema: "conductor.process-containment/v1",
        kind: "windows-job",
        ownerPid: 43209,
        kernelEnforced: true,
        killOnOwnerClose: true,
      },
    },
    completion,
    stop: async () => {
      alive = false;
      online = false;
      finish(stopped);
      return completion;
    },
  };
  const manager = new ModelServiceManager(root, profileFile, "qwen", {
    processAlive: () => alive,
    spawnOwnedProcess: async () => {
      spawnCount += 1;
      alive = true;
      online = true;
      return handle;
    },
    httpRequest: async (url) => {
      if (!online) throw offlineError();
      if (url.endsWith("/v1/models")) {
        return { data: [{ id: "Qwen3.8-27B-NVFP4-MTP-MEDIUM" }] };
      }
      return [{ n_ctx: 262144, is_processing: slotBusy }];
    },
  });

  try {
    const [left, right] = await Promise.all([
      manager.ensureReady(),
      manager.ensureReady(),
    ]);
    expect(left.state).toBe("ready");
    expect(right.state).toBe("ready");
    expect(spawnCount).toBe(1);
    expect(manager.state()?.ownership?.guardian.nonce).toBe(
      handle.guardian.nonce,
    );

    const observer = new ModelServiceManager(root, profileFile, "qwen", {
      processAlive: () => alive,
      spawnOwnedProcess: async () => {
        throw new Error("observer must not spawn");
      },
      httpRequest: async (url) =>
        url.endsWith("/v1/models")
          ? { data: [{ id: "Qwen3.8-27B-NVFP4-MTP-MEDIUM" }] }
          : [{ n_ctx: 262144, is_processing: false }],
    });
    const observed = await observer.ensureReady();
    expect(observed.ownership?.guardian.nonce).toBe(handle.guardian.nonce);
    expect((await observer.stop()).failure?.kind).toBe("stop-refused");

    slotBusy = true;
    const busy = await manager.stop();
    expect(busy.failure?.kind).toBe("stop-refused");
    expect(alive).toBeTrue();
    slotBusy = false;
    const offline = await manager.stop();
    expect(offline.state).toBe("offline");
    expect(offline.ownership).toBeUndefined();
    expect(offline.operation?.status).toBe("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disk fence permits one start across concurrent manager instances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-model-fence-"));
  let online = false;
  let alive = false;
  let spawnCount = 0;
  const completion = new Promise<ProcessResult>(() => undefined);
  const handle: OwnedModelProcess = {
    pid: 54321,
    guardian: {
      schema: "conductor.process-guardian/v2",
      nonce: "166a0971-fb67-4f52-9f16-e4493ad7705a",
      guardianPid: 54320,
      parentPid: process.pid,
      createdAt: new Date().toISOString(),
      containment: {
        schema: "conductor.process-containment/v1",
        kind: "windows-job",
        ownerPid: 54320,
        kernelEnforced: true,
        killOnOwnerClose: true,
      },
    },
    completion,
    stop: async () => completion,
  };
  const options = {
    processAlive: (pid: number) =>
      pid === process.pid || (pid === 54321 && alive),
    spawnOwnedProcess: async () => {
      spawnCount += 1;
      await Bun.sleep(100);
      alive = true;
      online = true;
      return handle;
    },
    httpRequest: async (url: string) => {
      if (!online) throw offlineError();
      return url.endsWith("/v1/models")
        ? { data: [{ id: "Qwen3.8-27B-NVFP4-MTP-MEDIUM" }] }
        : [{ n_ctx: 262144, is_processing: false }];
    },
  };
  const left = new ModelServiceManager(root, profileFile, "qwen", options);
  const right = new ModelServiceManager(root, profileFile, "qwen", options);
  try {
    const states = await Promise.all([left.ensureReady(), right.ensureReady()]);
    expect(states.every((state) => state.state === "ready")).toBeTrue();
    expect(spawnCount).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("matching external endpoint is ready but never grants stop authority", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "conductor-model-external-"),
  );
  const manager = new ModelServiceManager(root, profileFile, "qwen", {
    processAlive: () => true,
    httpRequest: async (url) =>
      url.endsWith("/v1/models")
        ? { data: [{ id: "Qwen3.8-27B-NVFP4-MTP-MEDIUM" }] }
        : [{ n_ctx: 262144, is_processing: false }],
  });
  try {
    expect((await manager.ensureReady()).state).toBe("ready");
    const refused = await manager.stop();
    expect(refused.state).toBe("error");
    expect(refused.failure?.kind).toBe("stop-refused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indeterminate endpoint failure never authorizes a start", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "conductor-model-indeterminate-"),
  );
  let spawned = false;
  const manager = new ModelServiceManager(root, profileFile, "qwen", {
    spawnOwnedProcess: async () => {
      spawned = true;
      throw new Error("must not spawn");
    },
    httpRequest: async () => {
      throw Object.assign(new Error("request timed out"), {
        code: "ETIMEDOUT",
      });
    },
  });
  try {
    const state = await manager.ensureReady();
    expect(state.state).toBe("error");
    expect(state.failure?.kind).toBe("probe-failed");
    expect(spawned).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wrong live model fails closed without spawning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-model-wrong-"));
  let spawned = false;
  const manager = new ModelServiceManager(root, profileFile, "qwen", {
    spawnOwnedProcess: async () => {
      spawned = true;
      throw new Error("must not spawn");
    },
    httpRequest: async () => ({ data: [{ id: "different-model" }] }),
  });
  try {
    const state = await manager.ensureReady();
    expect(state.state).toBe("wrong-model");
    expect(state.failure?.kind).toBe("wrong-model");
    expect(spawned).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
