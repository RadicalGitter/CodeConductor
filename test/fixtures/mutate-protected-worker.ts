import { writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = process.argv[2];
if (!workspace) throw new Error("workspace argument required");

await Promise.all([
  writeFile(path.join(workspace, "generated.txt"), "worker proposal\n", "utf8"),
  writeFile(
    path.join(workspace, "seed.txt"),
    "worker changed protected input\n",
    "utf8",
  ),
]);
console.log(JSON.stringify({ type: "worker_complete", workspace }));
