import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export type TransitionFailpointName =
  "after-reserve" | "after-snapshot" | "after-projection";

export interface TransitionContext {
  recordKind: "attempt" | "attempt-cleanup" | "queue-item";
  recordId: string;
  revision: number;
  directory: string;
}

export type TransitionFailpoint = (
  point: TransitionFailpointName,
  context: TransitionContext,
) => void | Promise<void>;

export class TransitionConflictError extends Error {
  constructor(
    readonly recordKind: TransitionContext["recordKind"],
    readonly recordId: string,
    readonly expectedRevision: number,
    readonly actualRevision?: number,
  ) {
    super(
      actualRevision === undefined
        ? `${recordKind} ${recordId} revision ${expectedRevision + 1} was already claimed`
        : `${recordKind} ${recordId} expected revision ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "TransitionConflictError";
  }
}

export class TransitionIntegrityError extends Error {
  constructor(
    readonly recordKind: TransitionContext["recordKind"],
    readonly recordId: string,
    readonly revision: number,
    message: string,
  ) {
    super(
      `${recordKind} ${recordId} revision ${revision} is incomplete: ${message}`,
    );
    this.name = "TransitionIntegrityError";
  }
}

export async function commitTransition<T>(input: {
  recordKind: TransitionContext["recordKind"];
  recordId: string;
  expectedRevision: number;
  value: T;
  transitionsRoot: string;
  snapshotName: string;
  projectionPath: string;
  writeJsonAtomic: (target: string, value: T) => Promise<void>;
  failpoint?: TransitionFailpoint;
}): Promise<void> {
  const revision = input.expectedRevision + 1;
  await mkdir(input.transitionsRoot, { recursive: true });
  const directory = path.join(
    input.transitionsRoot,
    revision.toString().padStart(12, "0"),
  );
  const staging = path.join(
    input.transitionsRoot,
    `.${revision.toString().padStart(12, "0")}.reserve-${process.pid}-${randomUUID()}`,
  );
  const context: TransitionContext = {
    recordKind: input.recordKind,
    recordId: input.recordId,
    revision,
    directory,
  };

  await mkdir(staging);
  try {
    await input.writeJsonAtomic(
      path.join(staging, input.snapshotName),
      input.value,
    );
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY")) {
      throw new TransitionConflictError(
        input.recordKind,
        input.recordId,
        input.expectedRevision,
      );
    }
    throw error;
  }

  await input.failpoint?.("after-reserve", context);
  await input.failpoint?.("after-snapshot", context);
  await input.writeJsonAtomic(input.projectionPath, input.value);
  await input.failpoint?.("after-projection", context);
}

export async function readLatestTransition<T>(input: {
  recordKind: TransitionContext["recordKind"];
  recordId: string;
  transitionsRoot: string;
  snapshotName: string;
  parse: (value: unknown) => T;
  revisionOf: (value: T) => number;
}): Promise<T | undefined> {
  let entries;
  try {
    entries = await readdir(input.transitionsRoot, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const latest = entries
    .filter((entry) => entry.isDirectory() && /^\d{12}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!latest) return undefined;

  const revision = Number(latest);
  try {
    const value = input.parse(
      JSON.parse(
        await readFile(
          path.join(input.transitionsRoot, latest, input.snapshotName),
          "utf8",
        ),
      ),
    );
    if (input.revisionOf(value) !== revision) {
      throw new Error(`snapshot declares revision ${input.revisionOf(value)}`);
    }
    return value;
  } catch (error) {
    throw new TransitionIntegrityError(
      input.recordKind,
      input.recordId,
      revision,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
