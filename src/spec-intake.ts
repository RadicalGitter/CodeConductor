import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v4";

import { commandSpecSchema, relativePathSchema } from "./contracts/job.js";
import {
  queuedJobRequestSchema,
  type QueuedJobRequest,
} from "./contracts/queue.js";

const specificationMetadataSchema = z.object({
  specification: z.object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    status: z.enum(["draft", "conductor-ready", "superseded"]),
    title: z.string().min(1),
    targetProject: z.string().min(1),
  }),
  conductor: z.object({
    initialPhase: z.string().min(1),
    scopeHints: z.array(relativePathSchema).min(1),
    verificationProfiles: z.array(z.string().min(1)).default([]),
  }),
});

const specProfileSchema = z.object({
  repositoryPath: z.string().min(1),
  baseRef: z.string().min(1).default("HEAD"),
  adapterId: z.string().min(1),
  adapterOptions: z.record(z.string(), z.unknown()).default({}),
  taskClass: z
    .enum(["implementation", "test", "documentation", "analysis", "review"])
    .default("implementation"),
  forbiddenPaths: z.array(relativePathSchema).default([]),
  protectedPaths: z.array(relativePathSchema).default([]),
  contextRefs: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  escalateWhen: z
    .array(z.string().min(1))
    .default([
      "Required work exceeds the specification, declared scope, or repository authority.",
    ]),
  setupCommands: z.array(commandSpecSchema).default([]),
  verificationProfiles: z
    .record(z.string(), z.array(commandSpecSchema))
    .default({}),
  timeoutMs: z.number().int().positive().max(86_400_000).default(28_800_000),
  retainWorkspace: z.boolean().default(true),
});

const specProfilesFileSchema = z.object({
  schema: z.literal("conductor.spec-profiles/v1"),
  profiles: z.record(z.string(), specProfileSchema),
});

export type SpecificationMetadata = z.infer<typeof specificationMetadataSchema>;
export type SpecProfile = z.infer<typeof specProfileSchema>;

export interface ParsedSpecification {
  path: string;
  text: string;
  hash: string;
  metadata: SpecificationMetadata;
}

export interface CompileSpecificationOptions {
  parentJobIds?: string[];
  findings?: string[];
}

export function parseSpecification(
  text: string,
  specificationPath: string,
): ParsedSpecification {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(
      `Specification must begin with YAML frontmatter: ${specificationPath}`,
    );
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error(
      `Specification frontmatter is not closed: ${specificationPath}`,
    );
  }
  const raw = Bun.YAML.parse(normalized.slice(4, end));
  const metadata = specificationMetadataSchema.parse(raw);
  return {
    path: path.resolve(specificationPath),
    text: normalized,
    hash: createHash("sha256").update(normalized).digest("hex"),
    metadata,
  };
}

export async function readSpecification(
  specificationPath: string,
): Promise<ParsedSpecification> {
  const resolved = path.resolve(specificationPath);
  return parseSpecification(await readFile(resolved, "utf8"), resolved);
}

export async function loadSpecProfile(
  targetProject: string,
  profileFile = defaultSpecProfilesPath(),
): Promise<{ profile: SpecProfile; profileFile: string }> {
  const resolved = path.resolve(profileFile);
  const parsed = specProfilesFileSchema.parse(
    JSON.parse(await readFile(resolved, "utf8")),
  );
  const profile = parsed.profiles[targetProject];
  if (profile === undefined) {
    throw new Error(
      `No specification launch profile named "${targetProject}" in ${resolved}`,
    );
  }
  return { profile, profileFile: resolved };
}

export function compileSpecificationJob(
  specification: ParsedSpecification,
  profile: SpecProfile,
  options: CompileSpecificationOptions = {},
): QueuedJobRequest {
  if (specification.metadata.specification.status !== "conductor-ready") {
    throw new Error(
      `Specification status must be conductor-ready, got ${specification.metadata.specification.status}`,
    );
  }

  const requestedProfiles =
    specification.metadata.conductor.verificationProfiles;
  const acceptanceCommands = requestedProfiles.flatMap((profileId) => {
    const commands = profile.verificationProfiles[profileId];
    if (commands === undefined) {
      throw new Error(
        `Unknown verification profile "${profileId}" for target ${specification.metadata.specification.targetProject}`,
      );
    }
    return commands;
  });
  const parentJobIds = [...new Set(options.parentJobIds ?? [])];
  const findings = (options.findings ?? [])
    .map((finding) => finding.trim())
    .filter(Boolean);
  const objective = buildObjective(specification, parentJobIds, findings);
  const adapterOptions = addReadOnlySpecification(
    profile.adapterOptions,
    specification.path,
  );
  const idempotencyKey = `spec:${createHash("sha256")
    .update(
      JSON.stringify({
        specificationHash: specification.hash,
        parentJobIds: [...parentJobIds].sort(),
        findings,
        profile: specification.metadata.specification.targetProject,
      }),
    )
    .digest("hex")}`;

  return queuedJobRequestSchema.parse({
    objective,
    taskClass: profile.taskClass,
    repositoryPath: path.resolve(profile.repositoryPath),
    baseRef: profile.baseRef,
    adapterId: profile.adapterId,
    adapterOptions,
    scope: {
      allowedPaths: specification.metadata.conductor.scopeHints,
      forbiddenPaths: profile.forbiddenPaths,
      protectedPaths: profile.protectedPaths,
    },
    contextRefs: profile.contextRefs,
    constraints: [
      ...profile.constraints,
      `The authoritative specification is ${specification.path} with SHA-256 ${specification.hash}.`,
      "Read the complete authoritative specification before changing files.",
    ],
    escalateWhen: profile.escalateWhen,
    setupCommands: profile.setupCommands,
    acceptanceCommands,
    timeoutMs: profile.timeoutMs,
    retainWorkspace: profile.retainWorkspace,
    idempotencyKey,
    queue: { priority: 0, dependsOnJobIds: parentJobIds },
  });
}

export function defaultSpecProfilesPath(): string {
  return path.resolve(
    process.env.CONDUCTOR_SPEC_PROFILES_FILE ??
      path.join(os.homedir(), ".conductor", "spec-profiles.json"),
  );
}

function buildObjective(
  specification: ParsedSpecification,
  parentJobIds: string[],
  findings: string[],
): string {
  const { title } = specification.metadata.specification;
  const { initialPhase } = specification.metadata.conductor;
  if (parentJobIds.length === 0) {
    return `Implement phase "${initialPhase}" of "${title}" from the authoritative specification at ${specification.path}. Satisfy all requirements and acceptance criteria applicable to that phase, and retain explicit evidence for any unresolved seam or blocker.`;
  }
  if (findings.length === 0) {
    throw new Error("Correction contracts require at least one review finding");
  }
  return `Correct the proposal lineage for "${title}" against the authoritative specification at ${specification.path}. Address these independent review findings without widening scope:\n${findings.map((finding) => `- ${finding}`).join("\n")}`;
}

function addReadOnlySpecification(
  adapterOptions: Record<string, unknown>,
  specificationPath: string,
): Record<string, unknown> {
  const existing = adapterOptions.readOnlyPaths;
  if (
    existing !== undefined &&
    (!Array.isArray(existing) ||
      !existing.every((entry) => typeof entry === "string"))
  ) {
    throw new Error("adapterOptions.readOnlyPaths must be an array of strings");
  }
  return {
    ...adapterOptions,
    readOnlyPaths: [...new Set([...(existing ?? []), specificationPath])],
  };
}
