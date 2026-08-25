import { createHash } from "node:crypto";

import type { AttemptStatus } from "../contracts/attempt.js";
import type { ModelServiceRecord } from "../contracts/model-service.js";
import type { QueueItem } from "../contracts/queue.js";
import type { LeaseInspection } from "../contracts/reconcile.js";
import type { OwnerResourceProfile } from "../contracts/resources.js";
import { CONDUCTOR_VERSION } from "../index.js";
import type {
  ConsoleSettingsDocument,
  EffectiveConsoleSettings,
} from "../model-service/settings-contract.js";

export interface AttemptSummary {
  status: AttemptStatus;
  startedAt?: string;
  finishedAt?: string;
}

export interface SnapshotSources {
  queueItems: () => Promise<QueueItem[]>;
  attemptLookup: (attemptId: string) => Promise<AttemptSummary | undefined>;
  objectiveLookup: (jobId: string) => Promise<string | undefined>;
  leaseInspection: () => Promise<LeaseInspection>;
  modelState: () => ModelServiceRecord | undefined;
  modelCanUnload: () => boolean;
  settings: () => Promise<ConsoleSettingsDocument | undefined>;
  effectiveSettings: (
    document: ConsoleSettingsDocument | undefined,
  ) => EffectiveConsoleSettings;
  dispatcher: {
    maxConcurrent: number;
    pollIntervalMs: number;
    leaseMs: number;
    ownerId: string;
    controlAuthority: boolean;
  };
  resourceProfile: OwnerResourceProfile;
  availableModelProfiles: string[];
}

export async function buildSnapshot(
  sources: SnapshotSources,
  now = new Date(),
) {
  const [items, lease, settingsDocument] = await Promise.all([
    sources.queueItems(),
    sources.leaseInspection(),
    sources.settings(),
  ]);
  const effective = sources.effectiveSettings(settingsDocument);
  const rows = await Promise.all(
    items.map(async (item) => {
      const [attempt, objective] = await Promise.all([
        item.attemptId
          ? sources.attemptLookup(item.attemptId)
          : Promise.resolve(undefined),
        sources.objectiveLookup(item.jobId),
      ]);
      return projectQueueRow(item, attempt, objective, now);
    }),
  );
  const body = {
    queue: { items: rows, lease },
    model:
      effective.settings.includeModelState === false
        ? null
        : projectModelState(sources.modelState(), sources.modelCanUnload()),
    settings: {
      effective: effective.settings,
      revision: effective.revision,
      provenance: effective.provenance,
    },
    runtime: {
      conductorVersion: CONDUCTOR_VERSION,
      dispatcher: sources.dispatcher,
      resourceProfile: sources.resourceProfile,
      availableModelProfiles: [...sources.availableModelProfiles].sort(),
      policies: {
        attemptDeadline:
          sources.resourceProfile.limits.attemptTimeoutMs === undefined
            ? "none"
            : sources.resourceProfile.limits.attemptTimeoutMs,
        kodeTurnCap: process.env.CONDUCTOR_KODE_MAX_TURNS ?? "adapter-default",
        outputCapacity: "provider-context-derived",
      },
    },
  };
  return {
    schema: "conductor.control-console-snapshot/v1" as const,
    revision: createHash("sha256").update(canonicalJson(body)).digest("hex"),
    generatedAt: now.toISOString(),
    ...body,
  };
}

export async function buildAgentRuntimeProjection(sources: SnapshotSources) {
  const snapshot = await buildSnapshot(sources);
  return {
    schema: "conductor.agent-runtime-model-state/v1" as const,
    revision: snapshot.revision,
    model: snapshot.model,
    policy: snapshot.runtime.policies,
    resourceProfile: snapshot.runtime.resourceProfile,
    dispatcher: {
      maxConcurrent: snapshot.runtime.dispatcher.maxConcurrent,
      leaseState: snapshot.queue.lease.state,
    },
    settingsProvenance: snapshot.settings.provenance,
  };
}

function projectQueueRow(
  item: QueueItem,
  attempt: AttemptSummary | undefined,
  objective: string | undefined,
  now: Date,
) {
  return {
    schema: "conductor.console-queue-row/v1" as const,
    jobId: item.jobId,
    revision: item.revision,
    status: item.status,
    phase: derivePhase(item, attempt),
    objective: objective ?? item.jobId,
    attemptId: item.attemptId ?? null,
    attemptStatus: attempt?.status ?? null,
    updatedAt: item.updatedAt,
    message: item.message ?? null,
    lastActivityAt: attempt?.startedAt ?? item.updatedAt,
    activeElapsedMs: activeElapsedMs(item, attempt, now),
    automaticRetryCount: item.automaticRetryCount,
  };
}

function projectModelState(
  record: ModelServiceRecord | undefined,
  canUnload: boolean,
) {
  if (!record) return null;
  return {
    schema: "conductor.model-service-projection/v1" as const,
    profileId: record.profileId,
    state: record.state,
    expected: record.expected ?? null,
    observed: record.observed ?? null,
    managerOwned: record.ownership !== undefined,
    canUnload,
    revision: record.revision,
    updatedAt: record.updatedAt,
    failure: record.failure ?? null,
    operation: record.operation ?? null,
  };
}

function derivePhase(item: QueueItem, attempt: AttemptSummary | undefined) {
  if (item.status === "running") {
    return attempt?.status === "verifying" ? "verifying" : "worker";
  }
  if (["queued", "dispatching", "cancelling"].includes(item.status)) {
    return item.status;
  }
  return "terminal";
}

function activeElapsedMs(
  item: QueueItem,
  attempt: AttemptSummary | undefined,
  now: Date,
): number | null {
  if (!attempt?.startedAt) return null;
  const start = Date.parse(attempt.startedAt);
  const active = ["running", "cancelling"].includes(item.status);
  const end = active
    ? attempt.finishedAt
      ? Date.parse(attempt.finishedAt)
      : now.getTime()
    : Date.parse(attempt.finishedAt ?? item.updatedAt);
  const delta = end - start;
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
