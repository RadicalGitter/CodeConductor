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
