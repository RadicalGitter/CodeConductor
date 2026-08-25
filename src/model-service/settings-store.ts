import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  consoleSettingsDocumentSchema,
  consoleSettingsSchema,
  type ConsoleSettings,
  type ConsoleSettingsDocument,
} from "./settings-contract.js";

export class SettingsRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Console settings revision ${expectedRevision} is stale; current revision is ${actualRevision}`,
    );
    this.name = "SettingsRevisionConflictError";
  }
}

export class ConsoleSettingsStore {
  readonly filePath: string;

  constructor(
    root: string,
    filePath = path.join(root, "console-settings.json"),
  ) {
    this.filePath = path.resolve(filePath);
  }

  async read(): Promise<ConsoleSettingsDocument | undefined> {
    try {
      return consoleSettingsDocumentSchema.parse(
        JSON.parse(await readFile(this.filePath, "utf8")),
      );
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new Error(
        `Owner console settings are unreadable and are never guessed: ${errorMessage(error)}`,
      );
    }
  }

  async update(
    input: ConsoleSettings,
    expectedRevision: number,
  ): Promise<ConsoleSettingsDocument> {
    const settings = consoleSettingsSchema.parse(input);
    const current = await this.read();
    const actualRevision = current?.revision ?? 0;
    if (actualRevision !== expectedRevision) {
      throw new SettingsRevisionConflictError(expectedRevision, actualRevision);
    }
    if (
      current &&
      JSON.stringify(current.settings) === JSON.stringify(settings)
    ) {
      return current;
    }
    const document = consoleSettingsDocumentSchema.parse({
      schema: "conductor.console-settings/v1",
      revision: actualRevision + 1,
      settings,
      updatedAt: new Date().toISOString(),
    });
    await writeJsonAtomic(this.filePath, document);
    return document;
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
