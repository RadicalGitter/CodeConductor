import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  fingerprintModelServiceLaunch,
  fingerprintModelServiceProfile,
  modelServiceRecordSchema,
  type ModelServiceProfile,
  type ModelServiceProfileFile,
  type ModelServiceRecord,
} from "../contracts/model-service.js";
import { isProcessAlive } from "../runtime/process-runner.js";
import {
  launchOwnedModelProcess,
  type OwnedModelProcess,
  type OwnedModelProcessInput,
} from "./owned-process.js";

interface ProbeResult {
  reachable: boolean;
  offline: boolean;
  ready: boolean;
  model?: string;
  context?: number;
  detail?: string;
}

interface StartFence {
  schema: "conductor.model-service-start-fence/v2";
  instanceId: string;
  ownerPid: number;
  createdAt: string;
}

export interface ModelServiceManagerOptions {
  spawnOwnedProcess?: (
    input: OwnedModelProcessInput,
  ) => Promise<OwnedModelProcess>;
  httpRequest?: (url: string, timeoutMs: number) => Promise<unknown>;
  processAlive?: (pid: number) => boolean;
  inUse?: () => boolean | Promise<boolean>;
  now?: () => Date;
}

/**
 * Owns one local model endpoint. A process is stoppable only while this exact
 * manager instance retains its guardian-backed in-memory handle. Durable PIDs
 * are evidence for reconciliation, never transferable kill authority.
 */
export class ModelServiceManager {
  private readonly root: string;
  private readonly instanceId = randomUUID();
  private readonly spawnOwnedProcess: NonNullable<
    ModelServiceManagerOptions["spawnOwnedProcess"]
  >;
  private readonly httpRequest: NonNullable<
    ModelServiceManagerOptions["httpRequest"]
  >;
  private readonly processAlive: NonNullable<
    ModelServiceManagerOptions["processAlive"]
  >;
  private readonly inUse: NonNullable<ModelServiceManagerOptions["inUse"]>;
  private readonly now: () => Date;
  private profile: ModelServiceProfile | undefined;
  private profileFingerprint: string;
  private record: ModelServiceRecord | undefined;
  private ownedProcess: OwnedModelProcess | undefined;
  private startOperation: Promise<ModelServiceRecord> | undefined;
  private transitionTail: Promise<void> = Promise.resolve();
  private foreignOwnershipBlocked = false;

  constructor(
    root: string,
    profileFile: ModelServiceProfileFile | undefined,
    profileId: string | undefined,
    options: ModelServiceManagerOptions = {},
  ) {
    this.root = path.resolve(root);
    this.profile = profileId ? profileFile?.profiles[profileId] : undefined;
    this.profileFingerprint = this.profile
      ? fingerprintModelServiceProfile(this.profile)
      : "0".repeat(64);
    this.spawnOwnedProcess =
      options.spawnOwnedProcess ?? launchOwnedModelProcess;
    this.httpRequest = options.httpRequest ?? defaultHttpJson;
    this.processAlive = options.processAlive ?? isProcessAlive;
    this.inUse = options.inUse ?? (() => false);
    this.now = options.now ?? (() => new Date());
  }

  get profileId(): string | undefined {
    return this.profile?.profileId;
  }

  state(): ModelServiceRecord | undefined {
    return this.record;
  }

  canUnload(): boolean {
    const ownership = this.record?.ownership;
    const handle = this.ownedProcess;
    return !!(
      ownership &&
      handle &&
      ownership.instanceId === this.instanceId &&
      ownership.workerPid === handle.pid &&
      ownership.guardian.nonce === handle.guardian.nonce
    );
  }

  async initialize(): Promise<ModelServiceRecord> {
    await ensureDirectory(this.root);
    if (this.record) return this.record;
    let created = false;
    try {
      this.record = modelServiceRecordSchema.parse(
        JSON.parse(await readFile(this.recordPath(), "utf8")),
      );
    } catch (error) {
      if (!isMissing(error)) {
        throw new Error(
          `Model-service state is unreadable and is never guessed: ${errorMessage(error)}`,
        );
      }
      this.record = this.blankRecord();
      created = true;
    }
    const reconciled = await this.reconcilePreviousOwner();
    if (created || reconciled) await this.persist();
    return this.record;
  }

  async observe(): Promise<ModelServiceRecord> {
    return this.serializeTransition(() => this.observeTransition());
  }

