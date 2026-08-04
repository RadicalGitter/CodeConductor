import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMcpServer } from "../src/mcp/server.js";
import { Conductor } from "../src/orchestrator/conductor.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { WorkerRegistry } from "../src/workers/adapter.js";
import { GitWorkspaceManager } from "../src/workspaces/git-workspace.js";

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
