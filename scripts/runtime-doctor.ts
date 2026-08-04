import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { createConductorRuntimeFromEnvironment } from "../src/mcp/runtime.js";
import { parseEnvironmentList } from "../src/runtime/environment.js";

type Check = {
  name: string;
  status: "pass" | "fail";
  detail: string;
};

const checks: Check[] = [];
try {
  const runtime = createConductorRuntimeFromEnvironment();
  await runtime.conductor.store.initialize();
  await runtime.queue.initialize();
  const reconciliation = await runtime.reconciler.inspect();
  const blocked = reconciliation.issues.filter(
    (issue) => issue.severity === "blocked",
  );
  record(
    "runtime-reconciliation",
    blocked.length === 0,
    blocked.length === 0
      ? `lease=${reconciliation.lease.state}; no blocked state mismatches`
      : blocked.map((issue) => `${issue.kind}: ${issue.summary}`).join("; "),
  );
  const kode = runtime.conductor.workers
    .list()
    .find((adapter) => adapter.id === "kode");
  record(
    "kode-adapter",
    kode?.available === true,
    kode?.available ? `available at ${kode.executable}` : "unavailable",
  );
  record("data-directory", true, runtime.conductor.store.root);
  const sandboxes = runtime.conductor.sandboxProfiles.list();
  record(
    "sandbox-profiles",
    true,
    sandboxes.length
      ? sandboxes.map((binding) => binding.profileId).join(", ")
      : "no external sandbox profiles configured",
  );
  for (const binding of sandboxes) {
    try {
      await runtime.conductor.sandboxProfiles.verify(binding);
      record(
        `sandbox-${binding.profileId}`,
        true,
        `${binding.image}; Docker >= ${binding.minimumEngineVersion}`,
      );
    } catch (error) {
      record(`sandbox-${binding.profileId}`, false, errorMessage(error));
    }
  }
} catch (error) {
  record("runtime-construction", false, errorMessage(error));
}

const kodeConfigDirectory = process.env.KODE_CONFIG_DIR;
const workerEnvironment = parseEnvironmentList(
  process.env.CONDUCTOR_WORKER_ENV_ALLOWLIST,
).map((entry) => entry.toUpperCase());
record(
  "kode-config-boundary",
  Boolean(kodeConfigDirectory) && workerEnvironment.includes("KODE_CONFIG_DIR"),
  kodeConfigDirectory
    ? workerEnvironment.includes("KODE_CONFIG_DIR")
      ? path.resolve(kodeConfigDirectory)
      : "KODE_CONFIG_DIR is not in CONDUCTOR_WORKER_ENV_ALLOWLIST"
    : "KODE_CONFIG_DIR is unset",
);

if (kodeConfigDirectory) {
  try {
    const config = JSON.parse(
      await readFile(path.join(kodeConfigDirectory, "config.json"), "utf8"),
    ) as {
      thinkingMode?: string;
      modelProfiles?: Array<{
        isActive?: boolean;
        modelName?: string;
        baseURL?: string;
        reasoningEffort?: string;
      }>;
    };
    const profile = config.modelProfiles?.find(
      (candidate) => candidate.isActive,
    );
    record(
      "kode-thinking",
      config.thinkingMode === "enabled" && profile?.reasoningEffort === "high",
      `thinking=${config.thinkingMode ?? "unset"}, effort=${profile?.reasoningEffort ?? "unset"}`,
    );
    if (!profile?.baseURL || !profile.modelName) {
      record("model-endpoint", false, "active Kode profile is incomplete");
    } else {
      const response = await fetch(`${profile.baseURL}/models`, {
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as {
        data?: Array<{ id?: string }>;
      };
      const served =
        payload.data?.map((entry) => entry.id).filter(Boolean) ?? [];
      record(
        "model-endpoint",
        response.ok && served.includes(profile.modelName),
        response.ok
          ? `configured model ${profile.modelName}; served ${served.join(", ") || "none"}`
          : `HTTP ${response.status}`,
      );
    }
  } catch (error) {
    record("kode-profile", false, errorMessage(error));
  }
}

const profilesFile = process.env.CONDUCTOR_COMMAND_PROFILES_FILE;
if (!profilesFile) {
  record("command-profiles", false, "CONDUCTOR_COMMAND_PROFILES_FILE is unset");
} else {
  try {
    await access(profilesFile);
    const parsed = JSON.parse(await readFile(profilesFile, "utf8")) as {
      profiles?: Record<string, unknown>;
    };
    const names = Object.keys(parsed.profiles ?? {});
    record(
      "command-profiles",
      names.length > 0,
      names.length ? names.join(", ") : "no acceptance profiles configured",
    );
  } catch (error) {
    record("command-profiles", false, errorMessage(error));
  }
}

const failed = checks.filter((check) => check.status === "fail");
console.log(
  JSON.stringify(
    {
      schema: "conductor.runtime-doctor/v1",
      ready: failed.length === 0,
      checks,
    },
    null,
    2,
  ),
);
if (failed.length > 0) process.exitCode = 1;

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, status: passed ? "pass" : "fail", detail });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