  private async observeTransition(): Promise<ModelServiceRecord> {
    await this.initialize();
    if (!this.profile) {
      return this.localFailure(
        "unconfigured",
        "No model-service profile is configured",
      );
    }
    if (this.foreignOwnershipBlocked) {
      return this.localFailure(
        "stale-owner",
        "A live model process belongs to a different launch profile; no transition authority is assumed",
      );
    }
    const probe = await this.probe();
    if (probe.ready) return this.observeReady(probe);
    if (probe.reachable) return this.observeMismatch(probe);
    if (!probe.offline || this.canUnload()) {
      return this.localFailure(
        "probe-failed",
        `Model endpoint state is indeterminate: ${probe.detail ?? "probe failed"}`,
      );
    }
    if (!this.record) throw new Error("Model-service state is not initialized");
    this.record = modelServiceRecordSchema.parse({
      ...this.record,
      state: "offline",
      observed: undefined,
      failure: undefined,
      updatedAt: this.timestamp(),
    });
    return this.record;
  }

  async ensureReady(): Promise<ModelServiceRecord> {
    return this.serializeTransition(() => this.ensureReadyTransition());
  }

  private async ensureReadyTransition(): Promise<ModelServiceRecord> {
    await this.initialize();
    if (!this.profile) {
      return this.fail(
        "unconfigured",
        "No model-service profile is configured",
      );
    }
    if (this.foreignOwnershipBlocked) {
      return this.localFailure(
        "stale-owner",
        "A live model process belongs to a different launch profile; no transition authority is assumed",
      );
    }
    const probe = await this.probe();
    if (probe.ready) return this.markReady(probe);
    if (probe.reachable) return this.markMismatch(probe);
    if (!probe.offline) {
      return this.fail(
        "probe-failed",
        `Model endpoint state is indeterminate; launch refused: ${probe.detail ?? "probe failed"}`,
      );
    }
    if (this.ownedProcess && this.processAlive(this.ownedProcess.pid)) {
      return this.waitForReadiness(this.ownedProcess, false);
    }
    if (!this.profile.launch) {
      return this.fail(
        "unconfigured",
        "The endpoint is offline and no owner launch profile is configured",
      );
    }
    this.startOperation ??= this.startOwnedService().finally(() => {
      this.startOperation = undefined;
    });
    return this.startOperation;
  }

  async stop(): Promise<ModelServiceRecord> {
    return this.serializeTransition(() => this.stopTransition());
  }

  private async stopTransition(): Promise<ModelServiceRecord> {
    await this.initialize();
    await this.refreshLatest();
    const handle = this.ownedProcess;
    const ownership = this.record?.ownership;
    if (
      !handle ||
      !ownership ||
      ownership.instanceId !== this.instanceId ||
      ownership.workerPid !== handle.pid ||
      ownership.guardian.nonce !== handle.guardian.nonce
    ) {
      return this.localStopRefusal(
        "Unload refused because this process does not retain exact guardian-backed ownership",
      );
    }
    if (await this.inUse()) {
      return this.localStopRefusal(
        "Unload refused while an active Conductor worker uses the model service",
      );
    }
    const slotUsage = await this.slotUsage();
    if (slotUsage !== "idle") {
      return this.localStopRefusal(
        slotUsage === "busy"
          ? "Unload refused while the model endpoint reports an active slot"
          : "Unload refused because model endpoint slot activity could not be verified",
      );
    }
    const operationId = randomUUID();
    this.record = this.advance({
      state: "stopping",
      operation: {
        operationId,
        kind: "stop",
        status: "requested",
        requestedAt: this.timestamp(),
      },
      failure: undefined,
    });
    await this.persist();
    const result = await this.stopWithTimeout(handle).catch(() => undefined);
    const proven =
      result?.termination.status === "proven" && !this.processAlive(handle.pid);
    if (!proven) {
      this.record = this.advance({
        state: "error",
        operation: {
          operationId,
          kind: "stop",
          status: "failed",
          requestedAt: this.record.operation!.requestedAt,
          finishedAt: this.timestamp(),
          detail:
            result?.termination.detail ??
            `Process ${handle.pid} closure was not proven within ${this.profile?.stopTimeoutMs}ms`,
        },
        failure: {
          kind: "stop-unverified",
          message: "The owned model process tree did not produce closure proof",
        },
      });
      await this.persist();
      return this.record;
    }
    this.ownedProcess = undefined;
    this.record = this.advance({
      state: "offline",
      ownership: undefined,
      stoppedAt: this.timestamp(),
      failure: undefined,
      operation: {
        operationId,
        kind: "stop",
        status: "completed",
        requestedAt: this.record.operation!.requestedAt,
        finishedAt: this.timestamp(),
        detail: "Guardian proved complete process-tree closure",
      },
    });
    await this.persist();
    return this.record;
  }

