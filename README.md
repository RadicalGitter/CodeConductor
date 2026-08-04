# CodingConductor

Durable orchestration and review evidence for coding agents.

CodingConductor contains **Conductor**, a provider-neutral control plane that
turns bounded coding contracts into isolated, reviewable proposals. It is not a
coding model and it does not replace Kode, Codex, Claude Code, or another
harness. It coordinates them while keeping repository authority, deterministic
verification, and final acceptance outside the worker.

> **Status:** experimental and private. The current runtime is suitable for
> attended trials with trusted repositories and adapters. It is not yet cleared
> for overnight unattended operation; the open gates are tracked explicitly in
> the [hardening register](docs/hardening-register.md).

## Why Conductor exists

Powerful coding agents still need durable answers to ordinary operational
questions:

- What exact revision and contract did the worker receive?
- Which files and commands was it authorized to touch?
- Can two useful jobs run concurrently without sharing mutable state?
- Did the worker finish, did the deterministic checks pass, and are those two
  claims kept distinct?
- Can a reviewer reconstruct the proposal after restart or workspace cleanup?
- When something fails, does the evidence explain whether to retry, quarantine,
  reject, or ask for a decision?

Conductor makes those questions the runtime's responsibility rather than asking
an agent transcript to serve as proof.

```text
owner / architect
        |
        v
approved design + versioned job contract
        |
        v
Conductor
  policy -> isolated worktree -> worker -> evidence -> checks -> review packet
        |
        +-- Kode adapter
        +-- Codex adapter
        +-- future harness adapters
```

## What exists today

- Exact-revision Git worktrees and proposal-only patches.
- Kode and Codex worker adapters.
- Non-blocking job submission, polling, cancellation, and bounded parallel
  queueing.
- Dependency graphs with hash-bound proposal ancestry.
- Revision-fenced queue and attempt journals with a single durable dispatch
  identity from intent through launch claim.
- Positive path scope, protected paths, setup cleanliness, and acceptance
  command evidence.
- Bounded artifact retrieval and proposal review packets.
- A generation-fenced single-host dispatcher lease.
- Guarded subprocesses and durable external-resource records.
- A digest-pinned Docker verification lane that fails closed when its configured
  security floor is not met.
- A stdio MCP surface for architect and harness integrations.

The implementation has also been adversarially reviewed. Duplicate pre-launch
claims and dispatch crash windows are now closed by repeatable race and abrupt-
termination tests. Complete process-tree ownership, public reconciliation,
evidence sealing, and resource ceilings remain open before unattended use. The
README, runtime contract, and operations guide deliberately do not hide that
boundary.

## What Conductor does not do

- It does not treat worker completion as semantic acceptance.
- It does not merge or mutate a canonical branch automatically.
- It does not let model-facing callers choose arbitrary repositories,
  executables, sandboxes, secrets, or budgets.
- It does not use same-worker self-review as independent evidence.
- Its current Docker verifier is not presented as a hostile-agent VM boundary.

Workers produce proposals. Deterministic policy establishes mechanical
eligibility. A project owner or authoritative reviewer decides what becomes
accepted repository state.

## Quick start

Prerequisites: [Bun](https://bun.sh/) and Git. Node-compatible production
artifacts remain a goal, while development and tests use Bun.

```powershell
bun install
bun run check
bun run doctor
bun run start:mcp
```

Runtime data defaults to `~/.conductor`. Common owner-side configuration:

| Setting                           | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `CONDUCTOR_DATA_DIR`              | Durable jobs, attempts, queue state, and evidence      |
| `CONDUCTOR_KODE_BIN`              | Trusted Kode launcher                                  |
| `CONDUCTOR_CODEX_BIN`             | Trusted Codex launcher                                 |
| `CONDUCTOR_MAX_CONCURRENT`        | Dispatcher capacity; default `1`                       |
| `CONDUCTOR_POLL_INTERVAL_MS`      | Queue polling interval                                 |
| `CONDUCTOR_LEASE_MS`              | Single-host dispatcher lease duration                  |
| `CONDUCTOR_WORKER_ENV_ALLOWLIST`  | Environment names workers may inherit                  |
| `CONDUCTOR_COMMAND_ALLOWLIST`     | Absolute executables allowed for owner-authored checks |
| `CONDUCTOR_COMMAND_ENV_ALLOWLIST` | Environment names checks may inherit                   |

To bind a compiled Kode fork directly, set `CONDUCTOR_KODE_ENTRY` and optionally
`CONDUCTOR_KODE_NODE_BIN`. Conductor passes the entry as an argument and never
imports Kode packages.

Kode runs with its safe host-worktree policy. Permission bypass is not a job
option; stronger authority belongs only inside a future external or microVM
execution boundary.

## First product workflow

The first nontrivial target is Vesserin's **Observation Projection v0**: an
actor-safe view and legal-action projection, a structurally separate overhead
diagnostic view, and deterministic package assembly. The workflow is designed
to test whether local workers can produce most bounded implementation work
without spending premium attention on supervision or weakening review.

The complete approach, diagnostics plan, controlled experiments, and go/no-go
gates are in the
[Vesserin backend generation plan](docs/vesserin-backend-generation-plan.md).

## Documentation

- [Architecture and authority model](docs/architecture.md)
- [Runtime contract](docs/runtime-contract.md)
- [Operations and recovery](docs/operations.md)
- [Verification model](docs/verification.md)
- [Source-authored contracts](docs/source-contracts.md)
- [Behavior parity map](docs/parity-map.md)
- [Roadmap](docs/roadmap.md)
- [Unattended hardening register](docs/hardening-register.md)
- [Dispatch fault matrix](docs/dispatch-fault-matrix.md)
- [Extra High review register](docs/extra-high-review.md)

## Repository layout

```text
src/contracts/      versioned job, attempt, queue, and evidence schemas
src/orchestrator/   proposal execution and attempt lifecycle
src/queue/          durable scheduling, leases, and recovery
src/runtime/        processes, worktrees, executables, and external resources
src/verification/   scope, command, and eligibility checks
src/mcp/            bounded MCP tools
scripts/            doctor, qualification, and live canaries
test/               contract, race, recovery, and integration evidence
```

## Licensing

The repository is currently private and `UNLICENSED`. No permission to copy,
modify, or redistribute Conductor is granted until its owner chooses a license.
Third-party runtime dependencies retain their own licenses; see
[THIRD_PARTY.md](THIRD_PARTY.md).
