import { stat } from "node:fs/promises";
import path from "node:path";

import {
  workerExecutionProfileSchema,
  type WorkerExecutionProfile,
} from "../contracts/attempt.js";
import { fingerprint, type JobContract } from "../contracts/job.js";
import type { ProcessInvocation } from "../runtime/process-runner.js";
import type { WorkerAdapter } from "../workers/adapter.js";
import { sha256File } from "./hash.js";

export async function captureWorkerExecutionProfile(input: {
  adapter: WorkerAdapter;
  contract: JobContract;
  invocation: ProcessInvocation;
  now?: Date;
}): Promise<WorkerExecutionProfile> {
  const unresolvedReasons: string[] = [];
  const requestedModel = input.contract.worker.options.model;
  const modelSelector =
    typeof requestedModel === "string" && requestedModel.trim()
      ? requestedModel
      : undefined;
  if (
    input.adapter.description.modelIdentity === "required" &&
    !modelSelector
  ) {
    unresolvedReasons.push("The job did not bind an explicit model selector");
  }

  let declared:
    ReturnType<NonNullable<WorkerAdapter["profileEvidence"]>> | undefined;
  try {
    declared = input.adapter.profileEvidence?.(
      input.contract,
      input.invocation,
    );
  } catch (error) {
    unresolvedReasons.push(
      `Adapter profile evidence failed: ${errorMessage(error)}`,
    );
  }
  unresolvedReasons.push(...(declared?.unresolvedReasons ?? []));

  const candidates = new Map<
    string,
    "executable" | "harness" | "configuration"
  >();
  candidates.set(path.resolve(input.invocation.executable), "executable");
  for (const argument of input.invocation.args) {
    if (path.isAbsolute(argument))
      candidates.set(path.resolve(argument), "harness");
  }
  for (const file of declared?.files ?? []) {
    candidates.set(path.resolve(file.path), file.role);
  }

  const files: WorkerExecutionProfile["files"] = [];
  for (const [target, role] of [...candidates].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    try {
      const details = await stat(target);
      if (!details.isFile()) {
        if (role !== "harness") {
          unresolvedReasons.push(`${role} evidence is not a file: ${target}`);
        }
        continue;
      }
      files.push({
        role,
        path: target,
        size: details.size,
        sha256: await sha256File(target),
      });
    } catch (error) {
      unresolvedReasons.push(
        `${role} evidence is unreadable at ${target}: ${errorMessage(error)}`,
      );
    }
  }

  const adapter = {
    id: input.adapter.description.id,
    label: input.adapter.description.label,
    executable: input.adapter.description.executable,
    mutationMode: input.adapter.description.mutationMode,
    outputFormat: input.adapter.description.outputFormat,
    safetyMode: input.adapter.description.safetyMode,
    hostExecution: input.adapter.description.hostExecution,
    modelIdentity: input.adapter.description.modelIdentity,
  };
  const attributes = Object.fromEntries(
    Object.entries(declared?.attributes ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const identity = {
    adapter,
    adapterOptionsFingerprint: fingerprint(input.contract.worker.options),
    invocationFingerprint: fingerprint({
      executable: input.invocation.executable,
      args: input.invocation.args,
      cwd: input.invocation.cwd,
      environmentKeys: Object.keys(input.invocation.env ?? {}).sort(),
    }),
    modelSelector,
    attributes,
    files,
    unresolvedReasons: [...new Set(unresolvedReasons)].sort(),
  };
  const recordedAt = (input.now ?? new Date()).toISOString();
  const status = identity.unresolvedReasons.length
    ? ("unresolved" as const)
    : ("complete" as const);
  return workerExecutionProfileSchema.parse({
    schema: "conductor.worker-execution-profile/v1",
    recordedAt,
    status,
    ...identity,
    profileFingerprint: fingerprint(
      jsonValue({ recordedAt, status, ...identity }),
    ),
  });
}

export async function validateWorkerExecutionProfile(
  profile: WorkerExecutionProfile,
): Promise<void> {
  const parsed = workerExecutionProfileSchema.parse(profile);
  const identity = {
    adapter: parsed.adapter,
    adapterOptionsFingerprint: parsed.adapterOptionsFingerprint,
    invocationFingerprint: parsed.invocationFingerprint,
    modelSelector: parsed.modelSelector,
    attributes: parsed.attributes,
    files: parsed.files,
    unresolvedReasons: parsed.unresolvedReasons,
  };
  if (
    fingerprint(
      jsonValue({
        recordedAt: parsed.recordedAt,
        status: parsed.status,
        ...identity,
      }),
    ) !== parsed.profileFingerprint
  ) {
    throw new Error("Worker execution profile fingerprint changed");
  }
  if (parsed.status !== "complete") {
    throw new Error(
      `Worker execution profile is unresolved: ${parsed.unresolvedReasons.join("; ")}`,
    );
  }
  for (const file of parsed.files) {
    let details;
    try {
      details = await stat(file.path);
    } catch {
      throw new Error(`Worker profile evidence is missing: ${file.path}`);
    }
    if (
      !details.isFile() ||
      details.size !== file.size ||
      (await sha256File(file.path)) !== file.sha256
    ) {
      throw new Error(`Worker profile evidence changed: ${file.path}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