  private async startOwnedService(): Promise<ModelServiceRecord> {
    const profile = this.profile!;
    const launch = profile.launch!;
    const releaseFence = await this.acquireStartFence();
    if (!releaseFence) return this.waitForExternalStarter();
    const operationId = randomUUID();
    try {
      const launchEvidence = {
        fingerprint: fingerprintModelServiceLaunch(launch),
        files: await hashLaunchFiles(launch.executable, launch.args),
      };
      this.record = this.advance({
        state: "starting",
        launchEvidence,
        operation: {
          operationId,
          kind: "start",
          status: "requested",
          requestedAt: this.timestamp(),
        },
        failure: undefined,
      });
      await this.persist();
      const handle = await this.spawnOwnedProcess({
        executable: launch.executable,
        args: [...launch.args],
        cwd: launch.cwd,
        artifactDirectory: this.root,
      });
      this.ownedProcess = handle;
      this.record = this.advance({
        ownership: {
          instanceId: this.instanceId,
          ownerPid: process.pid,
          workerPid: handle.pid,
          guardian: handle.guardian,
          launchedAt: this.timestamp(),
        },
      });
      await this.persist();
      void this.observeUnexpectedExit(handle);
      return await this.waitForReadiness(handle, true);
    } catch (error) {
      if (this.record?.failure?.kind === "stop-unverified") {
        return this.record;
      }
      return this.failStart(operationId, error);
    } finally {
      await releaseFence();
    }
  }

  private async waitForReadiness(
    handle: OwnedModelProcess,
    stopOnFailure: boolean,
  ): Promise<ModelServiceRecord> {
    const profile = this.profile!;
    const deadline = Date.now() + profile.readiness.startupTimeoutMs;
    for (;;) {
      const probe = await this.probe();
      if (probe.ready) {
        this.record = this.advance({
          state: "ready",
          observed: observation(probe, this.timestamp()),
          readyAt: this.timestamp(),
          failure: undefined,
          operation: this.completeCurrentOperation("Model service is ready"),
        });
        await this.persist();
        return this.record;
      }
      if (probe.reachable) {
        if (stopOnFailure) await this.stopFailedStart(handle);
        return this.markMismatch(probe);
      }
      if (!this.processAlive(handle.pid)) {
        return this.fail(
          "spawn-failed",
          `Owned model process ${handle.pid} exited before readiness`,
        );
      }
      if (Date.now() >= deadline) {
        if (stopOnFailure) await this.stopFailedStart(handle);
        return this.fail(
          "startup-timeout",
          `Model readiness exceeded ${profile.readiness.startupTimeoutMs}ms`,
        );
      }
      await sleep(profile.readiness.probeIntervalMs);
    }
  }

  private async slotUsage(): Promise<"idle" | "busy" | "unknown"> {
    const profile = this.profile;
    if (!profile) return "unknown";
    try {
      const slots = await this.httpRequest(
        `${this.endpointRoot(profile)}/slots`,
        profile.readiness.requestTimeoutMs,
      );
      if (!Array.isArray(slots) || slots.length === 0) return "unknown";
      if (slots.some((slot) => isRecord(slot) && slot.is_processing === true)) {
        return "busy";
      }
      return slots.every(
        (slot) => isRecord(slot) && slot.is_processing === false,
      )
        ? "idle"
        : "unknown";
    } catch {
      return "unknown";
    }
  }

