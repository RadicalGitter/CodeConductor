import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const endpoint =
  process.env.CONDUCTOR_MODEL_ENDPOINT ?? "http://127.0.0.1:7332/v1";
const outputDirectory = path.resolve(
  process.env.CONDUCTOR_LOCAL_KODE_CONFIG_DIR ??
    path.join(os.homedir(), ".conductor", "kode-config"),
);
const target = path.join(outputDirectory, "config.json");
const force = process.argv.includes("--force");

if (!force && (await exists(target))) {
  throw new Error(`${target} already exists; pass --force to replace it`);
}

const response = await fetch(`${endpoint}/models`, {
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Model endpoint returned ${response.status}`);
const payload = (await response.json()) as {
  data?: Array<{ id?: string; meta?: { n_ctx?: number } }>;
};
const served = payload.data?.[0];
if (!served?.id) throw new Error("Model endpoint returned no served model id");

const profile = {
  name: "Conductor Local Worker",
  provider: "custom-openai",
  modelName: served.id,
  baseURL: endpoint,
  apiKey: "local-no-secret",
  maxTokens: 8_192,
  contextLength: served.meta?.n_ctx ?? 65_536,
  reasoningEffort: "high",
  isActive: true,
  createdAt: Date.now(),
};
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  target,
  `${JSON.stringify(
    {
      numStartups: 1,
      hasCompletedOnboarding: true,
      thinkingMode: "enabled",
      modelProfiles: [profile],
      modelPointers: {
        main: served.id,
        task: served.id,
        compact: served.id,
        quick: served.id,
      },
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", flag: force ? "w" : "wx" },
);

console.log(
  JSON.stringify(
    {
      schema: "conductor.local-kode-config/v1",
      path: target,
      endpoint,
      model: served.id,
      contextTokens: served.meta?.n_ctx ?? null,
      thinkingMode: "enabled",
      reasoningEffort: "high",
    },
    null,
    2,
  ),
);

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
