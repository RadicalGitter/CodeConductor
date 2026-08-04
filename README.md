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
        +-- Claude Code adapter
        +-- future adapters
```

The first compatibility target is the durable delegate behavior proven in the
RadicalGitter Kode fork at revision `328676d`. Conductor reimplements that
contract independently so Kode remains an optional external backend rather than
the owner of orchestration.

## Current status

Bootstrap in progress. See [the architecture](docs/architecture.md),
[parity map](docs/parity-map.md), and [roadmap](docs/roadmap.md).

## Licensing

The repository is currently private and `UNLICENSED`. No permission to copy,
modify, or redistribute Conductor is granted until its owner chooses a license.
Third-party runtime dependencies retain their own licenses; see
[THIRD_PARTY.md](THIRD_PARTY.md).
