import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  finalizeSpecificationDraft,
  inspectSpecificationDraft,
} from "../src/spec-builder.js";

const headings = [
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

function draft(body: string): string {
  return `---
specification:
  slug: fixture
  status: draft
  title: Fixture
  targetProject: fixture
conductor:
  initialPhase: phase-1
  scopeHints:
    - src
  verificationProfiles: []
---

# Fixture

${headings.map((heading) => `${heading}\n\nComplete content.`).join("\n\n")}

${body}`;
}

test("reports visible placeholders and incomplete quality gates", () => {
  const inspection = inspectSpecificationDraft(
    draft("<What are we building?>\n\n- [ ] Confirm behavior"),
    "fixture.md",
  );
  expect(inspection.ready).toBe(false);
  expect(inspection.issues.join("\n")).toContain("visible placeholders");
  expect(inspection.issues.join("\n")).toContain("unchecked");
  expect(inspection.nextQuestions[0]).toContain("created or changed");
});

test("does not mistake literal HTML elements for template placeholders", () => {
  expect(
    inspectSpecificationDraft(
      draft("Use native <details> content without replacement."),
      "fixture.md",
    ).ready,
  ).toBe(true);
});

test("finalizes a complete draft without rewriting its body", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "conductor-spec-"));
  const target = path.join(directory, "fixture.md");
  const original = draft("All readiness checks were reviewed.");
  try {
    await writeFile(target, original, "utf8");
    expect(await finalizeSpecificationDraft(target)).toEqual({
      ready: true,
      issues: [],
      nextQuestions: [],
    });
    const finalized = await readFile(target, "utf8");
    expect(finalized).toContain("status: conductor-ready");
    expect(finalized.replace("status: conductor-ready", "status: draft")).toBe(
      original,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
