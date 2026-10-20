# Conductor working contract

> This file is the agents' domain: written by agents, for agents. Keeping it accurate and current is the job of whichever agent works here; Oscar does not read or maintain it. Rules Oscar stated in it remain his decisions: record them faithfully and change them only when he does.

## Purpose

Conductor is a provider-neutral outer orchestration runtime for bounded coding
workers. It owns job identity, durable evidence, isolated workspaces, process
lifecycle, deterministic validation, queues, and review handoffs. Kode, Codex,
Claude Code, Aider, or another harness may execute a worker attempt, but none is
Conductor's architectural or licensing base.

## Read order

1. This file.
2. `docs/architecture.md` for authority and runtime ownership.
3. `docs/spec-contract-intake.md` when creating watched contracts from product
   specifications.
4. `docs/parity-map.md` when changing an existing external contract.
5. `docs/roadmap.md` for sequence and deliberate deferrals.

## Building through Conductor

Use the user-level `$build-with-conductor` skill when an approved feature or
backend design should become a multi-contract work package, when running or
reviewing a source-authored contract graph, or when turning a reproducible
defect into an isolated fix proposal. Keep the procedure in the skill rather
than expanding this always-loaded file.

The standard specification intake has two package scripts:

- `bun run contract:builder` for an incomplete product specification;
- `bun run contract:from-spec -- --spec <path>` for a `conductor-ready`
  specification.

Run the latter as a background process, read output only until its start record
identifies the job, and do not create a persistent goal or poll for completion.
Its process-backed watcher seals review evidence and wakes the originating DSH
session. Submit review corrections through the same command with `--parent-job`
and one `--finding` per independent issue. `docs/spec-contract-intake.md` owns
the complete command, profile, review, and failure contract.

For the first Vesserin product package, also read
`docs/vesserin-backend-generation-plan.md`. The plan is cross-project direction,
not evidence that its proposed runtime capabilities are already implemented.

## Invariants

- Persist a versioned job contract before any external side effect.
- Give every attempt a stable identity and immutable relationship to its job.
- Treat worker output as a proposal. Worker completion, deterministic checks,
  semantic review, and authoritative acceptance are separate states.
- Give every mutating attempt its own worktree or stronger execution boundary.
- Never invoke a worker through a shell string. Use array arguments and record
  the resolved executable identity.
- Cancellation and timeout must terminate the complete worker process tree and
  retain evidence.
- Store full logs and patches as artifacts; return compact typed references.
- Models do not grant permissions, change policy, approve their own output, or
  mutate hidden evaluators.
- Instructions improve model behavior but do not enforce scope. Enforce
  permissions, paths, resources, and transitions in code or the execution
  boundary.
- Keep project-specific policy in plugins. The core must remain useful without
  Vesserin, Odysseus, Kode, or any single provider.

## Licensing boundary

This repository is private and `UNLICENSED` until Oscar deliberately chooses a
distribution license. Do not copy implementation source from Kode Agent,
Odysseus, or another harness. Compatibility must be based on public interfaces,
documented behavior, and independently written characterization tests. External
programs are subprocess adapters, not linked implementation dependencies.

## Development

- Use Bun for installation, tests, and scripts; retain Node-compatible runtime
  code where practical.
- Use strict TypeScript and explicit versioned schemas.
- Write durable JSON atomically and make retries idempotent.
- Run `bun run check` before committing.
- Commit each discrete slice with a scoped diff.
