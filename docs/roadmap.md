# Roadmap

## Immediate path — reliability reset and first Vesserin package

The Ultra review of commit `5bf3cf2` established that the core is useful but
not ready for unattended operation. The detailed implementation sequence,
diagnostic plane, autonomous bug-reporting path, reusable skill, and first real
product target—Vesserin Observation Projection v0—are defined in
[the Vesserin backend generation plan](vesserin-backend-generation-plan.md).

The immediate order is lifecycle fencing and recovery, process/resource
closure, evidence sealing, coherent package handoff, safe control surfaces,
the Vesserin adapter, then the product pilot. New feature slices do not outrank
those gates.

## Slice 0 — independent bootstrap

Private repository, authority contract, parity map, toolchain, no copied Kode
source.

**Exit:** clean initial commit on `main` and an implementation branch.

**State:** complete at `7538ee4`.

## Slice 1 — durable single-worker parity

Versioned job/attempt contracts, atomic artifacts, one worktree per mutation,
process-tree cancellation, Kode/Codex adapters, MCP tools, and parity tests.

**Exit:** the same disposable canary succeeds through Kode's prototype and
Conductor with normalized equivalent evidence.

**State:** complete for the Kode/Codex first slice. Standalone characterization
and the black-box Kode cross-runtime canary pass. A verified Claude Code adapter
remains a later adapter addition because no `claude` executable is installed.

## Slice 2 — deterministic preparation and acceptance

Typed setup and acceptance command arrays, dependency strategies, changed-path
inventory, positive allowed-path policy, forbidden-path canaries, patch and
check artifacts.

**Exit:** a worker cannot receive an accepted proposal after leaving scope,
skipping required checks, or modifying the verifier.

**State:** core complete. Setup commands, clean-state enforcement, exact/prefix
path policy, protected paths, changed-path artifacts, acceptance commands,
proposal-stability checks, bounded remote evidence reads, and environment/
executable allowlists are characterized. Named cached dependency strategies
remain an optimization rather than an authority prerequisite.

## Slice 3 — contract-source compiler

Project plugins discover structured source comments, bind them to symbols,
compile a dependency graph, and produce frozen job contracts. Polling is
incremental and deterministic; comments are proposal sources rather than
runtime authority.

**Exit:** two small comment-authored contracts execute in dependency order and
remain reconstructable after restart.

**State:** generic core implemented. Strict JSON comment blocks are read from
tracked exact-revision files, validated as a DAG, resolved through owner-side
command profiles, recorded as source-run manifests, and enqueued idempotently.
Persistent watches poll moving refs and record failures. Symbol-aware placement
remains a later refinement. Proposal-lineage composition is now implemented:
dependent workers consume exact eligible ancestry through a hash-bound,
deterministically reconstructable detached baseline.

## Slice 4 — queue and parallelism

Durable queue, leases, bounded concurrency, compact completion events, read-only
fan-out, and isolated mutating workers.

**Exit:** simultaneous work improves accepted throughput without shared mutable
workspaces or duplicate attempts.

**State:** local-host core implemented; exit reopened. Queue items, dependency
gates, bounded concurrency, compact completion records, and generation-fenced
lease records exist. Duplicate-start and pre-launch dispatch crash windows were
closed by `a84e8fc`; malformed/missing lease deadlock was closed by `243b0ec`
with evidence-preserving repair and dry-run diagnostics. The supported Windows
lane now uses verified kill-on-close Job Objects and independent durable cleanup
evidence (`caae1c8`, `726e1cf`, `3afab31`, `77c2b54`); detached descendants are
closed on normal exit, cancellation, timeout, and owner crash, while legacy or
POSIX absence remains fail-closed. Revision `1a3f908` closes HARD-006 for
schema-readable state with evidence-bound public actions, exhaustive
status-pair classification, and mutation-before-result crash replay. Malformed
whole-record bytes remain blocked rather than reconstructed. UNC roots remain
rejected; cross-machine and network-filesystem dispatch remain unsupported.
Review evidence and resource/retention ceilings are now closed by `657f0ca` and
`2af6717` for the exercised trusted-repository Windows lane. Exact log and patch
caps, monitored worktree/artifact ceilings, total attempt deadlines, bounded
Git, frozen-profile cleanup, retry limits, disk reserve, and owner-approved GC
are implemented. The Vesserin Docker qualification and POSIX cgroup lane remain
separate environment/platform exits.

## Slice 5 — independent semantic review

Hash-bound review bundles, configurable Sonnet/other reviewers, typed findings,
bounded correction attempts, reviewer ablation metrics, and compact handoff.

**Exit:** review measurably improves hidden-check survival or is disabled as an
uneconomic route.

**State:** evidence sealing implemented; reviewer integration remains planned.
Revision `657f0ca` closes HARD-007 with a v2 packet that validates the frozen
job, immutable attempt, cleanup, all deterministic evidence and logs, lineage,
attempt inventory, and the launch-time model/harness profile on every retrieval
before and after the bounded patch read. Legacy v1 caches fail closed. No
reviewer is invoked and no finding can accept or mutate work; reviewer adapters,
typed findings, bounded correction, and ablation measurement remain planned.

## Slice 6 — Vesserin plugin

Documentation/Impact Atlas context retrieval with hierarchical section ranges,
Vesserin contract vocabulary, invariant-aware acceptance, typed finding
adapters for bugs/assets/migrations/mod conflicts, wish/run artifacts, and later
story-as-instrument evaluation.

**Exit:** useful Vesserin work runs through the generic core without placing
Vesserin concepts inside core packages.

**First target:** Observation Projection v0 for the existing deterministic
movement bootstrap. Vesserin first freezes the actor/overhead schemas, test
oracles, visibility decisions, a premium-authored `party.move` requester
boundary, and separate protected source contracts; Conductor workers then edit
dedicated implementation files. The full M2 party-space package follows only
after Vesserin repairs its open world-space decision.

## Later — hostile experimental execution

Disposable VM workers, immutable verifier VMs, inference broker, artifact
import boundary, evolutionary engine lineages, and deliberate escape tests.

**State:** bounded container-verifier scaffold implemented and fail-closed on
the currently outdated Docker engine. Hypervisor-backed microVM execution,
private-clone import, and immutable verifier separation remain required before
hostile autonomous gameplay execution.
