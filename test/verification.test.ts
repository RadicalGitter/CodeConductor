import { expect, test } from "bun:test";
import path from "node:path";

import { jobRequestSchema } from "../src/contracts/job.js";
import { ExecutionPolicy } from "../src/verification/command-executor.js";
import { evaluatePathScope } from "../src/verification/scope.js";

test("scope uses exact-or-descendant rules and reports every authority violation", () => {
  const result = evaluatePathScope(
    ["src/feature/new.ts", "README.md", "outside.txt"],
    {
      allowedPaths: ["src", "README.md"],
      forbiddenPaths: ["src/feature"],
      protectedPaths: ["README.md"],
    },
  );

  expect(result.status).toBe("failed");
  expect(result.violations).toEqual([
    { path: "README.md", kind: "protected", rule: "README.md" },
    { path: "outside.txt", kind: "outside-allowed", rule: "<allowedPaths>" },
    { path: "src/feature/new.ts", kind: "forbidden", rule: "src/feature" },
  ]);
});

test("contracts reject ambiguous path globs, traversal, and secret values", () => {
  expect(() =>
    jobRequestSchema.parse({
      objective: "bad scope",
      repositoryPath: "Z:\\repo",
      adapterId: "fixture",
      scope: { allowedPaths: ["src/**"] },
    }),
  ).toThrow();
  expect(() =>
    jobRequestSchema.parse({
      objective: "bad cwd",
      repositoryPath: "Z:\\repo",
      adapterId: "fixture",
      setupCommands: [{ executable: "bun", cwd: "../outside" }],
    }),
  ).toThrow();
  const parsed = jobRequestSchema.parse({
    objective: "named environment only",
    repositoryPath: "Z:\\repo",
    adapterId: "fixture",
    setupCommands: [{ executable: "bun", inheritEnv: ["PUBLIC_NAME"] }],
  });
  expect(parsed.setupCommands[0]).not.toHaveProperty("env");
});

test("execution policy requires owner-configured executables and environment names", () => {
  const policy = new ExecutionPolicy({
    allowedExecutables: [process.execPath],
    allowedEnvironmentNames: ["PUBLIC_NAME"],
  });
  expect(() =>
    policy.validate({
      executable: "powershell",
      args: [],
      inheritEnv: [],
    }),
  ).toThrow("must be absolute");
  expect(() =>
    policy.validate({
      executable: path.join(path.dirname(process.execPath), "unapproved.exe"),
      args: [],
      inheritEnv: [],
    }),
  ).toThrow("not allowed");
  expect(() =>
    policy.validate({
      executable: process.execPath,
      args: [],
      inheritEnv: ["SECRET_TOKEN"],
    }),
  ).toThrow("not allowed");
});
