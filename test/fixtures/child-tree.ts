import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) throw new Error("canary path required");

const grandchild = fileURLToPath(
  new URL("./grandchild-canary.ts", import.meta.url),
);
Bun.spawn([process.execPath, grandchild, target], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
console.log("descendant-started");
await new Promise(() => {});