  private async stopWithTimeout(handle: OwnedModelProcess) {
    const timeoutMs = this.profile?.stopTimeoutMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        handle.stop(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async stopFailedStart(handle: OwnedModelProcess): Promise<void> {
    const result = await this.stopWithTimeout(handle).catch(() => undefined);
    if (
      !result ||
      result.termination.status !== "proven" ||
      this.processAlive(handle.pid)
    ) {
      this.record = this.advance({
        state: "error",
        failure: {
          kind: "stop-unverified",
          message: `Failed startup left process ${handle.pid} without closure proof`,
        },
      });
      await this.persist();
      throw new Error(this.record.failure!.message);
    }
    this.ownedProcess = undefined;
    this.record = this.advance({ ownership: undefined });
    await this.persist();
  }

  private async waitForExternalStarter(): Promise<ModelServiceRecord> {
    const profile = this.profile!;
    const deadline = Date.now() + profile.readiness.startupTimeoutMs;
    while (Date.now() < deadline) {
      const probe = await this.probe();
      if (probe.ready) return this.observeReady(probe);
      if (probe.reachable) return this.observeMismatch(probe);
      await sleep(profile.readiness.probeIntervalMs);
    }
    return this.fail(
      "startup-timeout",
      "Another live Conductor owner held the start fence but readiness timed out",
    );
  }

  private async acquireStartFence(): Promise<
    (() => Promise<void>) | undefined
  > {
    const target = path.join(this.root, "start-fence");
    const claimPath = path.join(target, "claim.json");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await mkdir(target);
        const claim: StartFence = {
          schema: "conductor.model-service-start-fence/v2",
          instanceId: this.instanceId,
          ownerPid: process.pid,
          createdAt: this.timestamp(),
        };
        try {
          const handle = await open(claimPath, "wx");
          await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
          await handle.sync();
          await handle.close();
        } catch (error) {
          await rm(target, { recursive: true, force: true });
          throw error;
        }
        return async () => {
          const current = await readFence(claimPath);
          if (current?.instanceId === this.instanceId) {
            await rm(target, { recursive: true, force: true });
          }
        };
      } catch (error) {
        if (!isExisting(error)) throw error;
        const claim = await readFence(claimPath);
        if (claim && this.processAlive(claim.ownerPid)) return undefined;
        if (!claim) {
          const age = await stat(target)
            .then((entry) => Date.now() - entry.mtimeMs)
            .catch(() => 0);
          if (age < 2_000) {
            await sleep(100);
            continue;
          }
        }
        const recoveryPath = path.join(target, "recovery.claim");
        let recovery;
        try {
          recovery = await open(recoveryPath, "wx");
          await recovery.writeFile(`${this.instanceId}\n`, "utf8");
          await recovery.sync();
          await recovery.close();
        } catch (recoveryError) {
          await recovery?.close().catch(() => undefined);
          if (isExisting(recoveryError) || isMissing(recoveryError)) {
            return undefined;
          }
          throw recoveryError;
        }
        const quarantine = `${target}.stale-${randomUUID()}`;
        try {
          await rename(target, quarantine);
          await rm(quarantine, { recursive: true, force: true });
        } catch (recoveryError) {
          if (!isMissing(recoveryError)) throw recoveryError;
        }
      }
    }
    throw new Error("Model-service start fence remained contested");
  }

  private endpointRoot(profile: ModelServiceProfile): string {
    const prefix =
      profile.endpoint.basePath === "/"
        ? ""
        : profile.endpoint.basePath.replace(/\/$/, "");
    return `http://${formatHost(profile.endpoint.host)}:${profile.endpoint.port}${prefix}`;
  }

  private async probe(): Promise<ProbeResult> {
    const profile = this.profile;
    if (!profile) return { reachable: false, offline: false, ready: false };
    const root = this.endpointRoot(profile);
    let models: unknown;
    try {
      models = await this.httpRequest(
        `${root}/v1/models`,
        profile.readiness.requestTimeoutMs,
      );
    } catch (error) {
      return {
        reachable: false,
        offline: isConnectionRefused(error),
        ready: false,
        detail: errorMessage(error),
      };
    }
    const entries = (models as { data?: unknown[] } | undefined)?.data;
    if (!Array.isArray(entries))
      return { reachable: true, offline: false, ready: false };
    const expected = entries.find(
      (entry) => isRecord(entry) && entry.id === profile.expected.model,
    ) as Record<string, unknown> | undefined;
    if (!expected) {
      const first = entries.find(
        (entry) => isRecord(entry) && typeof entry.id === "string",
      ) as Record<string, unknown> | undefined;
      return {
        reachable: true,
        offline: false,
        ready: false,
        model: typeof first?.id === "string" ? first.id : undefined,
      };
    }
    let context: unknown;
    const source = profile.expected.contextSource;
    try {
      context =
        source.kind === "models-entry"
          ? lookupField(expected, source.field)
          : lookupField(
              await this.httpRequest(
                `${root}${source.path}`,
                profile.readiness.requestTimeoutMs,
              ),
              source.field,
            );
    } catch {
      context = undefined;
    }
    return {
      reachable: true,
      offline: false,
      ready: context === profile.expected.context,
      model: profile.expected.model,
      context: typeof context === "number" ? context : undefined,
    };
  }

