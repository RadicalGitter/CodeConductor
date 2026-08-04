# Kode delegate parity map

- Baseline repository: `Z:\Programmering\Kode-CLI`
- Baseline revision: `328676d`
- Baseline package: `packages/mcp-delegate`
- Target: independent Conductor implementation

This is interface and workflow compatibility, not source extraction. Baseline
source remains available only as historical evidence until parity is accepted.

| Workflow or contract                                     | Baseline evidence              | Target owner                | Status      | Verification                                               |
| -------------------------------------------------------- | ------------------------------ | --------------------------- | ----------- | ---------------------------------------------------------- |
| List available Kode/Codex/Claude backends                | MCP `list_delegate_backends`   | Worker registry             | partial     | Kode/Codex MCP characterization; Claude and probes pending |
| Create sibling worktree at exact base revision           | Returned `WorktreeHandle`      | Workspace manager           | implemented | disposable Git integration test                            |
| Explicit conservative permission defaults                | Adapter argument builders      | Worker adapters             | implemented | Kode safe and Codex workspace-write snapshots              |
| Stable job and attempt IDs                               | `kode-delegate-result/v2`      | Job store                   | implemented | concurrent reservation and replay tests                    |
| Freeze objective/repository/base ref                     | `job.json`                     | Job store                   | implemented | schema, exact revision, and mismatch rejection             |
| Durable atomic attempt manifest                          | `manifest.json`                | Artifact store              | implemented | concurrent atomic reservation/readback                     |
| Store stdout/stderr separately                           | attempt artifacts              | Artifact store              | implemented | process and orchestration content tests                    |
| Distinguish timeout/cancel/spawn/backend/harness failure | manifest fields                | Process runner/orchestrator | partial     | typed failures; full lifecycle matrix pending              |
| MCP cancellation reaches complete Windows process tree   | `AbortSignal`, `taskkill /T`   | Process runner              | implemented | verified Job Object; descendant and owner-crash canaries   |
| Retain worktree after completion or cancellation         | explicit cleanup tool          | Workspace manager           | implemented | orchestration lifecycle test                               |
| Explicit worktree removal                                | MCP `remove_delegate_worktree` | Workspace manager           | implemented | exact recorded target and managed-root check               |
| Caller-specified attempt replay is idempotent            | duplicate result               | Orchestrator                | implemented | same-key no-respawn and conflicting-key rejection          |

## Deliberate first-version changes

- Conductor schemas use a provider-neutral `conductor.*` namespace rather than
  `kode-delegate-*`.
- Job contracts include scope, context, constraints, acceptance commands, and
  escalation triggers from the start.
- Worker output never shares a schema with authoritative acceptance.
- Kode-specific executable discovery and CLI flags live only in its adapter.
- Conductor is private and `UNLICENSED`; no Kode implementation source is
  copied into it.

## Known baseline issues not preserved

- Permission mode strings did not mechanically enforce allowed paths.
- Worktrees did not receive a dependency/setup strategy.
- Acceptance commands were described but not executed by the harness.
- `needs-input` existed in the type vocabulary but was not parsed from worker
  output.
- Full-suite evidence was impractical to obtain inside short test bounds.

## Parity exit evidence

The same disposable canary has run through Kode's `328676d` delegate prototype
and Conductor as separate MCP subprocesses. Both completed from the same
revision, isolated the primary checkout, persisted output, replayed without a
second spawn, and removed their worktrees through public tools. See
[`verification.md`](verification.md). No Kode implementation source is imported
or linked.

## HARD-001/HARD-002 lifecycle transition refactor

- Conductor baseline revision: `2a42d0a`
- Implementing revision: `a84e8fc`
- Target: one durable launch path with revision-fenced queue and attempt state
- Scope: transition ownership and pre-launch crash windows only

