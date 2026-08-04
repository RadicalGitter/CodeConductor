import { expect, test } from "bun:test";
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

test("Kode defaults to its explicit safe permission mode", () => {
  const invocation = new KodeAdapter(process.execPath).buildInvocation(
    contract,
    "Z:\\workspace",
  );
  expect(invocation.executable).toBe(process.execPath);
  expect(invocation.args).toContain("--safe");
  expect(invocation.args).toContain("stream-json");
  expect(invocation.cwd).toBe("Z:\\workspace");
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
  const invocation = new CodexAdapter(process.execPath).buildInvocation(
    contract,
    "Z:\\workspace",
  );
  expect(invocation.args).toContain("workspace-write");
  expect(invocation.args).toContain("test-model");
  expect(invocation.args).toContain("test-profile");
  expect(invocation.args).not.toContain(
    "--dangerously-bypass-approvals-and-sandbox",
  );
});
