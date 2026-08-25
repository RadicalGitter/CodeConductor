#!/usr/bin/env bun

import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createControlConsoleRuntime,
  startConsoleFromRuntime,
} from "./control-console/runtime.js";
import { buildAgentRuntimeProjection } from "./control-console/snapshot.js";
import {
  createConductorRuntimeFromEnvironment,
  resolveConductorDataRoot,
} from "./mcp/runtime.js";
import { createMcpServer } from "./mcp/server.js";
import { resolveConsoleSettings } from "./model-service/settings-contract.js";
import { ConsoleSettingsStore } from "./model-service/settings-store.js";

const consoleOnly = process.argv[2] === "console";
const dataRoot = resolveConductorDataRoot();
const bootstrapSettings = resolveConsoleSettings(
  await new ConsoleSettingsStore(
    dataRoot,
    path.join(dataRoot, "control-console", "console-settings.json"),
  ).read(),
);
const runtime = createConductorRuntimeFromEnvironment({
  maxConcurrent:
    process.env.CONDUCTOR_MAX_CONCURRENT === undefined
      ? bootstrapSettings.settings.dispatcherConcurrency
      : undefined,
});
const { conductor, queue, dispatcher, sources, poller, reconciler } = runtime;
await conductor.store.initialize();
await queue.initialize();
const controlRuntime = await createControlConsoleRuntime(
  conductor,
  dispatcher,
  queue,
  {
    conductorRoot: runtime.dataRoot,
    queueControlAuthority: !consoleOnly,
  },
);
await controlRuntime.modelService?.initialize();

if (consoleOnly) {
  const consoleHost = await startConsoleFromRuntime(controlRuntime, dispatcher);
  process.stdout.write(
    `${JSON.stringify({
      schema: "conductor.control-console-start/v1",
      url: consoleHost.url,
      queueUrl: consoleHost.queueUrl,
      settingsUrl: consoleHost.settingsUrl,
      processId: process.pid,
    })}\n`,
  );
  await waitForSignal(() => consoleHost.close());
} else {
  await dispatcher.start();
  await poller.start();
  const consoleHost = await startConsoleFromRuntime(
    controlRuntime,
    dispatcher,
  ).catch((error: unknown) => {
    if (isAddressInUse(error)) return undefined;
    throw error;
  });
  const server = createMcpServer(
    conductor,
    dispatcher,
    sources,
    poller,
    reconciler,
    () => buildAgentRuntimeProjection(controlRuntime.snapshotSources),
  );
  await server.connect(new StdioServerTransport());
  await waitForSignal(async () => {
    await consoleHost?.close();
    await poller.stop();
    await dispatcher.stop();
    await server.close();
  }, true);
}

function isAddressInUse(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor; depth += 1) {
    if (
      typeof cursor === "object" &&
      "code" in cursor &&
      cursor.code === "EADDRINUSE"
    ) {
      return true;
    }
    cursor =
      typeof cursor === "object" && "cause" in cursor
        ? cursor.cause
        : undefined;
  }
  return false;
}

function waitForSignal(
  close: () => Promise<void>,
  closeOnStdin = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let closing = false;
    const finish = (): void => {
      if (closing) return;
      closing = true;
      void close().then(resolve, reject);
    };
    if (closeOnStdin) process.stdin.once("end", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
