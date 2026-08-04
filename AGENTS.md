# Conductor working contract

## Purpose

Conductor is a provider-neutral outer orchestration runtime for bounded coding
workers. It owns job identity, durable evidence, isolated workspaces, process
lifecycle, deterministic validation, queues, and review handoffs. Kode, Codex,
Claude Code, Aider, or another harness may execute a worker attempt, but none is
Conductor's architectural or licensing base.

## Read order

1. This file.
2. `docs/architecture.md` for authority and runtime ownership.
3. `docs/parity-map.md` when changing an existing external contract.
4. `docs/roadmap.md` for sequence and deliberate deferrals.

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
