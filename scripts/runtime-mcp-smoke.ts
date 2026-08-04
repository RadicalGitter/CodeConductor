import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dir, "..");
const dataRoot = await mkdtemp(
  path.join(os.tmpdir(), "conductor-runtime-mcp-"),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", path.join(root, "src", "cli.ts")],
  cwd: root,
  env: {
    ...getDefaultEnvironment(),
    CONDUCTOR_DATA_DIR: dataRoot,
  },
  stderr: "pipe",
});
const client = new Client({
  name: "conductor-runtime-smoke",
  version: "1.0.0",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const required = [
    "register_contract_watch",
    "list_queue",
    "get_review_bundle",
    "cancel_queued_job",
  ];
  for (const name of required) {
    if (!tools.tools.some((tool) => tool.name === name)) {
      throw new Error(`Runtime MCP tool is missing: ${name}`);
    }
  }
  const adapters = textJson(
    await client.callTool({ name: "list_worker_adapters", arguments: {} }),
  ) as { adapters?: Array<{ id?: string; available?: boolean }> };
  const kode = adapters.adapters?.find((adapter) => adapter.id === "kode");
  if (!kode?.available) throw new Error("Kode adapter is unavailable");
  const queue = textJson(
    await client.callTool({ name: "list_queue", arguments: {} }),
  ) as { items?: unknown[] };
  const watches = textJson(
    await client.callTool({ name: "list_contract_watches", arguments: {} }),
  ) as { watches?: unknown[] };
  console.log(
    JSON.stringify(
      {
        schema: "conductor.runtime-mcp-smoke/v1",
        connected: true,
        toolCount: tools.tools.length,
        kodeAvailable: true,
        queueItems: queue.items?.length ?? 0,
        watches: watches.watches?.length ?? 0,
        cleanShutdownRequested: true,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
}

function textJson(result: unknown): unknown {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text JSON");
  return JSON.parse(text) as unknown;
}
