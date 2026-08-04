#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createConductorFromEnvironment } from "./mcp/runtime.js";
import { createMcpServer } from "./mcp/server.js";

const conductor = createConductorFromEnvironment();
await conductor.store.initialize();
const server = createMcpServer(conductor);
await server.connect(new StdioServerTransport());
