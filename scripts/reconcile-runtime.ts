#!/usr/bin/env bun

import { reconciliationActionSchema } from "../src/contracts/reconcile.js";
import { createConductorRuntimeFromEnvironment } from "../src/mcp/runtime.js";

const runtime = createConductorRuntimeFromEnvironment();
await runtime.conductor.store.initialize();
await runtime.queue.initialize();

const arguments_ = process.argv.slice(2);
if (arguments_.length === 0 || arguments_.includes("--dry-run")) {
  console.log(JSON.stringify(await runtime.reconciler.inspect(), null, 2));
  process.exit(0);
}

const actionFile = option(arguments_, "--apply");
if (!actionFile) usage();

const action = reconciliationActionSchema.parse(
  await Bun.file(actionFile).json(),
);
console.log(JSON.stringify(await runtime.reconciler.apply(action), null, 2));

function option(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function usage(): never {
  throw new Error(
    "Usage: bun run reconcile [--dry-run] | --apply <action.json>",
  );
}
