import { expect, test } from "bun:test";

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
  const invocation = new KodeAdapter("kode-test").buildInvocation(
    contract,
    "Z:\\workspace",
  );
  expect(invocation.executable).toBe("kode-test");
  expect(invocation.args).toContain("--safe");
  expect(invocation.args).toContain("stream-json");
  expect(invocation.cwd).toBe("Z:\\workspace");
});

test("Kode can launch a compiled fork through an explicit interpreter and entry", () => {
  const invocation = new KodeAdapter(
    "node-test",
    "Z:\\Kode-CLI\\dist\\index.js",
  ).buildInvocation(contract, "Z:\\workspace");
  expect(invocation.executable).toBe("node-test");
  expect(invocation.args[0]).toBe("Z:\\Kode-CLI\\dist\\index.js");
});

test("Codex stays in workspace-write and accepts only bounded adapter options", () => {
  const invocation = new CodexAdapter("codex-test").buildInvocation(
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