  private async observeReady(probe: ProbeResult): Promise<ModelServiceRecord> {
    await this.refreshLatest();
    if (!this.record) throw new Error("Model-service state is not initialized");
    this.record = modelServiceRecordSchema.parse({
      ...this.record,
      state: "ready",
      observed: observation(probe, this.timestamp()),
      readyAt: this.record.readyAt ?? this.timestamp(),
      failure: undefined,
      updatedAt: this.timestamp(),
    });
    return this.record;
  }

  private async markReady(probe: ProbeResult): Promise<ModelServiceRecord> {
    await this.refreshLatest();
    this.record = this.advance({
      state: "ready",
      observed: observation(probe, this.timestamp()),
      readyAt: this.timestamp(),
      failure: undefined,
    });
    await this.persist();
    return this.record;
  }

  private async observeMismatch(
    probe: ProbeResult,
  ): Promise<ModelServiceRecord> {
    await this.refreshLatest();
    if (!this.record) throw new Error("Model-service state is not initialized");
    const contextMismatch =
      probe.model === this.profile?.expected.model &&
      probe.context !== this.profile?.expected.context;
    this.record = modelServiceRecordSchema.parse({
      ...this.record,
      state: "wrong-model",
      observed: observation(probe, this.timestamp()),
      failure: {
        kind: contextMismatch ? "context-unverified" : "wrong-model",
        message: contextMismatch
          ? `Expected context ${this.profile?.expected.context}; observed ${probe.context ?? "unavailable"}`
          : `Expected model ${this.profile?.expected.model}; observed ${probe.model ?? "unavailable"}`,
      },
      updatedAt: this.timestamp(),
    });
    return this.record;
  }

  private async markMismatch(probe: ProbeResult): Promise<ModelServiceRecord> {
    await this.refreshLatest();
    const contextMismatch =
      probe.model === this.profile?.expected.model &&
      probe.context !== this.profile?.expected.context;
    this.record = this.advance({
      state: "wrong-model",
      observed: observation(probe, this.timestamp()),
      failure: {
        kind: contextMismatch ? "context-unverified" : "wrong-model",
        message: contextMismatch
          ? `Expected context ${this.profile?.expected.context}; observed ${probe.context ?? "unavailable"}`
          : `Expected model ${this.profile?.expected.model}; observed ${probe.model ?? "unavailable"}`,
      },
    });
    await this.persist();
    return this.record;
  }

  private async reconcilePreviousOwner(): Promise<boolean> {
    const record = this.record!;
    if (record.profileFingerprint !== this.profileFingerprint) {
      if (record.ownership && this.processAlive(record.ownership.workerPid)) {
        // Keep the foreign profile's durable record intact. This manager may
        // observe it but cannot rewrite or acquire its stop authority.
        this.foreignOwnershipBlocked = true;
        return false;
      }
      this.record = this.blankRecord();
      return true;
    }
    const ownership = record.ownership;
    if (!ownership || ownership.instanceId === this.instanceId) return false;
    if (this.processAlive(ownership.ownerPid)) {
      // Another live manager remains authoritative; preserve its exact record.
      return false;
    }
    if (this.processAlive(ownership.workerPid)) {
      this.record = this.advance({
        state: "error",
        failure: {
          kind: "stop-refused",
          message: `Residual process ${ownership.workerPid} is observable but ownership is not transferable`,
        },
      });
      return true;
    }
    this.record = this.advance({
      state: "offline",
      ownership: undefined,
      stoppedAt: this.timestamp(),
      failure: undefined,
    });
    return true;
  }

  private async observeUnexpectedExit(
    handle: OwnedModelProcess,
  ): Promise<void> {
    const result = await handle.completion.catch(() => undefined);
    if (this.ownedProcess !== handle) return;
    if (
      this.record?.operation?.kind === "stop" &&
      this.record.operation.status === "requested"
    ) {
      return;
    }
    this.ownedProcess = undefined;
    this.record = this.advance({
      state: "offline",
      ownership: undefined,
      stoppedAt: this.timestamp(),
      failure:
        result && result.termination.status === "proven"
          ? undefined
          : {
              kind: "stop-unverified",
              message: "Model guardian exited without complete closure proof",
            },
    });
    await this.persist();
  }

  private localStopRefusal(message: string): ModelServiceRecord {
    return this.localFailure("stop-refused", message);
  }

  private localFailure(
    kind: NonNullable<ModelServiceRecord["failure"]>["kind"],
    message: string,
  ): ModelServiceRecord {
    if (!this.record) throw new Error("Model-service state is not initialized");
    return modelServiceRecordSchema.parse({
      ...this.record,
      state: "error",
      failure: { kind, message },
    });
  }

