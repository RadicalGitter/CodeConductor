import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

const kodeContract = freezeJobRequest(
  {
    objective: "Make one bounded change",
    repositoryPath: "Z:\\repo",
    adapterId: "kode",
    adapterOptions: { model: "test-model" },
    idempotencyKey: "kode-adapter-snapshot",
  },
  {
    repositoryRoot: "Z:\\repo",
    baseRevision: "c".repeat(40),
  },
);

test("Kode defaults to safe unattended edits without permission bypass", () => {
  const adapter = new KodeAdapter(process.execPath);
  const invocation = adapter.buildInvocation(kodeContract, "Z:\\workspace");
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
    kodeContract,
    "Z:\\workspace",
  );
  expect(invocation.executable).toBe(process.execPath);
  expect(invocation.args[0]).toBe(entry);
});

test("Kode grants scoped reads and denies writes for declared external evidence roots", () => {
  const evidenceRoot = mkdtempSync(
    path.join(os.tmpdir(), "conductor-kode-evidence-"),
  );
  try {
    const evidenceFile = path.join(evidenceRoot, "startup.vbs");
    writeFileSync(evidenceFile, "fixture\n");
    const scoped = freezeJobRequest(
      {
        objective: "Review retained evidence",
        repositoryPath: "Z:\\repo",
        adapterId: "kode",
        adapterOptions: {
          model: "main",
          readOnlyPaths: [evidenceRoot, evidenceFile],
        },
      },
      { repositoryRoot: "Z:\\repo", baseRevision: "e".repeat(40) },
    );
    const adapter = new KodeAdapter(process.execPath);
    const invocation = adapter.buildInvocation(scoped, "Z:\\workspace");
    const portableRoot = realpathForKodeRule(evidenceRoot);
    const portableFile = realpathForKodeRule(evidenceFile);
    const allowedIndex = invocation.args.indexOf("--allowed-tools");
    const deniedIndex = invocation.args.indexOf("--disallowed-tools");

    expect(allowedIndex).toBeGreaterThan(-1);
    expect(deniedIndex).toBeGreaterThan(allowedIndex);
    expect(invocation.args).toContain(`Read(${portableRoot})`);
    expect(invocation.args).toContain(`LS(${portableRoot})`);
    expect(invocation.args).toContain(`Glob(${portableRoot})`);
    expect(invocation.args).toContain(`Grep(${portableRoot})`);
    expect(invocation.args).toContain(`Edit(${portableRoot})`);
    expect(invocation.args).toContain(`Write(${portableRoot})`);
    expect(invocation.args).toContain(`NotebookEdit(${portableRoot})`);
    expect(invocation.args).toContain(`Read(${portableFile})`);
    expect(invocation.args).toContain(`Write(${portableFile})`);
    expect(invocation.args).not.toContain("--add-dir");
    expect(invocation.args.at(-1)).toContain(evidenceRoot);

    const evidence = adapter.profileEvidence(scoped, invocation);
    expect(evidence.attributes.externalReadOnlyRoots).toBe(
      JSON.stringify([path.resolve(evidenceRoot), path.resolve(evidenceFile)]),
    );
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test("Kode rejects malformed or widened adapter options", () => {
  const evidenceRoot = mkdtempSync(
    path.join(os.tmpdir(), "conductor-kode-invalid-evidence-"),
  );
  try {
    const build = (adapterOptions: Record<string, unknown>) =>
      new KodeAdapter(process.execPath).buildInvocation(
        freezeJobRequest(
          {
            objective: "Review retained evidence",
            repositoryPath: "Z:\\repo",
            adapterId: "kode",
            adapterOptions,
          },
          { repositoryRoot: "Z:\\repo", baseRevision: "f".repeat(40) },
        ),
        "Z:\\workspace",
      );

    expect(() => build({ model: "main", profile: "unexpected" })).toThrow(
      "Unsupported Kode adapter option(s): profile",
    );
    expect(() => build({ model: "" })).toThrow(
      "model must be a non-empty string",
    );
    expect(() => build({ readOnlyPaths: "not-an-array" })).toThrow(
      "readOnlyPaths must be an array",
    );
    expect(() => build({ readOnlyPaths: ["relative"] })).toThrow(
      "must be an absolute local path",
    );
    expect(() =>
      build({ readOnlyPaths: [path.join(evidenceRoot, "missing")] }),
    ).toThrow("must identify an existing file or directory");
    expect(() =>
      build({ readOnlyPaths: [evidenceRoot, path.resolve(evidenceRoot)] }),
    ).toThrow("Duplicate Kode read-only path");
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

function realpathForKodeRule(candidate: string): string {
  const portable = path
    .resolve(candidate)
    .replace(
      /^([A-Za-z]):[\\/]/,
      (_match, drive: string) => `/${drive.toLowerCase()}/`,
    )
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  return statSync(candidate).isDirectory() ? `/${portable}/**` : `/${portable}`;
}

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
