import { expect, test } from "bun:test";

import {
  canonicalJson,
  fingerprint,
  freezeJobRequest,
} from "../src/contracts/job.js";

test("canonical fingerprints ignore object key order but preserve array order", () => {
  expect(fingerprint({ b: 2, a: [1, 3] })).toBe(
    fingerprint({ a: [1, 3], b: 2 }),
  );
  expect(fingerprint({ a: [1, 3] })).not.toBe(fingerprint({ a: [3, 1] }));
  expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
});

test("freezes authority and exact repository evidence into a versioned contract", () => {
  const contract = freezeJobRequest(
    {
      objective: "Implement the bounded change",
      repositoryPath: "ignored-after-inspection",
      adapterId: "kode",
      idempotencyKey: "contract-test",
    },
    {
      repositoryRoot: "Z:\\repo",
      baseRevision: "a".repeat(40),
      now: new Date("2026-08-04T00:00:00.000Z"),
    },
  );

  expect(contract.schema).toBe("conductor.job/v2");
  expect(contract.authority).toBe("proposal-only");
  expect(contract.repository.baseRevision).toBe("a".repeat(40));
  expect(contract.jobId).toMatch(/^job_[a-f0-9]{20}$/);
  expect(contract.resources.profileId).toBe("overnight-local-v1");
  expect(contract.resources.maxPatchBytes).toBe(5 * 1024 * 1024);
});
