import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JobContract } from "../src/contracts/job.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import { DurableDispatcher } from "../src/queue/dispatcher.js";
import { QueueStore } from "../src/queue/queue-store.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { CommandProfiles } from "../src/sources/command-profiles.js";
import { ContractSourceCompiler } from "../src/sources/compiler.js";
import { ContractSourceService } from "../src/sources/service.js";
import { ContractSourcePoller } from "../src/sources/poller.js";
import { SourceWatchStore } from "../src/sources/watch-store.js";
import { ExecutionPolicy } from "../src/verification/command-executor.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { command, createTestRepository } from "./helpers.js";

const fixture = fileURLToPath(
  new URL("./fixtures/delayed-worker.ts", import.meta.url),
);

test("compiles tracked source comments into an idempotent dependency queue", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-source-"));
  const sourcePath = path.join(repository.root, "gameplay.ts");
  await writeFile(sourcePath, gameplayContracts(), "utf8");
  await command("git", ["add", "gameplay.ts"], repository.root);
  await command(
    "git",
    ["commit", "-m", "add gameplay contracts"],
    repository.root,
  );

  const store = new ArtifactStore(dataRoot);
  const profiles = new CommandProfiles({
    schema: "conductor.command-profiles/v1",
    profiles: {
      "generated-exists": {
        executable: process.execPath,
        argsPrefix: [
          "-e",
          "process.exit(require('node:fs').existsSync('generated.txt')?0:1)",
        ],
      },
    },
  });
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new SourceFixtureAdapter()]),
    new ExecutionPolicy({ allowedExecutables: profiles.executablePaths() }),
  );
  const queue = new QueueStore(store);
  const dispatcher = new DurableDispatcher(conductor, queue, {
    maxConcurrent: 2,
    pollIntervalMs: 25,
    leaseMs: 1_000,
  });
  const compiler = new ContractSourceCompiler(conductor.workspaces, profiles);
  const sources = new ContractSourceService(compiler, dispatcher, store);

  try {
    const scan = {
      repositoryPath: repository.root,
      allowedAdapterIds: ["source-fixture"],
    };
    const compiled = await sources.compile(scan);
    expect(compiled.contracts.map((contract) => contract.id)).toEqual([
      "combat.attack",
      "combat.damage",
    ]);
    expect(compiled.contracts[0]!.source).toMatchObject({
      path: "gameplay.ts",
      line: 2,
    });

    const run = await sources.compileAndEnqueue(scan);
    expect(run.enqueued).toHaveLength(2);
    expect(run.enqueued[1]!.dependsOnJobIds).toEqual([run.enqueued[0]!.jobId]);
    expect(
      JSON.parse(
        await readFile(
          path.join(dataRoot, "source-runs", run.runId, "manifest.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ runId: run.runId, revision: run.revision });

    const completed = await dispatcher.runUntilIdle();
    expect(completed.every((item) => item.status === "completed")).toBe(true);

    const replay = await sources.compileAndEnqueue(scan);
    expect(replay).toEqual(run);

    await writeFile(
      sourcePath,
      "// uncommitted text must not be scanned\n",
      "utf8",
    );
    const frozen = await sources.compile(scan);
    expect(frozen.contracts).toHaveLength(2);

    await writeFile(sourcePath, gameplayContracts(), "utf8");
    const watches = new SourceWatchStore(store);
    const poller = new ContractSourcePoller(sources, watches, 1_000);
    const registered = await watches.register({
      ...scan,
      watchId: "gameplay-watch",
    });
    expect(registered.created).toBe(true);
    await poller.pollOnce();
    const firstPoll = await watches.read("gameplay-watch");
    expect(firstPoll.lastRevision).toBe(run.revision);
    expect(firstPoll.lastRunId).toBe(run.runId);
    expect(await queue.list()).toHaveLength(2);
    await poller.pollOnce();
    expect(await queue.list()).toHaveLength(2);

    await writeFile(
      sourcePath,
      gameplayContracts().replace(
        "Implement the basic attack calculation.",
        "Implement the revised basic attack calculation.",
      ),
      "utf8",
    );
    await command("git", ["add", "gameplay.ts"], repository.root);
    await command(
      "git",
      ["commit", "-m", "revise gameplay contract"],
      repository.root,
    );
    await poller.pollOnce();
    const revisedPoll = await watches.read("gameplay-watch");
    expect(revisedPoll.lastRevision).not.toBe(run.revision);
    expect(await queue.list()).toHaveLength(4);
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("rejects duplicate, missing, cyclic, and unauthorized source contracts", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-source-invalid-"),
  );
  const store = new ArtifactStore(dataRoot);
  const compiler = new ContractSourceCompiler(
    new GitWorkspaceManager(store.workspaceRoot()),
  );

  try {
    await writeFile(
      path.join(repository.root, "invalid.ts"),
      contractBlock({
        id: "bad",
        objective: "Not authorized",
        adapterId: "forbidden-adapter",
        dependsOn: [],
      }),
      "utf8",
    );
    await command("git", ["add", "invalid.ts"], repository.root);
    await command("git", ["commit", "-m", "invalid contract"], repository.root);
    await expect(
      compiler.compile({
        repositoryPath: repository.root,
        allowedAdapterIds: ["allowed-adapter"],
      }),
    ).rejects.toThrow("not allowed by scan policy");

    await writeFile(
      path.join(repository.root, "invalid.ts"),
      contractBlock({
        id: "missing",
        objective: "Missing dependency",
        adapterId: "allowed-adapter",
        dependsOn: ["absent"],
      }),
      "utf8",
    );
    await command("git", ["add", "invalid.ts"], repository.root);
    await command(
      "git",
      ["commit", "-m", "missing dependency"],
      repository.root,
    );
    await expect(
      compiler.compile({
        repositoryPath: repository.root,
        allowedAdapterIds: ["allowed-adapter"],
      }),
    ).rejects.toThrow("depends on missing absent");

    await writeFile(
      path.join(repository.root, "invalid.ts"),
      `${contractBlock({
        id: "cycle-a",
        objective: "Cycle A",
        adapterId: "allowed-adapter",
        dependsOn: ["cycle-b"],
      })}${contractBlock({
        id: "cycle-b",
        objective: "Cycle B",
        adapterId: "allowed-adapter",
        dependsOn: ["cycle-a"],
      })}`,
      "utf8",
    );
    await command("git", ["add", "invalid.ts"], repository.root);
    await command(
      "git",
      ["commit", "-m", "cyclic dependency"],
      repository.root,
    );
    await expect(
      compiler.compile({
        repositoryPath: repository.root,
        allowedAdapterIds: ["allowed-adapter"],
      }),
    ).rejects.toThrow("dependency cycle");

    await writeFile(
      path.join(repository.root, "invalid.ts"),
      `${contractBlock({
        id: "duplicate",
        objective: "First",
        adapterId: "allowed-adapter",
      })}${contractBlock({
        id: "duplicate",
        objective: "Second",
        adapterId: "allowed-adapter",
      })}`,
      "utf8",
    );
    await command("git", ["add", "invalid.ts"], repository.root);
    await command(
      "git",
      ["commit", "-m", "duplicate contract"],
      repository.root,
    );
    await expect(
      compiler.compile({
        repositoryPath: repository.root,
        allowedAdapterIds: ["allowed-adapter"],
      }),
    ).rejects.toThrow("Duplicate contract id duplicate");
  } finally {
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

class SourceFixtureAdapter implements WorkerAdapter {
  readonly description = {
    id: "source-fixture",
    label: "Source fixture",
    executable: process.execPath,
    mutationMode: "worktree" as const,
    outputFormat: "jsonl" as const,
    safetyMode: "test-fixture",
    available: true,
  };

  buildInvocation(contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: [fixture, workspacePath, String(contract.worker.options.delayMs)],
      cwd: workspacePath,
    };
  }
}

function gameplayContracts(): string {
  return `export class CombatSystem {
  /* @conductor-contract
  {
    "id": "combat.attack",
    "objective": "Implement the basic attack calculation.",
    "adapterId": "source-fixture",
    "adapterOptions": { "delayMs": 50 },
    "scope": { "allowedPaths": ["generated.txt"] },
    "acceptance": [{ "profile": "generated-exists" }],
    "dependsOn": []
  }
  @end-conductor-contract */
  attack() {}

  /* @conductor-contract
  {
    "id": "combat.damage",
    "objective": "Implement damage application after attack calculation.",
    "adapterId": "source-fixture",
    "adapterOptions": { "delayMs": 10 },
    "scope": { "allowedPaths": ["generated.txt"] },
    "acceptance": [{ "profile": "generated-exists" }],
    "dependsOn": ["combat.attack"]
  }
  @end-conductor-contract */
  damage() {}
}
export const markerText = "@conductor-contract";
`;
}

function contractBlock(value: object): string {
  return `/* @conductor-contract\n${JSON.stringify(
    {
      scope: { allowedPaths: ["generated.txt"] },
      acceptance: [{ profile: "test" }],
      ...value,
    },
    null,
    2,
  )}\n@end-conductor-contract */\n`;
}
