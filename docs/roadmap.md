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

## Slice 3 — contract-source compiler

Project plugins discover structured source comments, bind them to symbols,
compile a dependency graph, and produce frozen job contracts. Polling is
incremental and deterministic; comments are proposal sources rather than
runtime authority.

**Exit:** two small comment-authored contracts execute in dependency order and
remain reconstructable after restart.

## Slice 4 — queue and parallelism

Durable queue, leases, bounded concurrency, compact completion events, read-only
fan-out, and isolated mutating workers.

**Exit:** simultaneous work improves accepted throughput without shared mutable
workspaces or duplicate attempts.

## Slice 5 — independent semantic review

Hash-bound review bundles, configurable Sonnet/other reviewers, typed findings,
bounded correction attempts, reviewer ablation metrics, and compact handoff.

**Exit:** review measurably improves hidden-check survival or is disabled as an
uneconomic route.

## Slice 6 — Vesserin plugin

Impact Atlas context retrieval, Vesserin contract vocabulary, invariant-aware
acceptance, wish/run artifacts, and later story-as-instrument evaluation.

**Exit:** useful Vesserin work runs through the generic core without placing
Vesserin concepts inside core packages.

## Later — hostile experimental execution

Disposable VM workers, immutable verifier VMs, inference broker, artifact
import boundary, evolutionary engine lineages, and deliberate escape tests.
