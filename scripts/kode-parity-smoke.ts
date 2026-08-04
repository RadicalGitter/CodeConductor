import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const conductorRoot = path.resolve(import.meta.dir, "..");
const kodeRoot = path.resolve(process.argv[2] ?? "Z:\\Programmering\\Kode-CLI");
const kodeServer = path.join(
  kodeRoot,
  "packages",
  "mcp-delegate",
  "src",
  "index.ts",
);
const conductorServer = path.join(conductorRoot, "src", "cli.ts");

await access(kodeServer);
await access(conductorServer);

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "conductor-parity-"),
);
const repository = path.join(temporaryRoot, "repository");
const kodeArtifacts = path.join(temporaryRoot, "kode-artifacts");
const conductorArtifacts = path.join(temporaryRoot, "conductor-artifacts");
const fakeWorker = path.join(temporaryRoot, "fake-worker.mjs");

await mkdir(repository);
await writeFile(
  fakeWorker,
  `import { writeFile } from "node:fs/promises";
import path from "node:path";
await writeFile(path.join(process.cwd(), "parity-output.txt"), "equivalent proposal\\n", "utf8");
console.log(JSON.stringify({ type: "complete", cwd: process.cwd(), argv: process.argv.slice(2) }));
`,
  "utf8",
);
await git(repository, ["init", "-b", "main"]);
await git(repository, ["config", "user.email", "conductor@example.invalid"]);
await git(repository, ["config", "user.name", "Conductor Parity"]);
await writeFile(path.join(repository, "seed.txt"), "baseline\n", "utf8");
await git(repository, ["add", "seed.txt"]);
await git(repository, ["commit", "-m", "baseline"]);
const baseRevision = await git(repository, ["rev-parse", "HEAD"]);

const inherited = getDefaultEnvironment();
const kodeTransport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", kodeServer],
  cwd: kodeRoot,
  env: {
    ...inherited,
    KODE_CLI_ENTRY: fakeWorker,
    KODE_DELEGATE_NODE_BIN: "node",
    KODE_DELEGATE_ARTIFACTS_DIR: kodeArtifacts,
  },
  stderr: "pipe",
});
const conductorTransport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", conductorServer],
  cwd: conductorRoot,
  env: {
    ...inherited,
    CONDUCTOR_DATA_DIR: conductorArtifacts,
    CONDUCTOR_KODE_ENTRY: fakeWorker,
    CONDUCTOR_KODE_NODE_BIN: "node",
  },
  stderr: "pipe",
});
const kodeClient = new Client({ name: "kode-parity-smoke", version: "1.0.0" });
const conductorClient = new Client({
  name: "conductor-parity-smoke",
  version: "1.0.0",
});

let kodeWorktree: string | undefined;
let conductorAttemptId: string | undefined;

