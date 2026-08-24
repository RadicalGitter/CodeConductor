#!/usr/bin/env bun

import path from "node:path";

import { wakeDshSession } from "../src/dsh-wake.js";
import { createConductorRuntimeFromEnvironment } from "../src/mcp/runtime.js";
import {
  compileSpecificationJob,
  loadSpecProfile,
  readSpecification,
} from "../src/spec-intake.js";
import type { QueueItem } from "../src/contracts/queue.js";

const TERMINAL = new Set(["completed", "failed", "needs-input", "cancelled"]);

const args = parseArgs(process.argv.slice(2));
const specificationPath = path.resolve(requiredOne(args, "spec"));
const specification = await readSpecification(specificationPath);
const { profile, profileFile } = await loadSpecProfile(
  specification.metadata.specification.targetProject,
  args.values.get("profile-file")?.[0],
);
const request = compileSpecificationJob(specification, profile, {
  parentJobIds: args.values.get("parent-job") ?? [],
  findings: args.values.get("finding") ?? [],
});

if (args.flags.has("dry-run")) {
  print({
    schema: "conductor.contract-from-spec-plan/v1",
    specificationPath,
    specificationHash: specification.hash,
    profileFile,
    targetProject: specification.metadata.specification.targetProject,
    request,
  });
  process.exit(0);
}

const runtime = createConductorRuntimeFromEnvironment();
await runtime.conductor.store.initialize();
await runtime.queue.initialize();
let ownsDispatcher = false;
try {
  try {
    await runtime.dispatcher.start();
    ownsDispatcher = true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Another Conductor dispatcher owns the queue"
    ) {
      throw error;
    }
  }

  const submitted = await runtime.dispatcher.enqueue(request);
  print({
    schema: "conductor.contract-from-spec-start/v1",
    specificationPath,
    specificationHash: specification.hash,
    profileFile,
    jobId: submitted.item.jobId,
    status: submitted.item.status,
    idempotentReplay: submitted.idempotentReplay,
    watcher: {
      sessionId: process.env.DSH_SESSION_ID,
      webUrl: process.env.DSH_WEB_URL,
    },
  });

  const terminal = await waitForTerminal(
    runtime.dispatcher,
    submitted.item.jobId,
  );
  const review = await prepareReview(runtime, terminal);
  const completion = {
    schema: "conductor.contract-from-spec-finish/v1",
    specificationPath,
    specificationHash: specification.hash,
    jobId: terminal.jobId,
    status: terminal.status,
    attemptId: terminal.attemptId,
    completion: terminal.completion,
    review,
  };
  print(completion);

  const sessionId = process.env.DSH_SESSION_ID;
  if (sessionId !== undefined && !args.flags.has("no-wake")) {
    const webUrl = process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080";
    await wakeWithRetry({
      webUrl,
      sessionId,
      text: completionPrompt(completion),
    });
  }
} finally {
  if (ownsDispatcher) await runtime.dispatcher.stop();
}

async function waitForTerminal(
  dispatcher: typeof runtime.dispatcher,
  jobId: string,
): Promise<QueueItem> {
  for (;;) {
    const item = await dispatcher.get(jobId);
    if (TERMINAL.has(item.status)) return item;
    await Bun.sleep(2_000);
  }
}

async function prepareReview(
  currentRuntime: typeof runtime,
  item: QueueItem,
): Promise<
  | {
      ready: true;
      packetPath: string;
      proposalPatchPath: string;
      changedPaths: string[];
      verificationStatus: string;
      sealSha256: string;
    }
  | { ready: false; reason: string }
> {
  if (item.attemptId === undefined) {
    return { ready: false, reason: "Terminal queue item has no attempt" };
  }
  try {
    const bundle = await currentRuntime.conductor.getReviewBundle(
      item.attemptId,
    );
    return {
      ready: true,
      packetPath: path.join(
        path.dirname(bundle.packet.attempt.artifacts.manifest),
        "review-packet.json",
      ),
      proposalPatchPath: bundle.patch.path,
      changedPaths: bundle.packet.changedPaths,
      verificationStatus: bundle.packet.verification.eligibleForReview
        ? "eligible"
        : "ineligible",
      sealSha256: bundle.packet.sealSha256,
    };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function completionPrompt(completion: {
  specificationPath: string;
  jobId: string;
  status: string;
  attemptId?: string;
  completion?: QueueItem["completion"];
  review: Awaited<ReturnType<typeof prepareReview>>;
}): string {
  const review = completion.review.ready
    ? `Sealed review packet: ${completion.review.packetPath}\nProposal patch: ${completion.review.proposalPatchPath}\nChanged paths: ${completion.review.changedPaths.join(", ") || "none"}\nVerification: ${completion.review.verificationStatus}\nReview seal: ${completion.review.sealSha256}`
    : `Review bundle is unavailable: ${completion.review.reason}`;
  return `<conductor-watcher-return schema="v1">\nJob ${completion.jobId} reached ${completion.status}.\nAttempt: ${completion.attemptId ?? "none"}\nAuthoritative specification: ${completion.specificationPath}\n${review}\n\nReview the actual proposal and deterministic evidence now. If issues remain, create a bounded correction with the same specification, --parent-job ${completion.jobId}, and one --finding argument per independent finding; that command arms the next watcher. Do not create a persistent goal and do not actively wait after arming it.\n</conductor-watcher-return>`;
}

async function wakeWithRetry(input: {
  webUrl: string;
  sessionId: string;
  text: string;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await wakeDshSession(input);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await Bun.sleep(attempt * 1_000);
    }
  }
  throw lastError;
}

interface ParsedArgs {
  values: Map<string, string[]>;
  flags: Set<string>;
}

function parseArgs(tokens: string[]): ParsedArgs {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--"))
      throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === "dry-run" || name === "no-wake") {
      flags.add(name);
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    values.set(name, [...(values.get(name) ?? []), value]);
    index += 1;
  }
  return { values, flags };
}

function requiredOne(args: ParsedArgs, name: string): string {
  const values = args.values.get(name);
  if (values?.length !== 1 || values[0]!.trim() === "") {
    throw new Error(`Expected exactly one --${name}`);
  }
  return values[0]!;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