| Workflow or contract                                  | Baseline behavior                                    | Target parity                                                                        | Verification                                   |
| ----------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `submit_coding_job` input and non-blocking handoff    | freezes, reserves, and launches directly             | same input; returns queue wrapper and flows only through the owned dispatcher        | MCP contract and compatibility submission test |
| `enqueue_coding_job` dependency and priority behavior | durable queue with bounded concurrency               | same with explicit `dispatching` evidence                                            | queue integration tests                        |
| Existing `conductor.queue-item/v1` records            | readable without a revision                          | read as revision zero and upgrade to v2 on the next transition                       | legacy fixture round trip                      |
| Existing `conductor.attempt/v1` records               | readable without a revision                          | read as revision zero and upgrade to v2 on the next transition                       | legacy fixture round trip                      |
| One reserved attempt started concurrently             | can pass multiple read-before-launch checks          | deliberate fix: exactly one durable claim and one workspace creation                 | 100-caller race test                           |
| Crash before attempt reservation                      | running item without an attempt becomes ambiguous    | deliberate fix: durable operation identity returns safely to queued                  | failpoint/restart test                         |
| Crash after attempt reservation but before launch     | queue and attempt can lose their relationship        | deliberate fix: reconstruct by operation identity, then retry or quarantine honestly | failpoint/restart test                         |
| Cancellation while a process is active                | queue may say `cancelled` before attempt termination | safer internal behavior: expose `cancelling` until terminal attempt evidence exists  | cancellation transition test                   |
| Job, attempt, artifact paths, and proposal semantics  | current provider-neutral formats                     | unchanged except additive transition metadata                                        | full suite and artifact-path assertions        |

Known defects deliberately deferred from this slice: complete OS process-tree
ownership, malformed lease repair, immutable terminal cleanup records, complete
review-evidence sealing, quotas, and the public reconciliation command. Their
current status is tracked in [`hardening-register.md`](hardening-register.md)
and the later extensions below; passing this historical parity table did not
close them implicitly.

The complete pre-launch termination outcomes are recorded in the
[dispatch fault matrix](dispatch-fault-matrix.md). HARD-001 and HARD-002 are
closed on `a84e8fc`. At that revision, lease repair, public reconciliation,
immutable cleanup records, and complete queue validation remained separate
tracked work; the lease-repair extension below records the later HARD-005
closure without implying closure of the broader Phase 1 state machine.

## HARD-005 lease-repair extension

- Implementing revision: `243b0ec`
- Target: preserve single-host ownership while making damaged lease evidence
  explainable and recoverable

| Prior behavior                                                            | Target behavior                                                                                              | Verification                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Missing or malformed `lease.json` silently prevented acquisition forever  | classify initialization, incomplete, and corrupt states; return an evidence-bound owner proposal after grace | missing/malformed/stale-directory characterization and CLI tests |
| Expiry was required before recovering a dead local process                | direct same-host process absence authorizes recovery even after clock rollback; old bytes are preserved      | future-expiry dead-owner test                                    |
| An expired live PID was conservatively refused but not explained publicly | report `expired-live-local`, wait, and never steal                                                           | suspend-safe test                                                |
| Local PID state could be misapplied to another host                       | report `active-remote` and require host-owner judgment                                                       | remote-host test                                                 |
| Stolen dead leases were deleted                                           | move them under their SHA-256 evidence token before creating a successor                                     | evidence directory and generation assertions                     |
| Concurrent repair had no durable ownership protocol                       | staged local mutex, exact release, dead-owner recovery, and retained mutex evidence                          | two-recoverer, two-action, and dead-reconciler tests             |
| No public inspection survived failed dispatcher startup                   | standalone `reconcile --dry-run`, plus MCP inspection and typed action surfaces                              | CLI subprocess and MCP contract tests                            |

This closes HARD-005 only. At that revision, the same dry-run reported
queue/attempt relationship defects but did not mutate them. The later
HARD-006 extension below records their typed convergence.

## HARD-003/HARD-004 process and cleanup extension

- Implementing revisions: `caae1c8`, `726e1cf`, `3afab31`, and `77c2b54`
- Supported lane: Windows with PowerShell 7 and verified Job Object ownership
- Target: prove complete owned-process closure and keep cleanup truth separate
  from immutable worker outcome

