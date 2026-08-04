import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createConductorRuntimeFromEnvironment } from "../src/mcp/runtime.js";
import { RetentionManager } from "../src/retention/gc.js";

const args = process.argv.slice(2);
const runtime = createConductorRuntimeFromEnvironment();
await runtime.conductor.store.initialize();
const retention = new RetentionManager(runtime.conductor);

if (args.includes("--dry-run")) {
  const plan = await retention.dryRun();
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  const output = optionValue("--out");
  if (output) await writeFile(path.resolve(output), text, "utf8");
  process.stdout.write(text);
} else if (args.includes("--apply")) {
  const planPath = requiredOption("--plan");
  const approvedBy = requiredOption("--approved-by");
  const reason = requiredOption("--reason");
  const plan = JSON.parse(await readFile(path.resolve(planPath), "utf8"));
  const result = await retention.apply(plan, {
    approvedBy,
    approvedAt: new Date().toISOString(),
    reason,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  throw new Error(
    "Choose --dry-run [--out plan.json] or --apply --plan plan.json --approved-by OWNER --reason REASON",
  );
}

function optionValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = optionValue(name);
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}
