import path from "node:path";

import { createConductorRuntimeFromEnvironment } from "../src/mcp/runtime.js";

const repositoryPath = path.resolve(process.argv[2] ?? process.cwd());
const baseRef = process.argv[3] ?? "HEAD";
const runtime = createConductorRuntimeFromEnvironment();

await runtime.dispatcher.start();
try {
  const sourceRun = await runtime.sources.compileAndEnqueue({
    repositoryPath,
    baseRef,
    allowedAdapterIds: ["kode"],
    includeExtensions: [".ts"],
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
