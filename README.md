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

The independent bootstrap and first durable-worker slice are implemented.
Conductor currently provides Kode and Codex adapters, asynchronous submission,
polling, process-tree cancellation, exact-revision Git worktrees, atomic
job/attempt manifests, proposal patches, and a stdio MCP server.

```powershell
bun install
bun run check
bun run start:mcp
```

Runtime data defaults to `~/.conductor`. Configure it with
`CONDUCTOR_DATA_DIR`; configure adapter executables with
`CONDUCTOR_KODE_BIN` and `CONDUCTOR_CODEX_BIN`.

To bind directly to a compiled Kode fork without an installed launcher, set
`CONDUCTOR_KODE_ENTRY` to its JavaScript entry and optionally
`CONDUCTOR_KODE_NODE_BIN` to the Node executable. The entry is passed as an
argument; Conductor never imports Kode packages.

Kode uses `--safe` in this host-worktree executor. Permission bypass is not a
job option or environment switch; it belongs only in a future stronger
external/VM executor where the host boundary remains intact.

See [the architecture](docs/architecture.md),
[runtime contract](docs/runtime-contract.md),
[parity map](docs/parity-map.md), [verification](docs/verification.md), and
[roadmap](docs/roadmap.md).

## Important current boundary

Worktrees isolate proposals from the primary checkout; they do not isolate a
host from hostile generated code. Scope declarations, setup commands, and
acceptance commands are preserved in the frozen contract but are not yet
enforced or executed. Until the next slice lands, completed means only that the
worker process and proposal capture completed—not that the proposal was
accepted.

## Licensing

The repository is currently private and `UNLICENSED`. No permission to copy,
modify, or redistribute Conductor is granted until its owner chooses a license.
Third-party runtime dependencies retain their own licenses; see
[THIRD_PARTY.md](THIRD_PARTY.md).
