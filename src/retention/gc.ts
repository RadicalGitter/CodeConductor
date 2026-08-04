import { randomUUID } from "node:crypto";
import { access, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod/v4";

import { latestCleanupEvidence } from "../contracts/cleanup.js";
import { fingerprint } from "../contracts/job.js";
import type { Conductor } from "../orchestrator/conductor.js";
import { sha256File } from "../review/packet.js";

export const retentionClassSchema = z.enum([
  "active",
  "reviewable",
  "retained",
  "quarantine",
  "expired",
]);

const gcFileBindingSchema = z.object({
  relativePath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const gcCandidateSchema = z.object({
  kind: z.enum(["workspace", "attempt-artifacts"]),
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  retentionClass: z.literal("expired"),
  reason: z.string().min(1),
  estimatedBytes: z.number().int().nonnegative(),
  manifestRevision: z.number().int().nonnegative(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cleanupRevision: z.number().int().nonnegative(),
  cleanupSha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(gcFileBindingSchema).default([]),
});

export const gcPlanSchema = z.object({
  schema: z.literal("conductor.gc-plan/v1"),
  planId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  dataRoot: z.string().min(1),
  observations: z.array(
    z.object({
      jobId: z.string().min(1),
      attemptId: z.string().min(1),
      retentionClass: retentionClassSchema,
      detail: z.string().min(1),
    }),
  ),
  candidates: z.array(gcCandidateSchema),
  totalEstimatedBytes: z.number().int().nonnegative(),
  planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const gcApprovalSchema = z.object({
  approvedBy: z.string().min(1),
  approvedAt: z.string().datetime(),
  reason: z.string().min(1),
});

export type GcPlan = z.infer<typeof gcPlanSchema>;
export type GcApproval = z.infer<typeof gcApprovalSchema>;

export class RetentionManager {
  constructor(private readonly conductor: Conductor) {}

  async inspectActions(): Promise<{
    pending: string[];
    failed: string[];
    completed: string[];
  }> {
    const result = {
      pending: [] as string[],
      failed: [] as string[],
      completed: [] as string[],
    };
    const root = path.join(this.conductor.store.root, "gc", "actions");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return result;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(
          await readFile(path.join(root, entry.name), "utf8"),
        ) as { plan?: { planId?: string }; status?: string };
        const id = record.plan?.planId ?? entry.name.slice(0, -5);
        if (record.status === "completed") result.completed.push(id);
        else if (record.status === "failed") result.failed.push(id);
        else result.pending.push(id);
      } catch {
        result.failed.push(entry.name.slice(0, -5));
      }
    }
    result.pending.sort();
    result.failed.sort();
    result.completed.sort();
    return result;
  }

  async dryRun(now = new Date()): Promise<GcPlan> {
    const observations: GcPlan["observations"] = [];
    const candidates: GcPlan["candidates"] = [];
    const attempts = await this.conductor.store.listAttempts();

    for (const manifest of attempts) {
      let contract;
      let cleanup;
      try {
        [contract, cleanup] = await Promise.all([
          this.conductor.store.readJob(manifest.jobId),
          this.conductor.getAttemptCleanup(manifest.attemptId),
        ]);
      } catch (error) {
        observations.push({
          jobId: manifest.jobId,
          attemptId: manifest.attemptId,
          retentionClass: "quarantine",
          detail: `Retention evidence is unreadable: ${errorMessage(error)}`,
        });
        continue;
      }
      const classified = classifyRetention(
        manifest,
        cleanup.status,
        contract,
        now,
      );
      observations.push({
        jobId: manifest.jobId,
        attemptId: manifest.attemptId,
        retentionClass: classified.retentionClass,
        detail: classified.detail,
      });
      if (classified.retentionClass !== "expired") continue;

      const evidence = {
        manifestRevision: manifest.revision,
        manifestSha256: await sha256File(manifest.artifacts.manifest),
        cleanupRevision: cleanup.revision,
        cleanupSha256: await sha256File(
          manifest.artifacts.cleanup ??
            this.conductor.store.attemptCleanupPath(
              manifest.jobId,
              manifest.attemptId,
            ),
        ),
      };
      const workspaceProof = latestCleanupEvidence(cleanup, {
        kind: "workspace",
        id: "worktree",
      });
      if (
        manifest.workspace?.retained &&
        workspaceProof?.status !== "proven" &&
        (await exists(manifest.workspace.path))
      ) {
        candidates.push({
          kind: "workspace",
          jobId: manifest.jobId,
          attemptId: manifest.attemptId,
          retentionClass: "expired",
          reason: `${classified.detail}; retained worktree must be removed before artifacts`,
          estimatedBytes: await directoryBytes(manifest.workspace.path),
          ...evidence,
          files: [],
        });
        continue;
      }
      if (manifest.workspace?.retained && workspaceProof?.status !== "proven") {
        observations[observations.length - 1] = {
          jobId: manifest.jobId,
          attemptId: manifest.attemptId,
          retentionClass: "quarantine",
          detail: "Workspace is absent without positive cleanup evidence",
        };
        continue;
      }

      const files = await collectPrunableFiles(
        this.conductor.store.attemptDirectory(
          manifest.jobId,
          manifest.attemptId,
        ),
      );
      if (files.length === 0) continue;
      candidates.push({
        kind: "attempt-artifacts",
        jobId: manifest.jobId,
        attemptId: manifest.attemptId,
        retentionClass: "expired",
        reason: classified.detail,
        estimatedBytes: files.reduce((total, file) => total + file.bytes, 0),
        ...evidence,
        files,
      });
    }

    const body = {
      schema: "conductor.gc-plan/v1" as const,
      planId: randomUUID(),
      generatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + (await minimumGcTtl(attempts, this.conductor)),
      ).toISOString(),
      dataRoot: this.conductor.store.root,
      observations,
      candidates,
      totalEstimatedBytes: candidates.reduce(
        (total, candidate) => total + candidate.estimatedBytes,
        0,
      ),
    };
    return gcPlanSchema.parse({
      ...body,
      planFingerprint: fingerprint(body),
    });
  }

  async apply(
    inputPlan: unknown,
    inputApproval: unknown,
    now = new Date(),
  ): Promise<{
    schema: "conductor.gc-result/v1";
    planId: string;
    removed: Array<{ kind: string; attemptId: string; bytes: number }>;
    totalRemovedBytes: number;
    completedAt: string;
  }> {
    const plan = gcPlanSchema.parse(inputPlan);
    const approval = gcApprovalSchema.parse(inputApproval);
    assertPlanIntegrity(plan, this.conductor.store.root, now);
    assertApproval(plan, approval, now);
    await this.revalidate(plan);

    const actionPath = path.join(
      this.conductor.store.root,
      "gc",
      "actions",
      `${plan.planId}.json`,
    );
    await this.conductor.store.writeJsonAtomic(actionPath, {
      schema: "conductor.gc-action/v1",
      plan,
      approval,
      status: "approved",
      recordedAt: now.toISOString(),
    });

    const removed: Array<{ kind: string; attemptId: string; bytes: number }> =
      [];
    try {
      for (const candidate of plan.candidates) {
        if (candidate.kind === "workspace") {
          await this.conductor.removeAttemptWorkspace(candidate.attemptId);
        } else {
          const attemptRoot = this.conductor.store.attemptDirectory(
            candidate.jobId,
            candidate.attemptId,
          );
          for (const file of candidate.files) {
            await rm(resolveBoundFile(attemptRoot, file.relativePath));
          }
          await this.conductor.store.writeJsonAtomic(
            path.join(attemptRoot, "gc-tombstone.json"),
            {
              schema: "conductor.gc-tombstone/v1",
              planId: plan.planId,
              planFingerprint: plan.planFingerprint,
              removedAt: now.toISOString(),
              removedFiles: candidate.files,
            },
          );
        }
        removed.push({
          kind: candidate.kind,
          attemptId: candidate.attemptId,
          bytes: candidate.estimatedBytes,
        });
      }
    } catch (error) {
      await this.conductor.store.writeJsonAtomic(actionPath, {
        schema: "conductor.gc-action/v1",
        plan,
        approval,
        status: "failed",
        recordedAt: now.toISOString(),
        removed,
        error: errorMessage(error),
      });
      throw error;
    }
    const result = {
      schema: "conductor.gc-result/v1" as const,
      planId: plan.planId,
      removed,
      totalRemovedBytes: removed.reduce(
        (total, entry) => total + entry.bytes,
        0,
      ),
      completedAt: now.toISOString(),
    };
    await this.conductor.store.writeJsonAtomic(actionPath, {
      schema: "conductor.gc-action/v1",
      plan,
      approval,
      status: "completed",
      recordedAt: now.toISOString(),
      result,
    });
    return result;
  }

  private async revalidate(plan: GcPlan): Promise<void> {
    for (const candidate of plan.candidates) {
      const manifest = await this.conductor.getAttempt(candidate.attemptId);
      const cleanup = await this.conductor.getAttemptCleanup(
        candidate.attemptId,
      );
      if (
        manifest.revision !== candidate.manifestRevision ||
        cleanup.revision !== candidate.cleanupRevision ||
        (await sha256File(manifest.artifacts.manifest)) !==
          candidate.manifestSha256 ||
        (await sha256File(
          manifest.artifacts.cleanup ??
            this.conductor.store.attemptCleanupPath(
              manifest.jobId,
              manifest.attemptId,
            ),
        )) !==
          candidate.cleanupSha256
      ) {
        throw new Error(`GC plan is stale for ${candidate.attemptId}`);
      }
      if (candidate.kind === "workspace") {
        if (!manifest.workspace || !(await exists(manifest.workspace.path))) {
          throw new Error(
            `GC workspace target changed for ${candidate.attemptId}`,
          );
        }
      } else {
        const attemptRoot = this.conductor.store.attemptDirectory(
          candidate.jobId,
          candidate.attemptId,
        );
        for (const file of candidate.files) {
          const target = resolveBoundFile(attemptRoot, file.relativePath);
          if (
            (await stat(target)).size !== file.bytes ||
            (await sha256File(target)) !== file.sha256
          ) {
            throw new Error(
              `GC artifact binding changed: ${candidate.attemptId}/${file.relativePath}`,
            );
          }
        }
      }
    }
  }
}

function classifyRetention(
  manifest: Awaited<ReturnType<Conductor["getAttempt"]>>,
  cleanupStatus: "not-required" | "pending" | "proven" | "failed" | "unknown",
  contract: Awaited<ReturnType<Conductor["store"]["readJob"]>>,
  now: Date,
): { retentionClass: z.infer<typeof retentionClassSchema>; detail: string } {
  if (
    !["completed", "failed", "needs-input", "cancelled"].includes(
      manifest.status,
    )
  ) {
    return {
      retentionClass: "active",
      detail: `Attempt is ${manifest.status}`,
    };
  }
  if (!["not-required", "proven"].includes(cleanupStatus)) {
    return {
      retentionClass: "quarantine",
      detail: `Cleanup evidence is ${cleanupStatus}`,
    };
  }
  if (
    manifest.status === "completed" &&
    manifest.verificationStatus === "eligible" &&
    !["accepted", "rejected", "superseded"].includes(manifest.reviewDisposition)
  ) {
    return {
      retentionClass: "reviewable",
      detail: "Eligible proposal has no authoritative review disposition",
    };
  }
  const finishedAt = manifest.finishedAt
    ? Date.parse(manifest.finishedAt)
    : Number.POSITIVE_INFINITY;
  const retentionMs = ["accepted", "rejected", "superseded"].includes(
    manifest.reviewDisposition,
  )
    ? contract.resources.reviewedRetentionMs
    : contract.resources.terminalRetentionMs;
  const expiresAt = finishedAt + retentionMs;
  return now.getTime() >= expiresAt
    ? {
        retentionClass: "expired",
        detail: `Terminal evidence expired at ${new Date(expiresAt).toISOString()}`,
      }
    : {
        retentionClass: "retained",
        detail: `Terminal evidence retained until ${new Date(expiresAt).toISOString()}`,
      };
}

async function collectPrunableFiles(attemptRoot: string) {
  const retainedFiles = new Set([
    "attempt.json",
    "cleanup.json",
    "verification.json",
    "gc-tombstone.json",
  ]);
  const retainedDirectories = new Set(["transitions", "cleanup-transitions"]);
  const files: Array<z.infer<typeof gcFileBindingSchema>> = [];
  for (const entry of await readdir(attemptRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && retainedDirectories.has(entry.name)) continue;
    if (entry.isFile() && retainedFiles.has(entry.name)) continue;
    if (!entry.isFile()) continue;
    const target = path.join(attemptRoot, entry.name);
    files.push({
      relativePath: entry.name,
      bytes: (await stat(target)).size,
      sha256: await sha256File(target),
    });
  }
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function assertPlanIntegrity(plan: GcPlan, dataRoot: string, now: Date): void {
  const { planFingerprint, ...body } = plan;
  if (fingerprint(body) !== planFingerprint) {
    throw new Error("GC plan fingerprint is invalid");
  }
  if (path.resolve(plan.dataRoot) !== path.resolve(dataRoot)) {
    throw new Error("GC plan belongs to another data root");
  }
  if (now.getTime() > Date.parse(plan.expiresAt)) {
    throw new Error("GC plan has expired; run a new dry-run");
  }
}

function assertApproval(plan: GcPlan, approval: GcApproval, now: Date): void {
  const approvedAt = Date.parse(approval.approvedAt);
  if (
    approvedAt < Date.parse(plan.generatedAt) ||
    approvedAt > Date.parse(plan.expiresAt) ||
    approvedAt > now.getTime() + 5_000
  ) {
    throw new Error("GC approval is outside the plan's validity window");
  }
}

async function minimumGcTtl(
  attempts: Awaited<ReturnType<Conductor["store"]["listAttempts"]>>,
  conductor: Conductor,
): Promise<number> {
  let ttl = Number.POSITIVE_INFINITY;
  for (const attempt of attempts) {
    try {
      const contract = await conductor.store.readJob(attempt.jobId);
      ttl = Math.min(ttl, contract.resources.gcProposalTtlMs);
    } catch {
      ttl = Math.min(ttl, 15 * 60 * 1_000);
    }
  }
  return Number.isFinite(ttl) ? ttl : 15 * 60 * 1_000;
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) total += (await stat(target)).size;
    }
  }
  return total;
}

function resolveBoundFile(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe GC artifact path: ${relativePath}`);
  }
  return target;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
