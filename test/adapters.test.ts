import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { freezeJobRequest } from "../src/contracts/job.js";
import { CodexAdapter } from "../src/workers/codex.js";
import { KodeAdapter } from "../src/workers/kode.js";

const contract = freezeJobRequest(
  {
    objective: "Make one bounded change",
    repositoryPath: "Z:\\repo",
    adapterId: "fixture",
    adapterOptions: { model: "test-model", profile: "test-profile" },
    idempotencyKey: "adapter-snapshot",
  },
  {
    repositoryRoot: "Z:\\repo",
    baseRevision: "c".repeat(40),
  },
);

test("Kode defaults to safe unattended edits without permission bypass", () => {
  const adapter = new KodeAdapter(process.execPath);
  const invocation = adapter.buildInvocation(contract, "Z:\\workspace");
  expect(adapter.description.hostExecution).toBe("file-edit-only");
  expect(invocation.executable).toBe(process.execPath);
  expect(invocation.args).toContain("--safe");
  expect(invocation.args).toContain("acceptEdits");
  expect(invocation.args).toContain("--verbose");
  expect(invocation.args).toContain("stream-json");
  expect(invocation.args).toContain("Read,Edit,Write,LS,Glob,Grep");
  expect(invocation.args).toContain("--max-turns");
  expect(invocation.args).toContain("16");
  expect(invocation.args).not.toContain("Bash");
  expect(invocation.args).not.toContain("Task");
  expect(invocation.args).not.toContain("bypassPermissions");
  expect(invocation.args.at(-1)).toContain(
    "Never create temporary files, helper scripts, test runners",
  );
  expect(invocation.args.at(-1)).toContain(
    "never create repository files for reports",
  );
  expect(invocation.cwd).toBe("Z:\\workspace");
});

test("Kode omits file creation authority when every allowed target exists", () => {
  const workspace = mkdtempSync(
    path.join(os.tmpdir(), "conductor-kode-tools-"),
  );
  try {
    mkdirSync(path.join(workspace, "gameplay"));
    writeFileSync(path.join(workspace, "gameplay", "health.js"), "stub\n");
    const scoped = freezeJobRequest(
      {
        objective: "Edit an existing gameplay function",
        repositoryPath: workspace,
        adapterId: "kode",
        scope: { allowedPaths: ["gameplay/health.js"] },
      },
      { repositoryRoot: workspace, baseRevision: "d".repeat(40) },
    );
    const invocation = new KodeAdapter(process.execPath).buildInvocation(
      scoped,
      workspace,
    );
    const tools = invocation.args[invocation.args.indexOf("--tools") + 1];
    expect(tools).toBe("Read,Edit,LS,Glob,Grep");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Kode can launch a compiled fork through an explicit interpreter and entry", () => {
  const entry = fileURLToPath(
    new URL("./fixtures/mutate-worker.ts", import.meta.url),
  );
  const invocation = new KodeAdapter(process.execPath, entry).buildInvocation(
    contract,
    "Z:\\workspace",
  );
  expect(invocation.executable).toBe(process.execPath);
  expect(invocation.args[0]).toBe(entry);
});

test("Codex stays in workspace-write and accepts only bounded adapter options", () => {
  const adapter = new CodexAdapter(process.execPath);
  const invocation = adapter.buildInvocation(contract, "Z:\\workspace");
  expect(adapter.description.hostExecution).toBe("command-capable");
  expect(invocation.args).toContain("workspace-write");
  expect(invocation.args).toContain("test-model");
  expect(invocation.args).toContain("test-profile");
  expect(invocation.args).not.toContain(
    "--dangerously-bypass-approvals-and-sandbox",
  );
});
