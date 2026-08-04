import { writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = process.argv[2];
const delayMs = Number(process.argv[3] ?? "0");
if (!workspace) throw new Error("workspace argument required");
if (!Number.isFinite(delayMs) || delayMs < 0) {
  throw new Error("delay must be a non-negative number");
}

await new Promise((resolve) => setTimeout(resolve, delayMs));
await writeFile(
  path.join(workspace, "generated.txt"),
  "queued worker proposal\n",
  "utf8",
);
console.log(JSON.stringify({ type: "worker_complete", workspace }));
