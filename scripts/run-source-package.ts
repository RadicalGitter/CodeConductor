import path from "node:path";

import { createConductorRuntimeFromEnvironment } from "../src/mcp/runtime.js";

const repositoryPath = path.resolve(process.argv[2] ?? process.cwd());
const baseRef = process.argv[3] ?? "HEAD";
const allowedAdapterIds = (process.argv[4] ?? "kode")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
if (allowedAdapterIds.length === 0) {
  throw new Error("At least one allowed adapter ID is required.");
}
const includeExtensions = (process.argv[5] ?? ".conductor")
  .split(",")
  .map((extension) => extension.trim())
  .filter((extension) => extension.length > 0);
if (includeExtensions.length === 0) {
  throw new Error("At least one source-contract extension is required.");
}
const runtime = createConductorRuntimeFromEnvironment();

await runtime.dispatcher.start();
try {
  const sourceRun = await runtime.sources.compileAndEnqueue({
    repositoryPath,
    baseRef,
    allowedAdapterIds,
    includeExtensions,
  });
  console.log(
    JSON.stringify({
      schema: "conductor.source-package-launch/v1",
      sourceRunId: sourceRun.runId,
      revision: sourceRun.revision,
      jobs: sourceRun.enqueued,
    }),
  );

  const jobIds = new Set(sourceRun.enqueued.map((entry) => entry.jobId));
  for (;;) {
    const items = (await runtime.dispatcher.list()).filter((item) =>
      jobIds.has(item.jobId),
    );
    if (
      items.length === jobIds.size &&
      items.every((item) =>
        ["completed", "failed", "needs-input", "cancelled"].includes(
          item.status,
        ),
      )
    ) {
      console.log(
        JSON.stringify({
          schema: "conductor.source-package-finish/v1",
          sourceRunId: sourceRun.runId,
          jobs: items,
        }),
      );
      break;
    }
    await Bun.sleep(1_000);
  }
} finally {
  await runtime.dispatcher.stop();
}
