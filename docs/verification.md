# Verification record

- Date: 2026-08-04
- Platform: Windows
- Bun: 1.3.14
- Kode behavioral baseline: `328676d0c8f09c30d57dd5c5972a6433f80f6b39`

## Standalone suite

Command:

```powershell
bun run check
```

Observed after the first runtime slice: formatting and strict TypeScript pass;
11 tests pass. The suite covers schema freezing, adapter snapshots, concurrent
atomic reservation, in-memory MCP discovery, exact-revision worktree
isolation, asynchronous submission, idempotent replay/conflict rejection,
proposal capture including untracked files, exact worktree removal, stdout and
stderr capture, and Windows child-plus-grandchild cancellation.

## Kode reference suite

Command from `Z:\Programmering\Kode-CLI`:

```powershell
bun test ./packages/mcp-delegate/src/attempts.test.ts ./packages/mcp-delegate/src/backends.test.ts ./packages/mcp-delegate/src/process.test.ts
```

Observed: 10 tests pass. This independently re-established the baseline's job,
attempt, backend-invocation, permission-mode, cancellation, timeout, and spawn
failure behavior.

## Black-box parity smoke

Command:

```powershell
bun run smoke:kode-parity -- "Z:\Programmering\Kode-CLI"
```

The script starts both MCP servers as separate stdio subprocesses. It imports
no Kode module. Both receive the same disposable Git repository and harmless
fake worker executable.

Observed:

- both attempts completed from the same exact base revision;
- both left the primary checkout untouched;
- both produced the requested file only in their isolated worktrees;
- both persisted separate stdout and stderr artifacts;
- Conductor additionally captured a proposal patch and repository status;
- replay was duplicate-free in both runtimes;
- Conductor submission returned `reserved` before completion, demonstrating
  the intended asynchronous producer/poller contract;
- both worktrees were removed through their public MCP cleanup tools.

The first smoke run failed for a useful reason: the reference runtime stores
artifact paths as strings, while the initial probe expected `{ path }` objects.
The black-box script was corrected to the observed public result shape and the
entire smoke then passed. No product behavior was changed to hide the mismatch.

This smoke verifies orchestration parity, not model quality, dependency setup,
path enforcement, acceptance checks, or hostile-code containment.

## Deterministic verification slice

After the parity baseline, the suite expanded to 18 tests. New evidence covers:

- setup commands that pass only when Git-visible repository state remains
  clean;
- positive allowed paths plus forbidden and protected path rules;
- acceptance commands that run only for a successful in-scope proposal;
- rejection of an otherwise-passing acceptance command when it mutates the
  captured proposal;
- owner-side absolute executable and environment-name allowlists;
- exclusion of arbitrary parent secrets from worker/check subprocesses;
- rejection of Windows batch shims in the shell-free executor;
- typed verification artifacts and bounded named-artifact reads suitable for a
  remote MCP client.

The negative cases remain first-class: protected-path proposals finish as
worker outputs but are marked ineligible; dirty setup stops the worker;
mutating checks are ineligible even with exit code zero; unconfigured commands
are policy-denied rather than silently executed.

## Durable queue slice

The suite now has 20 tests and 105 assertions. Queue characterization proves:

- two independent delayed workers overlap in separate worktrees at configured
  concurrency two;
- a dependent worker does not start until its prerequisite has finished with
  eligible evidence;
- completion records retain compact pointers to manifests, patches, changed
  paths, and verification;
- a second dispatcher cannot acquire an unexpired owner lease;
- restart recovery quarantines a reserved/running orphan instead of spawning a
  duplicate attempt.

## Contract-source slice

The suite now has 22 tests and 124 assertions. It additionally proves that:

- comment contracts are compiled from committed Git objects rather than dirty
  working-tree files;
- marker text inside an ordinary string does not create a contract;
- duplicate ids, missing dependencies, cycles, and unauthorized adapters fail
  before enqueue;
- named command profiles resolve outside source and remain subject to execution
  policy;
- two gameplay-style contracts enqueue idempotently, execute in dependency
  order, and persist a source-run manifest;
- a persisted watch enqueues only once for an unchanged revision and observes
  a newly committed revision on the next poll.

## Live unattended gameplay lane

`bun run smoke:kode-live` now creates a disposable gameplay repository with a
committed `@conductor-contract`, registers a watch, polls the exact revision,
enqueues through the durable dispatcher, invokes the compiled Kode fork against
the already-running local model, applies positive path scope, and runs an
owner-profiled Node acceptance test.

The final observed run used
`KAT-Coder-V2.5-Dev-APEX-I-Balanced.gguf` at 65,536 context tokens. It completed
the full chain in 12.6 seconds, changed only `gameplay/health.js`, passed the
focused test, and ended with queue `completed`, attempt `completed`, and
verification `eligible`. Evidence is under
`C:\Users\oscar\.conductor\canaries\2026-08-04T04-40-24-922Z`.

Two preceding negatives are intentionally retained. The unrestricted built-in
tool set caused repeated denied shell/delegation attempts and a 157-second
worker run. Removing command tools without removing their responsibility from
the prompt caused fourteen invented runner files; the scope gate rejected all
of them. A later source-driven run invented one status file and was likewise
quarantined. Assigning commands exclusively to Conductor and removing `Write`
when every allowed target is an existing file produced the final fast,
scope-clean result.

The suite now also creates idempotent hash-bound review packets and proves that
tampering with the proposal patch after packet creation makes review-bundle
retrieval fail.

A final repeat at
`C:\Users\oscar\.conductor\canaries\2026-08-04T04-54-02-363Z` completed the
same full live chain in 17.5 seconds and added an untruncated, SHA-256-bound
review packet. `bun run smoke:runtime-mcp` separately launched the real stdio
entrypoint with the local runtime configuration, discovered 20 tools, confirmed
the Kode adapter, queried queue and watch state, and shut down cleanly.

## Extra High hardening and composition

The standalone suite now has 34 tests and 210 assertions. New adversarial
evidence covers:

- generation-fenced local leases whose stale owners cannot release successors;
- suspend-safe refusal to steal an expired lease from a live process;
- guardian ownership-pipe process-tree termination after owner crash;
- separation of nonce-bound guardian events from spoofable worker logs;
- durable external-resource cleanup before orphan retry;
- fail-closed manual retry when terminal-attempt resource cleanup fails;
- refusal to remove a workspace while its external resource is unproven;
- automatic retention of cleanup evidence and cwd after cleanup failure;
- tree termination of a hung external cleanup before failure returns;
- three-level hash-bound proposal ancestry and deterministic reconstruction;
- rejection of altered parent evidence before child execution;
- quarantine of conflicting sibling proposals without running the child;
- child scope and patch measurement from the derived proposal baseline;
- digest-pinned external Docker invocation policy and refusal of host
  command-capable adapters.

## External-sandbox canary

The canary uses official BusyBox 1.36.1 at digest
`sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662`.
Its isolation probes passed: host-root write blocked, outbound network blocked,
host secret absent, host Docker socket absent, UID 65532, zero effective Linux
capabilities, forced cancellation recorded, and both named containers removed.

The authoritative overall result remains failure, preserved at
`C:\Users\oscar\.conductor\runtime\canaries\sandbox-2026-08-04T12-00-17.479Z`:
Docker Desktop 4.54.0 exposes Engine 29.1.2, below the profile's 29.6.2 security
floor. `bun run doctor` independently reports every Kode/model/command check as
passing and only `sandbox-escape-canary` as failing. This is a deployment block,
not a failed isolation probe and not permission to lower the floor.
