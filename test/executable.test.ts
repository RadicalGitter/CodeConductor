import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveExecutablePath } from "../src/runtime/executable.js";

test("resolves trusted executables to absolute real paths", () => {
  expect(resolveExecutablePath(process.execPath)).toBeTruthy();
  expect(path.isAbsolute(resolveExecutablePath(process.execPath)!)).toBe(true);
});

test("does not treat Windows shell shims as shell-free executables", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-shim-"));
  try {
    await writeFile(path.join(root, "worker.cmd"), "@exit /b 0\r\n", "utf8");
    expect(resolveExecutablePath("worker", { PATH: root })).toBeUndefined();
    expect(
      resolveExecutablePath(path.join(root, "worker.cmd")),
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
