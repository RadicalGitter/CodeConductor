import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import { CONDUCTOR_VERSION } from "../index.js";
import { jobRequestSchema } from "../contracts/job.js";
import {
  queuedJobRequestSchema,
  queueItemStatusSchema,
} from "../contracts/queue.js";
import { Conductor } from "../orchestrator/conductor.js";
import { DurableDispatcher } from "../queue/dispatcher.js";
import { QueueStore } from "../queue/queue-store.js";
import { sourceScanRequestSchema } from "../contracts/source.js";
import { ContractSourceCompiler } from "../sources/compiler.js";
import { ContractSourceService } from "../sources/service.js";
import { ContractSourcePoller } from "../sources/poller.js";
import { SourceWatchStore } from "../sources/watch-store.js";
import { sourceWatchRequestSchema } from "../contracts/source.js";

export function createMcpServer(
  conductor: Conductor,
  dispatcher = new DurableDispatcher(
    conductor,
    new QueueStore(conductor.store),
  ),
  sources = new ContractSourceService(
    new ContractSourceCompiler(conductor.workspaces),
    dispatcher,
    conductor.store,
  ),
  poller = new ContractSourcePoller(
    sources,
    new SourceWatchStore(conductor.store),
  ),
): McpServer {
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
    "enqueue_coding_job",
    {
      title: "Enqueue durable coding job",
      description:
        "Freeze a proposal-only job and place it in the durable dependency-aware queue. The single-owner dispatcher runs it when capacity and dependencies permit.",
      inputSchema: queuedJobRequestSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (input) => toolResult(await dispatcher.enqueue(input)),
  );

  server.registerTool(
    "scan_contract_sources",
    {
      title: "Scan source-authored contracts",
      description:
        "Compile enabled @conductor-contract JSON blocks from tracked files at an exact Git revision. This is read-only and does not enqueue workers.",
      inputSchema: sourceScanRequestSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => toolResult(await sources.compile(input)),
  );

  server.registerTool(
    "enqueue_contract_sources",
    {
      title: "Enqueue source-authored contracts",
      description:
        "Compile validated source contracts, resolve owner-side command profiles, persist a source-run manifest, and enqueue the dependency graph as proposal-only jobs.",
      inputSchema: sourceScanRequestSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (input) => toolResult(await sources.compileAndEnqueue(input)),
  );

  server.registerTool(
    "register_contract_watch",
    {
      title: "Register contract-source watch",
      description:
        "Persist a scan policy for automatic exact-revision contract discovery. Registration grants proposal-queue authority only; it cannot accept or merge output.",
      inputSchema: sourceWatchRequestSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (input) => toolResult(await poller.watches.register(input)),
  );

  server.registerTool(
    "list_contract_watches",
    {
      title: "List contract-source watches",
      description:
        "Read persisted watch policies, last successful revisions, source-run ids, and scan errors.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => toolResult({ watches: await poller.watches.list() }),
  );

  server.registerTool(
    "set_contract_watch",
    {
      title: "Enable or disable contract-source watch",
      description:
        "Enable or disable one persisted source watch without deleting its history.",
      inputSchema: {
        watchId: z.string().min(1),
        enabled: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ watchId, enabled }) => {
      const watch = await poller.watches.read(watchId);
      return toolResult(await poller.watches.update(watch, { enabled }));
    },
  );

  server.registerTool(
    "poll_contract_watches",
    {
      title: "Poll contract-source watches now",
      description:
        "Run one immediate scan cycle. Each watch enqueues at most once per newly observed exact revision.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      await poller.pollOnce();
      return toolResult({ watches: await poller.watches.list() });
    },
  );

  server.registerTool(
    "list_queue",
    {
      title: "List durable queue",
      description:
        "List compact queue records, dependency state, attempt identity, and completion artifact pointers without reading worker transcripts.",
      inputSchema: {
        statuses: z.array(queueItemStatusSchema).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ statuses }) => {
      const items = await dispatcher.list();
      return toolResult({
        items: statuses
          ? items.filter((item) => statuses.includes(item.status))
          : items,
      });
    },
  );

  server.registerTool(
    "get_queue_item",
    {
      title: "Get queued coding job",
      description: "Read one durable queue and compact completion record.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ jobId }) => toolResult(await dispatcher.get(jobId)),
  );

  server.registerTool(
    "cancel_queued_job",
    {
      title: "Cancel queued coding job",
      description:
        "Cancel a waiting queue item or request cancellation of its active attempt process tree.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ jobId }) => toolResult(await dispatcher.cancel(jobId)),
  );

  server.registerTool(
    "retry_queued_job",
    {
      title: "Retry queued coding job",
      description:
        "Move a terminal queue item back to queued state. A retry creates a new attempt and preserves earlier evidence.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ jobId }) => toolResult(await dispatcher.retry(jobId)),
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
    "get_verification",
    {
      title: "Get deterministic verification",
      description:
        "Read the typed setup, path-scope, acceptance-command, proposal-stability, and review-eligibility evidence for one attempt.",
      inputSchema: { attemptId: z.string().min(1) },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ attemptId }) =>
      toolResult(await conductor.getVerification(attemptId)),
  );

  server.registerTool(
    "get_review_bundle",
    {
      title: "Get hash-bound review bundle",
      description:
        "Create or read a durable advisory review packet bound to the frozen contract and evidence hashes, plus a bounded proposal patch. This does not accept, merge, or mutate project state.",
      inputSchema: {
        attemptId: z.string().min(1),
        maxPatchBytes: z.number().int().min(1).max(1_000_000).default(500_000),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ attemptId, maxPatchBytes }) =>
      toolResult(await conductor.getReviewBundle(attemptId, maxPatchBytes)),
  );

  server.registerTool(
    "read_attempt_artifact",
    {
      title: "Read bounded attempt artifact",
      description:
        "Read at most one million bytes from one named artifact recorded in an attempt manifest. Arbitrary filesystem paths are not accepted.",
      inputSchema: {
        attemptId: z.string().min(1),
        name: z.enum([
          "job",
          "manifest",
          "stdout",
          "stderr",
          "proposalPatch",
          "repositoryStatus",
          "changedPaths",
          "verification",
        ]),
        maxBytes: z.number().int().min(1).max(1_000_000).default(200_000),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ attemptId, name, maxBytes }) =>
      toolResult(
        await conductor.readAttemptArtifact(attemptId, name, maxBytes),
      ),
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
