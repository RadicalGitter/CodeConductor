#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  finalizeSpecificationDraft,
  inspectSpecificationDraft,
} from "../src/spec-builder.js";

const args = parseArgs(process.argv.slice(2));
const action = args.positionals[0];

if (action === "start") {
  const title = required(args, "title");
  const slug = args.values.slug ?? slugify(title);
  const workspaceSpecificationDirectory = path.join(
    import.meta.dir,
    "..",
    "..",
    "design-specifications",
  );
  const specificationDirectory = path.resolve(
    process.env.CONDUCTOR_SPEC_DIR ?? workspaceSpecificationDirectory,
  );
  const outputPath = path.resolve(
    args.values.output ?? path.join(specificationDirectory, `${slug}.md`),
  );
  const templatePath = path.resolve(
    process.env.CONDUCTOR_SPEC_TEMPLATE ??
      path.join(
        import.meta.dir,
        "..",
        "templates",
        "conductor-ready-spec-template.md",
      ),
  );
  let draft = await readFile(templatePath, "utf8");
  draft = draft
    .replace("<stable-kebab-case-id>", slug)
    .replace("<human-readable title>", title)
    .replace("# <Product or capability name>", `# ${title}`);
  if (args.values["target-project"] !== undefined) {
    draft = draft.replace(
      "<owner-defined project/profile id>",
      args.values["target-project"],
    );
  }
  if (args.values.seed !== undefined) {
    draft = draft.replace("<What are we building?>", args.values.seed);
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, draft, { encoding: "utf8", flag: "wx" });
  const inspection = inspectSpecificationDraft(draft, outputPath);
  print({
    schema: "conductor.contract-builder/v1",
    action,
    draftPath: outputPath,
    ...inspection,
  });
} else if (action === "status" || action === "finalize") {
  const specificationPath = path.resolve(required(args, "spec"));
  const inspection =
    action === "finalize"
      ? await finalizeSpecificationDraft(specificationPath)
      : inspectSpecificationDraft(
          await readFile(specificationPath, "utf8"),
          specificationPath,
        );
  print({
    schema: "conductor.contract-builder/v1",
    action,
    specificationPath,
    ...inspection,
    ...(action === "finalize" && inspection.ready
      ? {
          requiredNextAction: {
            command: "bun run contract:from-spec -- --spec",
            specificationPath,
          },
        }
      : {}),
  });
  if (!inspection.ready) process.exitCode = 2;
} else {
  throw new Error(
    "Usage: conductor-contract-builder <start|status|finalize> [--title TEXT] [--slug ID] [--target-project ID] [--seed TEXT] [--output PATH] [--spec PATH]",
  );
}

interface ParsedArgs {
  positionals: string[];
  values: Record<string, string | undefined>;
}

function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values: Record<string, string | undefined> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    values[name] = value;
    index += 1;
  }
  return { positionals, values };
}

function required(args: ParsedArgs, name: string): string {
  const value = args.values[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") throw new Error("Title does not produce a usable slug");
  return slug;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
