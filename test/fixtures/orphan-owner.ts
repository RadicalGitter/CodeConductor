import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runProcess } from "../../src/runtime/process-runner.js";

const canary = process.argv[2];
const identityPath = process.argv[3];
if (!canary || !identityPath)
  throw new Error("canary and identity paths required");

const childTree = fileURLToPath(new URL("./child-tree.ts", import.meta.url));
void runProcess(
  {
    executable: process.execPath,
    args: [childTree, canary],
    cwd: process.cwd(),
  },
  {
    stdoutPath: `${identityPath}.stdout`,
    stderrPath: `${identityPath}.stderr`,
    timeoutMs: 60_000,
    onGuardianReady: async (identity) => {
      await writeFile(
        identityPath,
        JSON.stringify({ guardianPid: identity.guardianPid }),
        "utf8",
      );
    },
    onSpawn: async (workerPid) => {
      const current = JSON.parse(await Bun.file(identityPath).text()) as object;
      await writeFile(
        identityPath,
        JSON.stringify({ ...current, workerPid }),
        "utf8",
      );
      setTimeout(() => process.exit(91), 50);
    },
  },
);
await new Promise(() => {});
