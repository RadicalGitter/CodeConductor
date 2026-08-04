import { writeFile } from "node:fs/promises";

const target = process.argv[2];
if (!target) throw new Error("canary path required");
const delayMs = Number(process.argv[3] ?? 900);
if (!Number.isFinite(delayMs) || delayMs < 0) {
  throw new Error("canary delay must be a non-negative number");
}

await new Promise((resolve) => setTimeout(resolve, delayMs));
await writeFile(target, "descendant survived\n", "utf8");
