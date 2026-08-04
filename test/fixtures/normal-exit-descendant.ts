import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) throw new Error("canary path required");

const grandchild = fileURLToPath(
  new URL("./grandchild-canary.ts", import.meta.url),
);
const child = spawn(process.execPath, [grandchild, target, "1200"], {
  stdio: "ignore",
  windowsHide: true,
  detached: true,
});
child.unref();
await new Promise((resolve) => setTimeout(resolve, 250));
console.log("worker-exiting-with-live-descendant");
