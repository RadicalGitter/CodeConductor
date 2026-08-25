import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { modelServiceRecordSchema } from "../src/contracts/model-service.js";
import type { QueueItem } from "../src/contracts/queue.js";
import type { LeaseInspection } from "../src/contracts/reconcile.js";
import { DEFAULT_OWNER_RESOURCE_PROFILE } from "../src/contracts/resources.js";
import { startControlConsole } from "../src/control-console/server.js";
import type { SnapshotSources } from "../src/control-console/snapshot.js";
import { CONTROL_CONSOLE_JS } from "../src/control-console/ui.js";
import { resolveConsoleSettings } from "../src/model-service/settings-contract.js";
import type { ModelServiceManager } from "../src/model-service/manager.js";
import { ConsoleSettingsStore } from "../src/model-service/settings-store.js";
import type { DurableDispatcher } from "../src/queue/dispatcher.js";

function queueItem(): QueueItem {
  const now = new Date().toISOString();
  return {
    schema: "conductor.queue-item/v2",
    jobId: "job_test",
    status: "queued",
    revision: 7,
    priority: 0,
    dependsOnJobIds: [],
    createdAt: now,
    updatedAt: now,
    automaticRetryCount: 0,
  };
}

test("console is XSS-safe, streams snapshots, and fences stale mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-console-"));
  let item = queueItem();
  let cancelCalls = 0;
  const dispatcher = {
    get: async () => item,
    cancel: async () => {
      cancelCalls += 1;
      item = { ...item, revision: item.revision + 1, status: "cancelled" };
      return item;
    },
    retry: async () => item,
  } as unknown as DurableDispatcher;
  const settingsStore = new ConsoleSettingsStore(root);
  const wrongModelRecord = modelServiceRecordSchema.parse({
    schema: "conductor.model-service/v2",
    profileId: "qwen",
    profileFingerprint: "0".repeat(64),
    state: "wrong-model",
    expected: { model: "expected", context: 262144 },
    observed: {
      reachable: true,
      model: "other",
      observedAt: new Date().toISOString(),
    },
    failure: { kind: "wrong-model", message: "Wrong live model" },
    revision: 0,
    updatedAt: new Date().toISOString(),
  });
  const modelService = {
    initialize: async () => wrongModelRecord,
    observe: async () => wrongModelRecord,
    state: () => wrongModelRecord,
    canUnload: () => false,
    ensureReady: async () => wrongModelRecord,
    stop: async () => wrongModelRecord,
  } as unknown as ModelServiceManager;
  const sources: SnapshotSources = {
    queueItems: async () => [item],
    attemptLookup: async () => undefined,
    objectiveLookup: async () =>
      '\"><img src=x onerror="globalThis.__injected=true">',
    leaseInspection: async () =>
      ({
        schema: "conductor.lease-inspection/v1",
        state: "absent",
        detail: "No dispatcher lease",
      }) as LeaseInspection,
    modelState: () => wrongModelRecord,
    modelCanUnload: () => false,
    settings: () => settingsStore.read(),
    effectiveSettings: (document) => resolveConsoleSettings(document, {}),
    dispatcher: {
      maxConcurrent: 1,
      pollIntervalMs: 2_000,
      leaseMs: 30_000,
      ownerId: "test-owner",
      controlAuthority: true,
    },
    resourceProfile: DEFAULT_OWNER_RESOURCE_PROFILE,
    availableModelProfiles: ["qwen"],
  };
  const consoleHost = await startControlConsole(
    {
      dispatcher,
      modelService,
      settingsStore,
      snapshotSources: sources,
      queueControlAuthority: true,
    },
    { host: "127.0.0.1", port: 0, eventIntervalMs: 50 },
  );

  try {
    const page = await fetch(consoleHost.queueUrl);
    const html = await page.text();
    expect(page.headers.get("content-security-policy")).not.toContain(
      "unsafe-inline",
    );
    expect(html).not.toContain("onerror");
    expect(CONTROL_CONSOLE_JS).not.toContain("innerHTML");
    expect(CONTROL_CONSOLE_JS).toContain("textContent");
    expect(CONTROL_CONSOLE_JS).toContain("settingsDirty = true");
    expect(CONTROL_CONSOLE_JS).toContain("if (!state.settingsDirty)");

    const snapshot = await fetch(`${consoleHost.url}/api/v1/snapshot`).then(
      (response) => response.json() as Promise<Record<string, any>>,
    );
    expect(snapshot.queue.items[0].objective).toContain("onerror");

    const streamAbort = new AbortController();
    const streamResponse = await fetch(`${consoleHost.url}/api/v1/events`, {
      signal: streamAbort.signal,
    });
    const firstChunk = await streamResponse.body!.getReader().read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain(
      "event: snapshot",
    );
    streamAbort.abort();

    const session = await fetch(`${consoleHost.url}/api/v1/session`).then(
      (response) => response.json() as Promise<{ csrfToken: string }>,
    );
    const failedLoad = await fetch(`${consoleHost.url}/api/v1/model/load`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: consoleHost.url },
      body: JSON.stringify({
        expectedRevision: wrongModelRecord.revision,
        csrfToken: session.csrfToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(failedLoad.status).toBe(409);
    expect(((await failedLoad.json()) as { error: string }).error).toContain(
      "Wrong live model",
    );

    const settingsPayload = {
      expectedRevision: 0,
      settings: {
        console: { host: "127.0.0.1", port: 8788 },
        dispatcherConcurrency: 2,
        modelServiceId: "qwen",
        includeModelState: true,
      },
      csrfToken: session.csrfToken,
      idempotencyKey: crypto.randomUUID(),
    };
    const savedSettings = await fetch(`${consoleHost.url}/api/v1/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: consoleHost.url },
      body: JSON.stringify(settingsPayload),
    });
    expect(savedSettings.status).toBe(200);
    expect((await settingsStore.read())?.revision).toBe(1);
    const staleSettings = await fetch(`${consoleHost.url}/api/v1/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: consoleHost.url },
      body: JSON.stringify({
        ...settingsPayload,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(staleSettings.status).toBe(409);

    const foreign = await fetch(`${consoleHost.url}/api/v1/queue/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.invalid",
      },
      body: JSON.stringify({
        jobId: item.jobId,
        expectedRevision: item.revision,
        csrfToken: session.csrfToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(foreign.status).toBe(403);

    const staleBody = {
      jobId: item.jobId,
      expectedRevision: 6,
      csrfToken: session.csrfToken,
      idempotencyKey: crypto.randomUUID(),
    };
    const stale = await fetch(`${consoleHost.url}/api/v1/queue/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: consoleHost.url },
      body: JSON.stringify(staleBody),
    });
    expect(stale.status).toBe(409);
    expect(cancelCalls).toBe(0);

    const idempotencyKey = crypto.randomUUID();
    const validBody = {
      jobId: item.jobId,
      expectedRevision: 7,
      csrfToken: session.csrfToken,
      idempotencyKey,
    };
    const valid = await fetch(`${consoleHost.url}/api/v1/queue/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: consoleHost.url },
      body: JSON.stringify(validBody),
    });
    expect(valid.status).toBe(200);
    const replay = await fetch(`${consoleHost.url}/api/v1/queue/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: consoleHost.url },
      body: JSON.stringify(validBody),
    });
    expect(replay.status).toBe(200);
    expect(cancelCalls).toBe(1);
    const conflictingReplay = await fetch(
      `${consoleHost.url}/api/v1/queue/retry`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: consoleHost.url,
        },
        body: JSON.stringify({
          ...validBody,
          expectedRevision: item.revision,
        }),
      },
    );
    expect(conflictingReplay.status).toBe(409);
  } finally {
    await consoleHost.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("console shutdown drains active SSE clients", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "conductor-console-close-"),
  );
  const settingsStore = new ConsoleSettingsStore(root);
  const dispatcher = {} as DurableDispatcher;
  const sources: SnapshotSources = {
    queueItems: async () => [],
    attemptLookup: async () => undefined,
    objectiveLookup: async () => undefined,
    leaseInspection: async () =>
      ({
        schema: "conductor.lease-inspection/v1",
        state: "absent",
        detail: "No dispatcher lease",
      }) as LeaseInspection,
    modelState: () => undefined,
    modelCanUnload: () => false,
    settings: () => settingsStore.read(),
    effectiveSettings: (document) => resolveConsoleSettings(document, {}),
    dispatcher: {
      maxConcurrent: 1,
      pollIntervalMs: 2_000,
      leaseMs: 30_000,
      ownerId: "test-owner",
      controlAuthority: false,
    },
    resourceProfile: DEFAULT_OWNER_RESOURCE_PROFILE,
    availableModelProfiles: [],
  };
  const consoleHost = await startControlConsole(
    { dispatcher, settingsStore, snapshotSources: sources },
    { host: "127.0.0.1", port: 0, eventIntervalMs: 50 },
  );
  const abort = new AbortController();
  try {
    const response = await fetch(`${consoleHost.url}/api/v1/events`, {
      signal: abort.signal,
    });
    await response.body!.getReader().read();
    const close = consoleHost.close();
    const closedPromptly = await Promise.race([
      close.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    expect(closedPromptly).toBeTrue();
    if (!closedPromptly) {
      abort.abort();
      await close;
    }
  } finally {
    abort.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("tray state mapper runs without creating a notification icon", () => {
  if (process.platform !== "win32") return;
  const result = Bun.spawnSync({
    cmd: [
      "pwsh",
      "-NoProfile",
      "-File",
      "scripts/conductor-tray.ps1",
      "-StateMap",
      "-SnapshotJson",
      JSON.stringify({
        queue: { items: [{ status: "running" }] },
        model: { state: "ready", managerOwned: true, canUnload: true },
      }),
    ],
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const state = JSON.parse(result.stdout.toString()) as {
    CanUnload: boolean;
    Status: string;
  };
  expect(state.CanUnload).toBeTrue();
  expect(state.Status).toContain("1 active");
});
