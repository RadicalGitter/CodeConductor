import type { JobContract } from "../contracts/job.js";
import type { VerificationRecord } from "./types.js";

export function evaluatePathScope(
  changedPaths: string[],
  scope: JobContract["scope"],
): VerificationRecord["scope"] {
  const normalized = [...new Set(changedPaths.map(normalizePath))].sort();
  const allowed = scope.allowedPaths.map(normalizeRule);
  const forbidden = scope.forbiddenPaths.map(normalizeRule);
  const protectedPaths = scope.protectedPaths.map(normalizeRule);
  const violations: VerificationRecord["scope"]["violations"] = [];

  for (const changedPath of normalized) {
    if (
      allowed.length > 0 &&
      !allowed.some((rule) => matchesRule(changedPath, rule))
    ) {
      violations.push({
        path: changedPath,
        kind: "outside-allowed",
        rule: "<allowedPaths>",
      });
    }
    for (const rule of forbidden) {
      if (matchesRule(changedPath, rule)) {
        violations.push({ path: changedPath, kind: "forbidden", rule });
      }
    }
    for (const rule of protectedPaths) {
      if (matchesRule(changedPath, rule)) {
        violations.push({ path: changedPath, kind: "protected", rule });
      }
    }
  }

  const configured =
    allowed.length + forbidden.length + protectedPaths.length > 0;
  return {
    status:
      violations.length > 0
        ? "failed"
        : configured
          ? "passed"
          : "not-configured",
    changedPaths: normalized,
    violations,
  };
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function normalizeRule(value: string): string {
  return normalizePath(value);
}

function matchesRule(candidate: string, rule: string): boolean {
  return candidate === rule || candidate.startsWith(`${rule}/`);
}
