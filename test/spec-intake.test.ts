import { expect, test } from "bun:test";

import {
  compileSpecificationJob,
  parseSpecification,
  type SpecProfile,
} from "../src/spec-intake.js";

const specificationText = `---
specification:
  slug: example-feature
  status: conductor-ready
  title: Example feature
  targetProject: fixture
conductor:
  initialPhase: phase-1
  scopeHints:
    - packages/example-feature
  verificationProfiles:
    - package-checks
---

# Example feature
`;

const profile: SpecProfile = {
  repositoryPath: "C:\\fixture",
  baseRef: "HEAD",
  adapterId: "fixture",
  adapterOptions: {},
  taskClass: "implementation",
  forbiddenPaths: [],
  protectedPaths: ["AGENTS.md"],
  contextRefs: ["AGENTS.md"],
  constraints: [],
  escalateWhen: ["Stop on conflict."],
  setupCommands: [],
  verificationProfiles: {
    "package-checks": [
      { executable: "node", args: ["test.js"], inheritEnv: [] },
    ],
  },
  timeoutMs: 60_000,
  retainWorkspace: true,
};

test("compiles a conductor-ready specification into one bounded queue request", () => {
  const specification = parseSpecification(specificationText, "C:\\spec.md");
  const request = compileSpecificationJob(specification, profile);

  expect(request.repositoryPath).toBe("C:\\fixture");
  expect(request.scope.allowedPaths).toEqual(["packages/example-feature"]);
  expect(request.scope.protectedPaths).toEqual(["AGENTS.md"]);
  expect(request.acceptanceCommands).toHaveLength(1);
  expect(request.adapterOptions.readOnlyPaths).toEqual(["C:\\spec.md"]);
  expect(request.queue.dependsOnJobIds).toEqual([]);
  expect(request.objective).toContain('phase "phase-1"');
  expect(request.constraints.join("\n")).toContain(specification.hash);
});

test("compiles review findings into a dependent correction contract", () => {
  const specification = parseSpecification(specificationText, "C:\\spec.md");
  const request = compileSpecificationJob(specification, profile, {
    parentJobIds: ["job_parent", "job_parent"],
    findings: ["Keyboard focus is lost after expansion."],
  });

  expect(request.queue.dependsOnJobIds).toEqual(["job_parent"]);
  expect(request.objective).toContain("Keyboard focus is lost");
});

test("fails closed for drafts, unknown checks, and empty correction findings", () => {
  const ready = parseSpecification(specificationText, "C:\\spec.md");
  expect(() =>
    compileSpecificationJob(ready, profile, { parentJobIds: ["job_parent"] }),
  ).toThrow("require at least one review finding");

  const draft = parseSpecification(
    specificationText.replace("status: conductor-ready", "status: draft"),
    "C:\\spec.md",
  );
  expect(() => compileSpecificationJob(draft, profile)).toThrow(
    "status must be conductor-ready",
  );

  expect(() =>
    compileSpecificationJob(ready, {
      ...profile,
      verificationProfiles: {},
    }),
  ).toThrow('Unknown verification profile "package-checks"');
});
