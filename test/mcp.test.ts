import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JobContract } from "../src/contracts/job.js";
import { createMcpServer } from "../src/mcp/server.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import { DurableDispatcher } from "../src/queue/dispatcher.js";
import { QueueStore } from "../src/queue/queue-store.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import type { WorkerAdapter } from "../src/workers/adapter.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";
import { createTestRepository } from "./helpers.js";

test("publishes the provider-neutral MCP tool contract", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "conductor-mcp-"));
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([]),
  );
  const server = createMcpServer(conductor);
  const client = new Client({ name: "conductor-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_attempt",
      "cancel_queued_job",
      "enqueue_coding_job",
      "enqueue_contract_sources",
      "get_attempt",
      "get_queue_item",
      "get_review_bundle",
      "get_verification",
      "list_contract_watches",
      "list_queue",
      "list_worker_adapters",
      "poll_contract_watches",
      "read_attempt_artifact",
      "register_contract_watch",
      "remove_attempt_workspace",
      "retry_queued_job",
      "scan_contract_sources",
      "set_contract_watch",
      "submit_coding_job",
      "wait_for_attempt",
    ]);
    const response = await client.callTool({
      name: "list_worker_adapters",
      arguments: {},
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual({ adapters: [] });
  } finally {
    await client.close();
    await server.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("submit_coding_job hands work to the owned dispatcher", async () => {
  const repository = await createTestRepository();
  const dataRoot = await mkdtemp(
    path.join(os.tmpdir(), "conductor-mcp-submit-"),
  );
  const store = new ArtifactStore(dataRoot);
  const conductor = new Conductor(
    store,
    new GitWorkspaceManager(store.workspaceRoot()),
    new WorkerRegistry([new McpFixtureAdapter()]),
  );
  const queue = new QueueStore(store);
  const dispatcher = new DurableDispatcher(conductor, queue, {
    pollIntervalMs: 25,
    leaseMs: 1_000,
    ownerId: "mcp-submit-test",
  });
  const server = createMcpServer(conductor, dispatcher);
  const client = new Client({ name: "conductor-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await dispatcher.start();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const request = {
      objective: "Create a proposal through the dispatcher-owned MCP path",
      repositoryPath: repository.root,
      adapterId: "mcp-fixture",
      idempotencyKey: "mcp-dispatch-submission",
      scope: { allowedPaths: ["generated.txt"] },
    };
    const submitted = await client.callTool({
      name: "submit_coding_job",
      arguments: request,
    });
    const body = submitted.structuredContent as {
      item: { jobId: string; attemptId?: string; dispatchOperationId?: string };
      idempotentReplay: boolean;
    };
    expect(body.idempotentReplay).toBe(false);
    expect(body.item.attemptId).toBeTruthy();
    expect(body.item.dispatchOperationId).toBeTruthy();
    const attempt = await conductor.getAttempt(body.item.attemptId!);
    expect(attempt.dispatchOperationId).toBe(body.item.dispatchOperationId);

    const completed = await conductor.waitForAttempt(body.item.attemptId!);
    expect(completed.status).toBe("completed");
    const replay = await client.callTool({
      name: "submit_coding_job",
      arguments: request,
    });
    expect(
      (replay.structuredContent as { idempotentReplay: boolean })
        .idempotentReplay,
    ).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await dispatcher.stop({ cancelActive: true });
    await rm(repository.root, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}, 10_000);

class McpFixtureAdapter implements WorkerAdapter {
  readonly description = {
    id: "mcp-fixture",
    label: "MCP fixture",
    executable: process.execPath,
    mutationMode: "worktree" as const,
    outputFormat: "jsonl" as const,
    safetyMode: "test-fixture",
    available: true,
  };

  buildInvocation(_contract: JobContract, workspacePath: string) {
    return {
      executable: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync('generated.txt', 'mcp proposal\\n')",
      ],
      cwd: workspacePath,
    };
  }
}
