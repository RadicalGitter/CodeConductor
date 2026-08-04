import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SandboxProfiles } from "../src/sandbox/docker.js";
import {
  ExecutionPolicy,
  executeCommand,
} from "../src/verification/command-executor.js";

const dataRoot = path.resolve(
  process.env.CONDUCTOR_DATA_DIR ?? path.join(os.homedir(), ".conductor"),
);
const runId = new Date().toISOString().replaceAll(":", "-");
const artifactRoot = path.join(dataRoot, "canaries", `sandbox-${runId}`);
const workspace = path.join(artifactRoot, "workspace");
await mkdir(workspace, { recursive: true });

const configured = SandboxProfiles.fromEnvironment();
const boundary = configured.resolve("escape-canary");
let runtimeError: string | undefined;
try {
  await configured.verify(boundary);
} catch (error) {
  runtimeError = error instanceof Error ? error.message : String(error);
}
process.env.CONDUCTOR_SANDBOX_SECRET_CANARY = "must-not-cross";

const probeScript = [
  'root_write="blocked"',
  '(echo escaped > /conductor-host-escape.txt) 2>/dev/null && root_write="escaped"',
  'network="blocked"',
  'wget -q -T 2 -O /tmp/network http://example.com 2>/dev/null && network="reachable"',
  'secret="absent"',
  '[ -n "$CONDUCTOR_SANDBOX_SECRET_CANARY" ] && secret="leaked"',
  'socket="absent"',
  '[ -S /var/run/docker.sock ] && socket="present"',
  'uid="$(id -u)"',
  'caps="$(awk \"/CapEff/ {print \\$2}\" /proc/self/status)"',
  'printf \'{"rootWrite":"%s","network":"%s","secret":"%s","dockerSocket":"%s","uid":"%s","capEff":"%s"}\\n\' "$root_write" "$network" "$secret" "$socket" "$uid" "$caps" > /workspace/probe.json',
].join("\n");

const resources: string[] = [];
const released: string[] = [];
const probe = await executeCommand({
  command: {
    executable: "/bin/sh",
    args: ["-c", probeScript],
    inheritEnv: [],
  },
  phase: "acceptance",
  index: 0,
  workspacePath: workspace,
  artifactDirectory: artifactRoot,
  defaultTimeoutMs: 20_000,
  policy: new ExecutionPolicy(),
  signal: new AbortController().signal,
  executionBoundary: boundary,
  attemptId: `sandbox-${runId}`,
  onExternalResource: (resource) => {
    resources.push(resource.resourceId);
  },
  onExternalResourceReleased: (resourceId) => {
    released.push(resourceId);
  },
});

const probeResult = JSON.parse(
  await readFile(path.join(workspace, "probe.json"), "utf8"),
) as Record<string, string>;
const expected = {
  rootWrite: "blocked",
  network: "blocked",
  secret: "absent",
  dockerSocket: "absent",
  uid: "65532",
  capEff: "0000000000000000",
};

const cancellation = new AbortController();
const cancelledResources: string[] = [];
const cancelledReleased: string[] = [];
const cancellationPromise = executeCommand({
  command: {
    executable: "/bin/sh",
    args: ["-c", "while true; do sleep 1; done"],
    inheritEnv: [],
  },
  phase: "acceptance",
  index: 1,
  workspacePath: workspace,
  artifactDirectory: artifactRoot,
  defaultTimeoutMs: 20_000,
  policy: new ExecutionPolicy(),
  signal: cancellation.signal,
  executionBoundary: boundary,
  attemptId: `sandbox-${runId}`,
  onExternalResource: (resource) => {
    cancelledResources.push(resource.resourceId);
    setTimeout(() => cancellation.abort(), 1_000);
  },
  onExternalResourceReleased: (resourceId) => {
    cancelledReleased.push(resourceId);
  },
});
const cancelled = await cancellationPromise;

const result = {
  schema: "conductor.sandbox-canary/v1",
  runId,
  artifactRoot,
  image: boundary.image,
  profileFingerprint: boundary.profileFingerprint,
  runtimeReady: runtimeError === undefined,
  runtimeError,
  probeStatus: probe.status,
  probeResult,
  expected,
  resources,
  released,
  cancellationStatus: cancelled.status,
  cancelledResources,
  cancelledReleased,
  isolationPassed:
    probe.status === "passed" &&
    Object.entries(expected).every(
      ([key, value]) => probeResult[key] === value,
    ) &&
    resources.length === 1 &&
    released[0] === resources[0] &&
    cancelled.status === "cancelled" &&
    cancelledResources.length === 1 &&
    cancelledReleased[0] === cancelledResources[0],
};
const finalResult = {
  ...result,
  passed: result.isolationPassed && result.runtimeReady,
};
await writeFile(
  path.join(artifactRoot, "manifest.json"),
  `${JSON.stringify(finalResult, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(finalResult, null, 2));
if (!finalResult.passed) process.exitCode = 1;