| Prior behavior                                                           | Target behavior                                                                                              | Verification                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Detached descendants could survive normal root exit                      | verified kill-on-close Job contains guardian and descendants before launch                                   | Node/Bun descendant, delayed-canary, cancel, timeout, owner-crash      |
| Guardian disappearance was treated conservatively but could not prove it | absent persisted v2 Windows Job owner proves closure; legacy/POSIX evidence remains `unknown`                | restart recovery and legacy quarantine tests                           |
| Kill and resource cleanup were folded into terminal attempt updates      | independent `cleanup.json` with requirements, append-only observations, and monotonic revisions              | immutable-terminal and converging-cleanup tests                        |
| Cleanup failure could be hidden by a successful worker                   | queue/retry/removal require proven cleanup; reconciliation and `get_attempt_cleanup` expose unresolved state | injected external and workspace cleanup failures                       |
| Git worktree removal could outlive its caller                            | resolved Git executable runs under the same Job boundary and one bounded workspace-cleanup deadline          | orchestration cleanup integration and process timeout characterization |

This extension closes HARD-003 only for the named Windows profile and closes
HARD-004. It does not itself close public queue/attempt repair, evidence
sealing, resource quotas, or a POSIX unattended lane.

## HARD-006 runtime-reconciliation extension

- Implementing revision: `1a3f908`
- Target: converge every schema-readable queue/attempt relationship through a
  bounded action or an exact missing-evidence explanation

| Prior behavior                                              | Target behavior                                                                               | Verification                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Queue/attempt findings were diagnostic only                 | return exact-token reset, quarantine, bind, terminal projection, or orphan-recovery proposals | all 80 queue/attempt status pairs and MCP/CLI tests |
| Approval could race newer state                             | persist intent, acquire the dispatcher lease, and recheck full state evidence                 | stale and manufactured action refusal               |
| A reconciler crash after mutation could obscure the result  | recognize only the typed postcondition and reconstruct one result record                      | abrupt child-process death after mutation           |
| Repair risked widening normal transitions                   | use an action-specific reconciliation validator                                               | unauthorized postcondition rejection                |
| Terminal or cleanup truth could be guessed from queue state | derive only from immutable attempt plus cleanup; return blocked when cleanup is unknown       | terminal synchronization and orphan recovery tests  |

The detailed authority and failure matrix is
[`reconciliation-state-matrix.md`](reconciliation-state-matrix.md). Malformed
whole-record bytes remain blocked diagnostics rather than reconstructed truth.

## HARD-007 review-evidence extension

- Implementing revision: `657f0ca`
- Target: make review availability depend on the complete frozen evidence
  graph rather than one patch checksum

| Prior behavior                                                     | Target behavior                                                                                                               | Verification                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Cached review retrieval rechecked only the patch                   | validate job, terminal attempt, cleanup, verification, status, paths, all logs, lineage, profile files, and attempt inventory | complete binding and purpose assertions                    |
| Harness/model settings were observed only from the current runtime | persist an exact launch-time adapter/options/invocation profile and file hashes before worker start                           | missing-model ineligibility and harness/config drift tests |
| Same-size replacement or added evidence could pass unnoticed       | bind byte sizes and SHA-256 plus recursive file/directory inventory                                                           | mutation, replacement, deletion, and addition matrix       |
| A changed terminal projection could redirect a later read          | compare compact projections with authoritative journals and validate paths first                                              | authoritative transition path-redirection test             |
| Concurrent or restarted readers could produce inconsistent caches  | derive deterministic v2 packets and serialize same-process creation                                                           | twenty-reader and restart-without-worktree tests           |
| Legacy cached packets implied more integrity than they carried     | refuse v1 as `legacy-unsealed`                                                                                                | explicit legacy-cache test                                 |

[`review-evidence-seal.md`](review-evidence-seal.md) records the retrieval
sequence, exact bindings, and residual trust boundary.
