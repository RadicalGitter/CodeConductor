import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { freezeJobRequest } from "../src/contracts/job.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";

test("concurrent reservations expose only complete jobs and unique attempts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-store-"));
  const store = new ArtifactStore(root);
  const contract = freezeJobRequest(
    {
      objective: "Exercise atomic reservation",
      repositoryPath: "Z:\\repo",
      adapterId: "fixture",
      idempotencyKey: "atomic-reservation-test",
    },
    {
      repositoryRoot: "Z:\\repo",
      baseRevision: "b".repeat(40),
    },
  );

  try {
    const jobs = await Promise.all([
      store.reserveJob(contract),
      store.reserveJob(contract),
    ]);
    expect(jobs.filter((job) => job.created)).toHaveLength(1);
    expect(jobs.filter((job) => !job.created)).toHaveLength(1);
    expect(await store.readJob(contract.jobId)).toEqual(contract);

    const attempts = await Promise.all([
      store.reserveAttempt(contract),
      store.reserveAttempt(contract),
    ]);
    expect(
      new Set(attempts.map(({ manifest }) => manifest.attemptId)).size,
    ).toBe(2);
    for (const { manifest } of attempts) {
      expect(await store.findAttempt(manifest.attemptId)).toEqual(manifest);
    }

    const replayContract = freezeJobRequest(
      {
        objective: "Exercise one initial attempt",
        repositoryPath: "Z:\\repo",
        adapterId: "fixture",
        idempotencyKey: "initial-attempt-test",
      },
      {
        repositoryRoot: "Z:\\repo",
        baseRevision: "b".repeat(40),
      },
    );
    await store.reserveJob(replayContract);
    const initial = await Promise.all([
      store.reserveInitialAttempt(replayContract),
      store.reserveInitialAttempt(replayContract),
    ]);
    expect(initial.filter((attempt) => attempt.created)).toHaveLength(1);
    expect(initial[0]?.manifest.attemptId).toBe(initial[1]?.manifest.attemptId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
