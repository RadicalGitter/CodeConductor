import { writeFile } from "node:fs/promises";

const target = process.argv[2];
if (!target) throw new Error("canary path required");

await Bun.sleep(900);
await writeFile(target, "descendant survived\n", "utf8");
