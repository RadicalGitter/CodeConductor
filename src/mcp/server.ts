import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import { CONDUCTOR_VERSION } from "../index.js";
import { jobRequestSchema } from "../contracts/job.js";
import { Conductor } from "../orchestrator/conductor.js";

export function createMcpServer(conductor: Conductor): McpServer {
  const server = new McpServer({
    name: "conductor",
    version: CONDUCTOR_VERSION,
  });

  server.registerTool(
    "list_worker_adapters",
    {
      title: "List worker adapters",
      description:
        "List the external coding harness adapters configured in this Conductor process.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => toolResult({ adapters: conductor.workers.list() }),
  );

  server.registerTool(
    "submit_coding_job",
    {
      title: "Submit isolated coding job",
      description:
        "Freeze a proposal-only job at an exact Git revision, reserve an isolated worktree attempt, and start its worker asynchronously.",
      inputSchema: jobRequestSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (input) => toolResult(await conductor.submitJob(input)),
  );

  server.registerTool(
    "get_attempt",
    {
      title: "Get coding attempt",
      description:
        "Read the durable manifest and artifact references for one attempt.",
      inputSchema: { attemptId: z.string().min(1) },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ attemptId }) => toolResult(await conductor.getAttempt(attemptId)),
  );

  server.registerTool(
    "wait_for_attempt",
    {
      title: "Wait for coding attempt",
      description:
        "Wait for an attempt owned by this Conductor process to finish, or read its durable state after restart.",
      inputSchema: { attemptId: z.string().min(1) },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ attemptId }) =>
      toolResult(await conductor.waitForAttempt(attemptId)),
  );

  server.registerTool(
    "cancel_attempt",
    {
      title: "Cancel coding attempt",
      description:
        "Request cancellation of an active attempt and its complete subprocess tree. Returns false if this process no longer owns an active execution.",
      inputSchema: { attemptId: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ attemptId }) =>
      toolResult({
        attemptId,
        cancellationRequested: conductor.cancelAttempt(attemptId),
      }),
  );

  server.registerTool(
    "remove_attempt_workspace",
    {
      title: "Remove attempt worktree",
      description:
        "Remove the exact retained Git worktree recorded for a terminal attempt. Canonical repository state is not changed.",
      inputSchema: { attemptId: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ attemptId }) =>
      toolResult(await conductor.removeAttemptWorkspace(attemptId)),
  );

  return server;
}

function toolResult(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}
