#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createConductorRuntimeFromEnvironment } from "./mcp/runtime.js";
import { createMcpServer } from "./mcp/server.js";

const { conductor, queue, dispatcher } =
  createConductorRuntimeFromEnvironment();
await conductor.store.initialize();
await queue.initialize();
await dispatcher.start();
const server = createMcpServer(conductor, dispatcher);
await server.connect(new StdioServerTransport());

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await dispatcher.stop();
  await server.close();
}

process.stdin.once("end", () => void close());
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
