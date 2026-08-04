import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = process.argv[2];
const instruction = JSON.parse(process.argv[3] ?? "null") as
  | { action: "write"; path: string; content: string }
  | { action: "derive"; readPath: string; writePath: string; suffix: string };

if (!workspace || !instruction) throw new Error("worker arguments required");

if (instruction.action === "write") {
  await writeFile(
    path.join(workspace, instruction.path),
    instruction.content,
    "utf8",
  );
} else {
  const parent = await readFile(
    path.join(workspace, instruction.readPath),
    "utf8",
  );
  await writeFile(
    path.join(workspace, instruction.writePath),
    `${parent.trim()}${instruction.suffix}\n`,
    "utf8",
  );
}

console.log(JSON.stringify({ type: "worker_complete", instruction }));
