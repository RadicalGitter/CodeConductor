# Source-authored contract format

Conductor can discover bounded coding wishes beside the code they concern.
Only tracked files from an exact Git revision are scanned; dirty working-tree
text is never treated as executable orchestration input.

## Marker

The start marker must appear on a comment line. A marker inside a string is
ignored. The body is strict JSON and the end marker closes the record.

```ts
/* @conductor-contract
{
  "id": "combat.apply-damage",
  "objective": "Implement damage application and focused tests.",
  "adapterId": "kode",
  "adapterOptions": { "model": "local-coder" },
  "scope": {
    "allowedPaths": ["src/combat/damage.ts", "test/combat/damage.test.ts"],
    "protectedPaths": ["src/combat/invariants.ts"]
  },
  "contextRefs": ["AGENTS.md", "docs/combat.md"],
  "constraints": ["Preserve deterministic replay."],
  "escalateWhen": ["The documented damage order conflicts with current tests."],
  "acceptance": [
    { "profile": "gameplay-focused", "args": ["damage.test.ts"] }
  ],
  "executionBoundary": {
    "kind": "external-sandbox",
    "profileId": "generated-code-verifier"
  },
  "dependsOn": ["combat.attack-roll"],
  "priority": 10
}
@end-conductor-contract */
```

Source contracts require a positive allowed-path declaration and at least one
acceptance profile. Adapter ids are checked against the owner-supplied scan
allowlist. Duplicate ids, missing dependencies, cycles, unsafe paths, malformed
JSON, unknown profiles, and unavailable adapters fail before worker execution.

## Command profiles

Portable source comments name commands; they do not embed host executable or
secret values. `CONDUCTOR_COMMAND_PROFILES_FILE` points to an owner-controlled
JSON file outside the project contract:

```json
{
  "schema": "conductor.command-profiles/v1",
  "profiles": {
    "gameplay-focused": {
      "executable": "C:\\path\\to\\bun.exe",
      "argsPrefix": ["test", "--"],
      "inheritEnv": []
    }
  }
}
```

Resolved commands still pass the normal shell-free execution policy. Profile
values are not persisted in the source-authored contract.

For an external sandbox, command profiles use absolute paths inside the image
(for example `/usr/local/bin/node`) instead of host executable paths. The owner
sandbox profile separately binds the Docker executable, image digest, runtime
floor, resource ceilings, and allowed container executables. Source comments
can name that profile but cannot define or widen it.

## Discovery and watches

- `scan_contract_sources` compiles without queue mutation. An optional exact
  `contractIds` allowlist selects an independent subgraph and rejects unknown
  ids or omitted dependencies.
- `enqueue_contract_sources` compiles and enqueues one exact revision, applying
  the same optional contract allowlist before queue mutation.
- `register_contract_watch` persists a moving-ref scan policy.
- the MCP process polls enabled watches automatically;
  `poll_contract_watches` triggers an immediate cycle.

A watch enqueues at most once per newly observed revision and preserves its
last scan, source run, and error. A changed revision currently recompiles the
whole enabled graph. Selective semantic invalidation is deferred until real
gameplay evidence shows which dependency propagation rule is useful.

Every job remains frozen at the scanned source revision. Once a dependency has
a completed eligible attempt, its exact hash-bound proposal lineage is composed
into the dependent worker's effective baseline. The derived Git commit is
detached, unreferenced, reconstructable, and proposal-only; no project ref or
canonical checkout is changed. A dependent worker's own path scope is measured
from that derived baseline. Conflicts or changed evidence quarantine the child
before its worker starts.