  private async failStart(
    operationId: string,
    error: unknown,
  ): Promise<ModelServiceRecord> {
    return this.fail(
      "spawn-failed",
      `Model-service launch failed: ${errorMessage(error)}`,
      operationId,
    );
  }

  private async fail(
    kind: NonNullable<ModelServiceRecord["failure"]>["kind"],
    message: string,
    operationId?: string,
  ): Promise<ModelServiceRecord> {
    this.record = this.advance({
      state: kind === "unconfigured" ? "offline" : "error",
      failure: { kind, message },
      operation:
        operationId && this.record?.operation
          ? {
              operationId,
              kind: this.record.operation.kind,
              status: "failed",
              requestedAt: this.record.operation.requestedAt,
              finishedAt: this.timestamp(),
              detail: message,
            }
          : this.record?.operation,
    });
    await this.persist();
    return this.record;
  }

  private completeCurrentOperation(
    detail: string,
  ): ModelServiceRecord["operation"] {
    const current = this.record?.operation;
    return current?.status === "requested"
      ? {
          ...current,
          status: "completed",
          finishedAt: this.timestamp(),
          detail,
        }
      : current;
  }

  private serializeTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionTail.then(operation, operation);
    this.transitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private blankRecord(): ModelServiceRecord {
    return modelServiceRecordSchema.parse({
      schema: "conductor.model-service/v2",
      profileId: this.profile?.profileId ?? "unconfigured",
      profileFingerprint: this.profileFingerprint,
      state: "offline",
      expected: this.profile
        ? {
            model: this.profile.expected.model,
            context: this.profile.expected.context,
          }
        : undefined,
      revision: 0,
      updatedAt: this.timestamp(),
    });
  }

  private advance(patch: Partial<ModelServiceRecord>): ModelServiceRecord {
    if (!this.record) throw new Error("Model-service state is not initialized");
    return modelServiceRecordSchema.parse({
      ...this.record,
      ...patch,
      schema: "conductor.model-service/v2",
      profileId: this.profile?.profileId ?? "unconfigured",
      profileFingerprint: this.profileFingerprint,
      revision: this.record.revision + 1,
      updatedAt: this.timestamp(),
    });
  }

  private async refreshLatest(): Promise<void> {
    try {
      const latest = modelServiceRecordSchema.parse(
        JSON.parse(await readFile(this.recordPath(), "utf8")),
      );
      if (
        latest.profileFingerprint === this.profileFingerprint &&
        latest.revision > (this.record?.revision ?? -1)
      ) {
        this.record = latest;
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async persist(): Promise<void> {
    if (!this.record) return;
    await writeJsonAtomic(this.recordPath(), this.record);
  }

  private recordPath(): string {
    return path.join(this.root, "model-service.json");
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function observation(probe: ProbeResult, observedAt: string) {
  return {
    reachable: probe.reachable,
    model: probe.model,
    context: probe.context,
    observedAt,
  };
}

async function hashLaunchFiles(executable: string, args: string[]) {
  const candidates = [executable, ...args.map(unquote)].filter(path.isAbsolute);
  const unique = [
    ...new Set(candidates.map((candidate) => path.resolve(candidate))),
  ];
  const evidence = [];
  for (const candidate of unique) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      evidence.push({
        path: candidate,
        bytes: info.size,
        sha256: createHash("sha256")
          .update(await readFile(candidate))
          .digest("hex"),
      });
    } catch (error) {
      if (candidate === path.resolve(executable)) throw error;
    }
  }
  return evidence;
}

async function readFence(target: string): Promise<StartFence | undefined> {
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as StartFence;
    return parsed.schema === "conductor.model-service-start-fence/v2"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await ensureDirectory(path.dirname(target));
  const staging = `${target}.${process.pid}-${randomUUID()}.tmp`;
  const handle = await open(staging, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

async function ensureDirectory(target: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(target, { recursive: true });
}

async function defaultHttpJson(
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Model endpoint ${url} responded ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

function lookupField(value: unknown, field: string): unknown {
  let cursor = value;
  for (const segment of field.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function formatHost(host: string): string {
  return host === "::1" ? "[::1]" : host;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConnectionRefused(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor; depth += 1) {
    if (
      typeof cursor === "object" &&
      "code" in cursor &&
      cursor.code === "ECONNREFUSED"
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