try {
  await kodeClient.connect(kodeTransport);
  await conductorClient.connect(conductorTransport);

  const [kodeTools, conductorTools] = await Promise.all([
    kodeClient.listTools(),
    conductorClient.listTools(),
  ]);
  assert(
    kodeTools.tools.some((tool) => tool.name === "delegate_coding_task"),
    "Kode delegate tool missing",
  );
  assert(
    conductorTools.tools.some((tool) => tool.name === "submit_coding_job"),
    "Conductor submit tool missing",
  );

  const commonObjective =
    "Create parity-output.txt with the requested fixture content.";
  const kodeArguments = {
    backend: "kode-local",
    task: commonObjective,
    repo_path: repository,
    base_ref: baseRevision,
    permission_mode: "acceptEdits",
    timeout_seconds: 30,
    job_id: "black-box-parity-job",
    attempt_id: "attempt-1",
  };
  const kodeResult = textJson(
    await kodeClient.callTool({
      name: "delegate_coding_task",
      arguments: kodeArguments,
    }),
  );
  assert(kodeResult.status === "completed", "Kode attempt did not complete");
  assert(kodeResult.authority === "proposal-only", "Kode authority changed");
  kodeWorktree = String(kodeResult.attempt.worktree.worktreePath);

  const conductorArguments = {
    objective: commonObjective,
    repositoryPath: repository,
    baseRef: baseRevision,
    adapterId: "kode",
    timeoutMs: 30_000,
    retainWorkspace: true,
    idempotencyKey: "black-box-parity-job",
  };
  const submitted = textJson(
    await conductorClient.callTool({
      name: "submit_coding_job",
      arguments: conductorArguments,
    }),
  );
  const submittedItem = submitted.item as Record<string, unknown>;
  conductorAttemptId = String(submittedItem.attemptId);
  assert(
    ["running", "completed"].includes(String(submittedItem.status)),
    "Conductor submission did not pass through the durable dispatcher",
  );
  const conductorResult = textJson(
    await conductorClient.callTool({
      name: "wait_for_attempt",
      arguments: { attemptId: conductorAttemptId },
    }),
  );
  assert(
    conductorResult.status === "completed",
    "Conductor attempt did not complete",
  );
  const conductorWorktree = String(conductorResult.workspacePath);

  for (const worktree of [kodeWorktree, conductorWorktree]) {
    assert(
      (await git(worktree, ["rev-parse", "HEAD"])) === baseRevision,
      `Wrong base revision in ${worktree}`,
    );
    assert(
      (await readFile(path.join(worktree, "parity-output.txt"), "utf8")) ===
        "equivalent proposal\n",
      `Worker proposal missing in ${worktree}`,
    );
  }
  assert(
    !(await exists(path.join(repository, "parity-output.txt"))),
    "Primary checkout changed",
  );

  const kodeReplay = textJson(
    await kodeClient.callTool({
      name: "delegate_coding_task",
      arguments: kodeArguments,
    }),
  );
  const conductorReplay = textJson(
    await conductorClient.callTool({
      name: "submit_coding_job",
      arguments: conductorArguments,
    }),
  );
  assert(kodeReplay.duplicate === true, "Kode replay spawned duplicate work");
  assert(
    conductorReplay.idempotentReplay === true,
    "Conductor replay spawned duplicate work",
  );

  const conductorManifest = textJson(
    await conductorClient.callTool({
      name: "get_attempt",
      arguments: { attemptId: conductorAttemptId },
    }),
  );
  await Promise.all([
    access(String(kodeResult.attempt.artifacts.stdout)),
    access(String(kodeResult.attempt.artifacts.stderr)),
    access(String(conductorManifest.artifacts.stdout)),
    access(String(conductorManifest.artifacts.stderr)),
    access(String(conductorManifest.artifacts.proposalPatch)),
  ]);

  console.log(
    JSON.stringify(
      {
        schema: "conductor.parity-smoke/v1",
        baselineRevision: baseRevision,
        primaryCheckoutUntouched: true,
        kode: {
          status: kodeResult.status,
          duplicateReplay: kodeReplay.duplicate,
          worktree: kodeWorktree,
          artifactDir: kodeResult.artifactDir,
        },
        conductor: {
          status: conductorResult.status,
          idempotentReplay: conductorReplay.idempotentReplay,
          asynchronousSubmission: submitted.status === "reserved",
          worktree: conductorWorktree,
          artifacts: conductorManifest.artifacts,
        },
      },
      null,
      2,
    ),
  );

  await kodeClient.callTool({
    name: "remove_delegate_worktree",
    arguments: {
      repo_path: repository,
      worktree_path: kodeWorktree,
      force: true,
    },
  });
  kodeWorktree = undefined;
  await conductorClient.callTool({
    name: "remove_attempt_workspace",
    arguments: { attemptId: conductorAttemptId },
  });
  conductorAttemptId = undefined;
} finally {
  if (kodeWorktree) {
    await kodeClient
      .callTool({
        name: "remove_delegate_worktree",
        arguments: {
          repo_path: repository,
          worktree_path: kodeWorktree,
          force: true,
        },
      })
      .catch(() => undefined);
  }
  if (conductorAttemptId) {
    await conductorClient
      .callTool({
        name: "remove_attempt_workspace",
        arguments: { attemptId: conductorAttemptId },
      })
      .catch(() => undefined);
  }
  await Promise.allSettled([kodeClient.close(), conductorClient.close()]);
  await rm(temporaryRoot, { recursive: true, force: true });
}

function textJson(result: unknown): any {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text JSON");
  return JSON.parse(text);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function git(cwd: string, args: string[]): Promise<string> {
  return command("git", ["-C", cwd, ...args]);
}

function command(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${executable} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
