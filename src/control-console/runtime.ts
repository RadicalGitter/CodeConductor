import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  modelServiceProfileFileSchema,
  type ModelServiceProfileFile,
} from "../contracts/model-service.js";
import {
  resolveConsoleSettings,
  type EffectiveConsoleSettings,
} from "../model-service/settings-contract.js";
import { ModelServiceManager } from "../model-service/manager.js";
import { ConsoleSettingsStore } from "../model-service/settings-store.js";
import type { Conductor } from "../orchestrator/conductor.js";
import type { DurableDispatcher } from "../queue/dispatcher.js";
import type { QueueStore } from "../queue/queue-store.js";
import { startControlConsole, type ControlConsole } from "./server.js";
import type { AttemptSummary, SnapshotSources } from "./snapshot.js";

export interface ControlConsoleRuntime {
  modelService?: ModelServiceManager;
  settingsStore: ConsoleSettingsStore;
  snapshotSources: SnapshotSources;
  modelProfileFile?: ModelServiceProfileFile;
  effectiveSettings(): Promise<EffectiveConsoleSettings>;
}

export interface ControlConsoleRuntimeOptions {
  conductorRoot: string;
  environment?: NodeJS.ProcessEnv;
  modelProfileFile?: string;
  queueControlAuthority?: boolean;
}

export async function createControlConsoleRuntime(
  conductor: Conductor,
  dispatcher: DurableDispatcher,
  queue: QueueStore,
  options: ControlConsoleRuntimeOptions,
): Promise<ControlConsoleRuntime> {
  const environment = options.environment ?? process.env;
  const settingsStore = new ConsoleSettingsStore(
    options.conductorRoot,
    path.join(
      options.conductorRoot,
      "control-console",
      "console-settings.json",
    ),
  );
  const modelProfileFile = await readModelProfiles(
    options.modelProfileFile ??
      environment.CONDUCTOR_MODEL_SERVICE_PROFILES_FILE ??
      path.join(os.homedir(), ".conductor", "model-service-profiles.json"),
  );
  const effectiveSettings = async (): Promise<EffectiveConsoleSettings> =>
    resolveConsoleSettings(await settingsStore.read(), environment);
  const selectedProfile =
    environment.CONDUCTOR_MODEL_SERVICE_ID ??
    (await effectiveSettings()).settings.modelServiceId ??
    Object.keys(modelProfileFile?.profiles ?? {})[0];
  const modelService = modelProfileFile
    ? new ModelServiceManager(
        path.join(options.conductorRoot, "control-console", "model-service"),
        modelProfileFile,
        selectedProfile,
        {
          inUse: async () =>
            (await queue.list()).some((item) =>
              ["dispatching", "running", "cancelling"].includes(item.status),
            ),
        },
      )
    : undefined;

  const snapshotSources: SnapshotSources = {
    queueItems: () => queue.list(),
    attemptLookup: (attemptId: string) =>
      conductor
        .getAttempt(attemptId)
        .then((manifest): AttemptSummary => ({
          status: manifest.status,
          startedAt: manifest.startedAt,
          finishedAt: manifest.finishedAt,
        }))
        .catch(() => undefined),
    objectiveLookup: (jobId: string) =>
      conductor.store
        .readJob(jobId)
        .then((contract) => contract.objective)
        .catch(() => undefined),
    leaseInspection: () => queue.inspectLease(dispatcher.leaseMs),
    modelState: () => modelService?.state(),
    modelCanUnload: () => modelService?.canUnload() ?? false,
    settings: () => settingsStore.read(),
    effectiveSettings: (document) =>
      resolveConsoleSettings(document, environment),
    dispatcher: {
      maxConcurrent: dispatcher.maxConcurrent,
      pollIntervalMs: dispatcher.pollIntervalMs,
      leaseMs: dispatcher.leaseMs,
      ownerId: dispatcher.ownerId,
      controlAuthority: options.queueControlAuthority ?? false,
    },
    resourceProfile: conductor.resourceProfile,
    availableModelProfiles: Object.keys(modelProfileFile?.profiles ?? {}),
  };

  return {
    modelService,
    settingsStore,
    snapshotSources,
    modelProfileFile,
    effectiveSettings,
  };
}

export async function startConsoleFromRuntime(
  runtime: ControlConsoleRuntime,
  dispatcher: DurableDispatcher,
): Promise<ControlConsole> {
  const effective = await runtime.effectiveSettings();
  return startControlConsole(
    {
      dispatcher,
      modelService: runtime.modelService,
      settingsStore: runtime.settingsStore,
      snapshotSources: runtime.snapshotSources,
      queueControlAuthority:
        runtime.snapshotSources.dispatcher.controlAuthority,
    },
    effective.settings.console,
  );
}

async function readModelProfiles(
  filePath: string,
): Promise<ModelServiceProfileFile | undefined> {
  try {
    return modelServiceProfileFileSchema.parse(
      JSON.parse(await readFile(filePath, "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(
      `Model-service profiles are unreadable and are never guessed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
