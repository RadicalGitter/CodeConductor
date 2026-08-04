# Conductor

Conductor is a standalone orchestration runtime for producing reviewable coding
work with local or frontier agents. It is the control plane around coding
harnesses, not another coding model and not a fork of one harness.

```text
owner / premium architect
        |
        v
versioned job contract
        |
        v
Conductor: policy -> worktree -> process -> evidence -> checks -> review packet
        |
        +-- Kode adapter
        +-- Codex adapter
        +-- future Claude Code and other adapters
```

The first compatibility target is the durable delegate behavior proven in the
RadicalGitter Kode fork at revision `328676d`. Conductor reimplements that
contract independently so Kode remains an optional external backend rather than
the owner of orchestration.

## Current status

The independent bootstrap, durable-worker slice, and deterministic verification
slice are implemented. Conductor currently provides Kode and Codex adapters,
asynchronous submission, polling, process-tree cancellation, exact-revision Git
worktrees, atomic job/attempt manifests, proposal patches, setup evidence,
path-scope enforcement, acceptance-command evidence, and a stdio MCP server.
It also has a durable single-owner queue with bounded parallelism, dependency
gates, compact completion records, generation-fenced local leases, guarded
process trees, safe same-host restart recovery, and hash-bound proposal-only
dependency composition.

```powershell
bun install
bun run check
bun run start:mcp
```

Runtime data defaults to `~/.conductor`. Configure it with
`CONDUCTOR_DATA_DIR`; configure adapter executables with
`CONDUCTOR_KODE_BIN` and `CONDUCTOR_CODEX_BIN`.

The MCP process starts the dispatcher automatically. Configure capacity with
`CONDUCTOR_MAX_CONCURRENT` (default `1`), polling with
`CONDUCTOR_POLL_INTERVAL_MS`, and the single-machine ownership lease with
`CONDUCTOR_LEASE_MS`. Use `enqueue_coding_job` for unattended work and
`submit_coding_job` only for the immediate fire-and-poll compatibility lane.

To bind directly to a compiled Kode fork without an installed launcher, set
`CONDUCTOR_KODE_ENTRY` to its JavaScript entry and optionally
`CONDUCTOR_KODE_NODE_BIN` to the Node executable. The entry is passed as an
argument; Conductor never imports Kode packages.

Worker subprocesses inherit a minimal operating-system environment. Add
explicit names with `CONDUCTOR_WORKER_ENV_ALLOWLIST`. Setup and acceptance
commands require absolute executable paths that also appear in the owner-side
`CONDUCTOR_COMMAND_ALLOWLIST`; their named environment dependencies must appear
in `CONDUCTOR_COMMAND_ENV_ALLOWLIST`. Lists are comma-separated. Command values
and secret values are never accepted into the frozen job contract.

Kode uses `--safe` in this host-worktree executor. Permission bypass is not a
job option or environment switch; it belongs only in a future stronger
external/VM executor where the host boundary remains intact.

See [the architecture](docs/architecture.md),
[runtime contract](docs/runtime-contract.md),
[parity map](docs/parity-map.md), [verification](docs/verification.md), and
[roadmap](docs/roadmap.md). Decisions intentionally reserved for stronger
review are tracked in [the Extra High register](docs/extra-high-review.md).
The in-code contract syntax and automatic watch behavior are documented in
[source contracts](docs/source-contracts.md). The concrete local-model setup,
doctor, lifecycle, recovery, live evidence, and semantic-review handoff are in
[unattended operations](docs/operations.md).

## Important current boundary

Worktrees isolate proposals from the primary checkout; they do not isolate a
host from hostile generated code. `completed` means that the worker process
completed, while `verificationStatus=eligible` means deterministic preparation,
scope, and acceptance gates also passed. Neither status semantically accepts or
merges the proposal.

## Licensing

The repository is currently private and `UNLICENSED`. No permission to copy,
modify, or redistribute Conductor is granted until its owner chooses a license.
Third-party runtime dependencies retain their own licenses; see
[THIRD_PARTY.md](THIRD_PARTY.md).
