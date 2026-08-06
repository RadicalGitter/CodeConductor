import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";

import {
  attemptManifestSchema,
  type AttemptManifest,
} from "../contracts/attempt.js";
import {
  attemptCleanupRecordSchema,
  type AttemptCleanupRecord,
} from "../contracts/cleanup.js";
import {
  canonicalJson,
  fingerprint,
  jobContractSchema,
  type JobContract,
} from "../contracts/job.js";
import {
  verificationRecordSchema,
  type VerificationRecord,
} from "../verification/types.js";
import { sha256File } from "./hash.js";
import { validateWorkerExecutionProfile } from "./worker-profile.js";

export { sha256File } from "./hash.js";

const evidencePurposeSchema = z.enum([
  "job",
  "attempt",
  "cleanup",
  "proposal-patch",
  "repository-status",
  "changed-paths",
  "verification",
  "worker-stdout",
  "worker-stderr",
  "command-stdout",
  "command-stderr",
  "lineage-patch",
  "lineage-verification",
  "worker-executable",
  "worker-harness",
  "worker-configuration",
]);

const evidenceBindingSchema = z.object({
  path: z.string().min(1),
  purposes: z.array(evidencePurposeSchema).min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const inventoryEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    path: z.string().min(1),
    kind: z.literal("directory"),
  }),
  z.object({
    path: z.string().min(1),
    kind: z.literal("file"),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

const reviewerContractSchema = z.object({
  allowedOutcomes: z.array(z.enum(["pass", "fail", "needs-context"])),
  requiredFindingFields: z.array(z.string()),
  instructions: z.array(z.string()),
});

export const reviewPacketSchema = z.object({
  schema: z.literal("conductor.review-packet/v2"),
  sealedAt: z.string().datetime(),
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  authority: z.literal("advisory-review-only"),
  contract: jobContractSchema,
  attempt: attemptManifestSchema,
  cleanup: attemptCleanupRecordSchema,
  verification: verificationRecordSchema,
  changedPaths: z.array(z.string()),
  bindings: z.array(evidenceBindingSchema).min(1),
  attemptInventory: z.array(inventoryEntrySchema),
  reviewerContract: reviewerContractSchema,
  sealSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ReviewPacket = z.infer<typeof reviewPacketSchema>;

export interface ReviewEvidenceState {
  contract: JobContract;
  manifest: AttemptManifest;
  cleanup: AttemptCleanupRecord;
  verification: VerificationRecord;
  changedPaths: string[];
  attemptDirectory: string;
  jobPath: string;
}

export type ReviewArtifactPathState = Pick<
  ReviewEvidenceState,
  "manifest" | "attemptDirectory" | "jobPath"
>;

export class ReviewEvidenceError extends Error {
  constructor(
    readonly kind:
      "unavailable" | "corrupt" | "legacy-unsealed" | "profile-unresolved",
    message: string,
  ) {
    super(message);
    this.name = "ReviewEvidenceError";
  }
}

export async function buildReviewPacket(
  input: ReviewEvidenceState & { now?: Date },
): Promise<ReviewPacket> {
  await assertReviewEvidenceState(input);
  const reviewerContract = createReviewerContract();
  const unsigned = {
    schema: "conductor.review-packet/v2" as const,
    sealedAt: (input.now ?? new Date(input.manifest.finishedAt!)).toISOString(),
    jobId: input.manifest.jobId,
    attemptId: input.manifest.attemptId,
    authority: "advisory-review-only" as const,
    contract: input.contract,
    attempt: input.manifest,
    cleanup: input.cleanup,
    verification: input.verification,
    changedPaths: input.changedPaths,
    bindings: await collectEvidenceBindings(input),
    attemptInventory: await collectAttemptInventory(input.attemptDirectory),
    reviewerContract,
  };
  return reviewPacketSchema.parse({
    ...unsigned,
    sealSha256: fingerprint(unsigned),
  });
}

export async function validateReviewPacket(
  packet: ReviewPacket,
  state: ReviewEvidenceState,
): Promise<void> {
  const parsed = reviewPacketSchema.parse(packet);
  const { sealSha256, ...unsigned } = parsed;
  if (fingerprint(unsigned) !== sealSha256) {
    throw new ReviewEvidenceError(
      "corrupt",
      `Review packet seal changed for ${parsed.attemptId}`,
    );
  }
  await assertReviewEvidenceState(state);
  const comparisons: Array<[string, unknown, unknown]> = [
    ["job contract", parsed.contract, state.contract],
    ["terminal attempt", parsed.attempt, state.manifest],
    ["cleanup", parsed.cleanup, state.cleanup],
    ["verification", parsed.verification, state.verification],
    ["changed paths", parsed.changedPaths, state.changedPaths],
    ["reviewer contract", parsed.reviewerContract, createReviewerContract()],
  ];
  for (const [name, sealed, current] of comparisons) {
    if (canonicalJson(sealed) !== canonicalJson(current)) {
      throw new ReviewEvidenceError(
        "corrupt",
        `Sealed ${name} changed for ${parsed.attemptId}`,
      );
    }
  }
  if (
    parsed.jobId !== state.manifest.jobId ||
    parsed.attemptId !== state.manifest.attemptId
  ) {
    throw new ReviewEvidenceError(
      "corrupt",
      `Review packet identity changed for ${parsed.attemptId}`,
    );
  }
  await validateBindings(parsed.bindings);
  const inventory = await collectAttemptInventory(state.attemptDirectory);
  if (canonicalJson(inventory) !== canonicalJson(parsed.attemptInventory)) {
    throw new ReviewEvidenceError(
      "corrupt",
      `Attempt evidence inventory changed for ${parsed.attemptId}`,
    );
  }
}

export async function assertReviewEvidenceState(
  state: ReviewEvidenceState,
): Promise<void> {
  const { contract, manifest, cleanup, verification, changedPaths } = state;
  if (
    manifest.status !== "completed" ||
    manifest.verificationStatus !== "eligible" ||
    !verification.eligibleForReview
  ) {
    throw new ReviewEvidenceError(
      "unavailable",
      `Attempt ${manifest.attemptId} is not eligible for review`,
    );
  }
  if (cleanup.status !== "not-required" && cleanup.status !== "proven") {
    throw new ReviewEvidenceError(
      "unavailable",
      `Attempt ${manifest.attemptId} cleanup is ${cleanup.status}`,
    );
  }
  if (!manifest.workerProfile) {
    throw new ReviewEvidenceError(
      "legacy-unsealed",
      `Attempt ${manifest.attemptId} has no launch-time worker profile`,
    );
  }
  if (manifest.workerProfile.status !== "complete") {
    throw new ReviewEvidenceError(
      "profile-unresolved",
      `Attempt ${manifest.attemptId} worker profile is unresolved: ${manifest.workerProfile.unresolvedReasons.join("; ")}`,
    );
  }
  try {
    await validateWorkerExecutionProfile(manifest.workerProfile);
  } catch (error) {
    throw new ReviewEvidenceError(
      "corrupt",
      `Worker profile validation failed for ${manifest.attemptId}: ${errorMessage(error)}`,
    );
  }
  if (!manifest.invocation) {
    throw new ReviewEvidenceError(
      "corrupt",
      `Attempt ${manifest.attemptId} has no persisted invocation`,
    );
  }
  const requestedModel = contract.worker.options.model;
  const modelSelector =
    typeof requestedModel === "string" && requestedModel.trim()
      ? requestedModel
      : undefined;
  if (
    manifest.workerProfile.adapter.id !== contract.worker.adapterId ||
    manifest.workerProfile.adapterOptionsFingerprint !==
      fingerprint(contract.worker.options) ||
    manifest.workerProfile.invocationFingerprint !==
      fingerprint(manifest.invocation) ||
    (modelSelector !== undefined &&
      manifest.workerProfile.modelSelector !== modelSelector) ||
    (manifest.workerProfile.adapter.modelIdentity === "required" &&
      manifest.workerProfile.modelSelector === undefined)
  ) {
    throw new ReviewEvidenceError(
      "corrupt",
      `Worker profile disagrees with contract or invocation for ${manifest.attemptId}`,
    );
  }
  if (
    contract.jobId !== manifest.jobId ||
    cleanup.jobId !== manifest.jobId ||
    cleanup.attemptId !== manifest.attemptId ||
    verification.jobId !== manifest.jobId ||
    verification.attemptId !== manifest.attemptId
  ) {
    throw new ReviewEvidenceError(
      "corrupt",
      `Review evidence identity mismatch for ${manifest.attemptId}`,
    );
  }
  if (
    canonicalJson(changedPaths) !==
    canonicalJson(verification.scope.changedPaths)
  ) {
    throw new ReviewEvidenceError(
      "corrupt",
      `Changed-path and verification evidence disagree for ${manifest.attemptId}`,
    );
  }
  assertReviewArtifactPaths(state);
  await validateProjection("job contract", state.jobPath, contract);
  await validateProjection(
    "attempt manifest",
    manifest.artifacts.manifest,
    manifest,
  );
  await validateProjection(
    "cleanup record",
    manifest.artifacts.cleanup!,
    cleanup,
  );
  await validateProjection(
    "verification record",
    manifest.artifacts.verification,
    verification,
  );
  await validateProjection(
    "changed paths",
    manifest.artifacts.changedPaths,
    changedPaths,
  );
}

export function assertReviewArtifactPaths(
  state: ReviewArtifactPathState,
): void {
  const directory = path.resolve(state.attemptDirectory);
  const expected = {
    job: path.resolve(state.jobPath),
    manifest: path.join(directory, "attempt.json"),
    stdout: path.join(directory, "stdout.log"),
    stderr: path.join(directory, "stderr.log"),
    proposalPatch: path.join(directory, "proposal.patch"),
    repositoryStatus: path.join(directory, "repository-status.txt"),
    changedPaths: path.join(directory, "changed-paths.json"),
    verification: path.join(directory, "verification.json"),
    cleanup: path.join(directory, "cleanup.json"),
  } satisfies Record<keyof AttemptManifest["artifacts"], string>;
  for (const [name, target] of Object.entries(expected)) {
    if (
      path.resolve(
        state.manifest.artifacts[name as keyof AttemptManifest["artifacts"]] ??
          "",
      ) !== target
    ) {
      throw new ReviewEvidenceError(
        "corrupt",
        `Attempt artifact path changed for ${name}`,
      );
    }
  }
}

async function collectEvidenceBindings(
  state: ReviewEvidenceState,
): Promise<ReviewPacket["bindings"]> {
  const requested = new Map<
    string,
    Set<z.infer<typeof evidencePurposeSchema>>
  >();
  const add = (
    target: string | undefined,
    purpose: z.infer<typeof evidencePurposeSchema>,
  ) => {
    if (!target) return;
    const absolute = path.resolve(target);
    const purposes = requested.get(absolute) ?? new Set();
    purposes.add(purpose);
    requested.set(absolute, purposes);
  };
  add(state.jobPath, "job");
  add(state.manifest.artifacts.manifest, "attempt");
  add(state.manifest.artifacts.cleanup, "cleanup");
  add(state.manifest.artifacts.proposalPatch, "proposal-patch");
  add(state.manifest.artifacts.repositoryStatus, "repository-status");
  add(state.manifest.artifacts.changedPaths, "changed-paths");
  add(state.manifest.artifacts.verification, "verification");
  add(state.manifest.artifacts.stdout, "worker-stdout");
  add(state.manifest.artifacts.stderr, "worker-stderr");
  for (const command of [
    ...state.verification.setup.commands,
    ...state.verification.acceptance.commands,
  ]) {
    ensureWithinAttempt(state.attemptDirectory, command.stdout);
    ensureWithinAttempt(state.attemptDirectory, command.stderr);
    add(command.stdout, "command-stdout");
    add(command.stderr, "command-stderr");
  }
  for (const contribution of state.manifest.lineage?.contributions ?? []) {
    add(contribution.patchPath, "lineage-patch");
    add(contribution.verificationPath, "lineage-verification");
  }
  for (const file of state.manifest.workerProfile!.files) {
    add(
      file.path,
      file.role === "executable"
        ? "worker-executable"
        : file.role === "configuration"
          ? "worker-configuration"
          : "worker-harness",
    );
  }

  const bindings: ReviewPacket["bindings"] = [];
  for (const [target, purposes] of [...requested].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    let details;
    try {
      details = await stat(target);
    } catch {
      throw new ReviewEvidenceError(
        "unavailable",
        `Required review evidence is missing: ${target}`,
      );
    }
    if (!details.isFile()) {
      throw new ReviewEvidenceError(
        "corrupt",
        `Required review evidence is not a regular file: ${target}`,
      );
    }
    bindings.push({
      path: target,
      purposes: [...purposes].sort(),
      size: details.size,
      sha256: await sha256File(target),
    });
  }
  return bindings;
}

async function validateBindings(
  bindings: ReviewPacket["bindings"],
): Promise<void> {
  for (const binding of bindings) {
    let details;
    try {
      details = await stat(binding.path);
    } catch {
      throw new ReviewEvidenceError(
        "corrupt",
        `Sealed review evidence is missing: ${binding.path}`,
      );
    }
    if (
      !details.isFile() ||
      details.size !== binding.size ||
      (await sha256File(binding.path)) !== binding.sha256
    ) {
      throw new ReviewEvidenceError(
        "corrupt",
        `Sealed review evidence changed: ${binding.path}`,
      );
    }
  }
}

async function collectAttemptInventory(
  attemptDirectory: string,
): Promise<ReviewPacket["attemptInventory"]> {
  const root = path.resolve(attemptDirectory);
  const entries: ReviewPacket["attemptInventory"] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const target = path.join(directory, child.name);
      const relative = path.relative(root, target).replaceAll("\\", "/");
      if (relative === "review-packet.json") continue;
      if (child.isSymbolicLink()) {
        throw new ReviewEvidenceError(
          "corrupt",
          `Symbolic links are prohibited in sealed attempt evidence: ${relative}`,
        );
      }
      if (child.isDirectory()) {
        entries.push({ path: relative, kind: "directory" });
        await visit(target);
      } else if (child.isFile()) {
        const details = await stat(target);
        entries.push({
          path: relative,
          kind: "file",
          size: details.size,
          sha256: await sha256File(target),
        });
      } else {
        throw new ReviewEvidenceError(
          "corrupt",
          `Unsupported entry in sealed attempt evidence: ${relative}`,
        );
      }
    }
  };
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function validateProjection(
  name: string,
  target: string,
  expected: unknown,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(target, "utf8")) as unknown;
  } catch (error) {
    throw new ReviewEvidenceError(
      "corrupt",
      `${name} projection is unreadable: ${errorMessage(error)}`,
    );
  }
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new ReviewEvidenceError(
      "corrupt",
      `${name} projection disagrees with authoritative state`,
    );
  }
}

function ensureWithinAttempt(root: string, target: string | undefined): void {
  if (!target) return;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new ReviewEvidenceError(
      "corrupt",
      `Command evidence escaped its attempt directory: ${target}`,
    );
  }
}

function createReviewerContract(): z.infer<typeof reviewerContractSchema> {
  return {
    allowedOutcomes: ["pass", "fail", "needs-context"],
    requiredFindingFields: ["severity", "path", "line", "claim", "evidence"],
    instructions: [
      "Review the bound proposal patch against the frozen contract and repository evidence.",
      "Treat deterministic verification as evidence, not proof of semantic correctness.",
      "When proposal lineage is present, treat every contribution as unaccepted context and retrieve its hash-bound patch before judging the derived change.",
      "Return fail for any actionable defect and needs-context only when named evidence is missing.",
      "Do not accept, merge, execute, or mutate repository state.",
    ],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
