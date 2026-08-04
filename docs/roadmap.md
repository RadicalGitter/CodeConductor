# Roadmap

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

**State:** local-host core implemented. Queue items, dependency gates, bounded
concurrency, compact completion records, generation-fenced leases, guardian-
owned process trees, and safe orphan retry are characterized. Live or unknown
process identity is quarantined. UNC roots are rejected; cross-machine and
network-filesystem dispatch remain explicitly unsupported.

## Slice 5 — independent semantic review

Hash-bound review bundles, configurable Sonnet/other reviewers, typed findings,
bounded correction attempts, reviewer ablation metrics, and compact handoff.

**Exit:** review measurably improves hidden-check survival or is disabled as an
uneconomic route.

**State:** packet foundation implemented. Eligible terminal attempts can emit
a durable advisory packet containing the frozen contract, verification,
changed paths, evidence hashes, and a bounded patch. Patch tampering is detected
before handoff. No reviewer is invoked and no finding can accept or mutate work;
reviewer adapters, typed persisted findings, bounded correction, and ablation
measurement remain future work.

## Slice 6 — Vesserin plugin

Impact Atlas context retrieval, Vesserin contract vocabulary, invariant-aware
acceptance, wish/run artifacts, and later story-as-instrument evaluation.

**Exit:** useful Vesserin work runs through the generic core without placing
Vesserin concepts inside core packages.

## Later — hostile experimental execution

Disposable VM workers, immutable verifier VMs, inference broker, artifact
import boundary, evolutionary engine lineages, and deliberate escape tests.

**State:** bounded container-verifier scaffold implemented and fail-closed on
the currently outdated Docker engine. Hypervisor-backed microVM execution,
private-clone import, and immutable verifier separation remain required before
hostile autonomous gameplay execution.
