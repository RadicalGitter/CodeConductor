import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseSpecification } from "./spec-intake.js";

const REQUIRED_HEADINGS = [
  "## 1. Request",
  "## 2. Problem and Evidence",
  "## 3. Intended Outcomes",
  "## 4. Design Principles and Invariants",
  "## 7. User or Operational Workflows",
  "## 8. Detailed Functional Requirements",
  "## 9. Architecture and Integration",
  "## 13. Verification Matrix",
  "## 14. Acceptance Criteria",
  "## 15. Implementation Phases",
  "## 16. Explicit Non-Goals",
  "## 19. Conductor Handoff",
  "## Conductor-ready quality gate",
];

export interface SpecificationDraftInspection {
  ready: boolean;
  issues: string[];
  nextQuestions: string[];
}

export function inspectSpecificationDraft(
  text: string,
  specificationPath: string,
): SpecificationDraftInspection {
  const issues: string[] = [];
  let metadata;
  try {
    metadata = parseSpecification(text, specificationPath).metadata;
  } catch (error) {
    issues.push(...formatDraftError(error));
  }

  const visible = text.replace(/<!--[^]*?-->/g, "");
  const placeholders = [
    ...visible.matchAll(
      /<(?:[A-Z][^>\n]{1,}|[^>\n]*\s[^>\n]*|stable-kebab-case-id|phase-id|package|name|id|value)>/g,
    ),
  ].map((match) => match[0]);
  if (placeholders.length > 0) {
    issues.push(
      `Replace or remove visible placeholders: ${placeholders.slice(0, 8).join(", ")}`,
    );
  }
  if (/\bTODO\b/i.test(visible)) issues.push("Remove remaining TODO markers");
  const unchecked = [...visible.matchAll(/^- \[ \] (.+)$/gm)].map(
    (match) => match[1],
  );
  if (unchecked.length > 0) {
    issues.push(
      `Complete the quality gate (${unchecked.length} unchecked items)`,
    );
  }
  for (const heading of REQUIRED_HEADINGS) {
    if (!visible.includes(heading))
      issues.push(`Restore required section: ${heading}`);
  }
  if (metadata?.specification.status === "superseded") {
    issues.push("A superseded specification cannot be launched");
  }

  return {
    ready: issues.length === 0,
    issues,
    nextQuestions: nextQuestions(visible, issues),
  };
}

export async function finalizeSpecificationDraft(
  specificationPath: string,
): Promise<SpecificationDraftInspection> {
  const resolved = path.resolve(specificationPath);
  const text = await readFile(resolved, "utf8");
  const inspection = inspectSpecificationDraft(text, resolved);
  if (!inspection.ready) return inspection;
  const updated = text.replace(
    /(^\s*status:\s*)draft\s*(?:#.*)?$/m,
    "$1conductor-ready",
  );
  if (
    updated === text &&
    !/^\s*status:\s*conductor-ready\s*(?:#.*)?$/m.test(text)
  ) {
    return {
      ready: false,
      issues: ["Frontmatter status must be draft or conductor-ready"],
      nextQuestions: [
        "Set specification.status to draft, then finalize again.",
      ],
    };
  }
  if (updated !== text) await writeFile(resolved, updated, "utf8");
  return { ready: true, issues: [], nextQuestions: [] };
}

function nextQuestions(visible: string, issues: string[]): string[] {
  if (issues.length === 0) return [];
  const prompts: Array<[string, string]> = [
    [
      "<What are we building?>",
      "What exactly should be created or changed, and for whom?",
    ],
    [
      "<What happens today?>",
      "What currently happens, and what concrete evidence demonstrates the problem?",
    ],
    [
      "<Outcome 1>",
      "Which observable outcomes define success, and what behavior must remain unchanged?",
    ],
    ["<Principle>", "Which invariants should govern implementation tradeoffs?"],
    [
      "<Trigger>",
      "Describe the primary workflow and its failure, interruption, retry, and recovery paths.",
    ],
    [
      "<Normal behavior>",
      "What must each capability do for normal, edge, and prohibited cases?",
    ],
    [
      "<Public service",
      "Which existing authority and public integration seams must be preserved?",
    ],
    [
      "<Normal case>",
      "Which tests prove normal, boundary, malformed-input, and failure behavior?",
    ],
    [
      "<Observable criterion>",
      "What objective pass/fail statements define completion?",
    ],
    [
      "<phase-id>",
      "What is the smallest useful or uncertainty-reducing first phase and its exit evidence?",
    ],
    [
      "<Not included>",
      "Which plausible adjacent work is explicitly outside scope?",
    ],
    [
      "<one bounded implementation",
      "What exact first contract should Conductor launch, and when must it stop to ask?",
    ],
  ];
  const selected = prompts
    .filter(([marker]) => visible.includes(marker))
    .map(([, prompt]) => prompt)
    .slice(0, 4);
  return selected.length > 0
    ? selected
    : [
        "Resolve the reported readiness issues without inventing owner decisions.",
      ];
}

function formatDraftError(error: unknown): string[] {
  if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray(error.issues)
  ) {
    return error.issues.map((issue: unknown) => {
      if (typeof issue !== "object" || issue === null) return String(issue);
      const record = issue as { path?: unknown; message?: unknown };
      const location = Array.isArray(record.path)
        ? record.path.map(String).join(".")
        : "frontmatter";
      return `${location}: ${String(record.message ?? "invalid value")}`;
    });
  }
  return [error instanceof Error ? error.message : String(error)];
}
