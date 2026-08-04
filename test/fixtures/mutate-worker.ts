import { writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = process.argv[2];
if (!workspace) throw new Error("workspace argument required");

await writeFile(
  path.join(workspace, "generated.txt"),
  "worker proposal\n",
  "utf8",
);
console.log(JSON.stringify({ type: "worker_complete", workspace }));
