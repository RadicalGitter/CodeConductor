# Unattended hardening register

- Status: open
- Baseline: `5bf3cf2`
- Governing plan: [Vesserin backend generation plan](vesserin-backend-generation-plan.md)
- Readiness while any P0 item is open: attended trusted-worker trials only

This register turns the Ultra implementation review into durable work items.
An item is not closed by a plausible patch or one passing example. Closure
requires the named characterization, adversarial evidence, and documentation
update on the exact implementing revision.

## HARD-001 — singular attempt claim

- Severity: P0
- State: closed by `a84e8fc`
- Failure: concurrent launch paths can claim one reserved attempt more than
  once.
- Required change: one compare-and-transition engine with an incrementing
  record revision and durable `dispatchOperationId`; scheduler-only launch.
- Required evidence: at least 100 randomized simultaneous-start trials launch
  exactly one worker; late callbacks and retries cannot regress terminal state.
- Closure updates: runtime contract, architecture, operations, and queue tests.
- Evidence: 100 deterministic randomized rounds, each with 2–20 jittered
  simultaneous callers, entered the launch seam exactly once. A separate
  integration race sent 100 jittered callers to one real fixture attempt and
  observed one successful caller, one worktree creation, and one completed
  worker. Revision-conflict tests prove stale attempt callbacks and stale queue
  completion after retry cannot overwrite newer state.

## HARD-002 — dispatch crash windows

- Severity: P0
- State: closed by `a84e8fc`
- Failure: process termination between queue intent, attempt reservation,
  queue binding, and launch can leave duplicate, invisible, or permanently
  nonterminal work.
- Required change: explicit `dispatching` state, durable transition journal,
  startup scan of every nonterminal attempt, and test-only persistence
  failpoints.
- Required evidence: termination after every authoritative write produces
  exactly resume, safe new attempt, or actionable quarantine; no job or attempt
  disappears from reconciliation.
- Closure updates: runtime contract, operations, fault matrix, and recovery
  tests.
- Evidence: a fresh child process is terminated with exit code 91 immediately
  after queue intent, attempt reservation, queue binding, and attempt claim.
  Each restart reacquires the expired dead-owner lease, scans all attempts,
  cancels any unlaunched orphan, and converges on exactly one completed worker
  with no nonterminal remainder. In-process failpoint repetitions cover the
  same matrix, and a journal/projection fault proves recovery from the
  authoritative snapshot when the compact projection was not refreshed. See
  the [dispatch fault matrix](dispatch-fault-matrix.md).

## HARD-003 — complete process-tree closure

- Severity: P0
- State: closed for the supported Windows lane by `caae1c8` and `726e1cf`
- Failure: a direct worker can exit normally while a detached descendant
  survives.
- Required change: OS-enforced tree ownership on supported hosts, including
  Windows Job Objects with kill-on-close, plus cleanup on normal exit,
  cancellation, timeout, and owner crash.
- Required evidence: worker/child/grandchild and delayed-canary tests prove
  absence after every exit path; absence that cannot be proved quarantines the
  attempt and blocks retry.
- Closure updates: architecture, operations, Extra High register, and process
  tests.
- Evidence: every setup, worker, acceptance, external-cleanup, and bounded Git
  cleanup command is placed in a Windows Job Object before it is authorized to
  start. The separately persisted v2 guardian record binds the Job owner and
  records verified kernel-enforced kill-on-close. Normal root exit,
  cancellation, timeout, and Conductor owner-crash canaries cover detached
  Node and Bun descendants and delayed file writes; no canary survives. A
  launch-gate test proves that missing ownership evidence prevents the worker
  from starting. Recovery treats an absent verified v2 Job owner as positive
  closure evidence, while legacy v1 guardians and non-kernel POSIX process
  groups remain `unknown` and cannot authorize retry. PowerShell 7 is therefore
  part of the supported Windows runtime profile; no POSIX unattended lane is
  claimed until an equivalent cgroup-backed implementation is qualified.

## HARD-004 — termination and cleanup evidence

- Severity: P0
- State: closed by `726e1cf`, `3afab31`, and `77c2b54`
- Failure: kill or cleanup failure can be swallowed, allowing state to imply
  closure without durable proof.
- Required change: typed cleanup records separate from immutable terminal
  worker outcome, bounded cleanup deadline, and explicit `unknown` or
  quarantine result when absence is unproved.
- Required evidence: injected kill, cleanup, and external-resource failures
  never report safe retry or silent completion; reconciliation explains the
  least-authority next action.
- Closure updates: attempt schema, status/explain surfaces, and cleanup tests.
- Evidence: attempt reservation atomically creates a versioned `cleanup.json`;
  requirements and observations advance through an append-only revision
  journal independently of the immutable terminal worker manifest. Process
  trees, external resources, and workspaces have typed subjects, deadlines,
  and `proven`, `failed`, or `unknown` observations. Prior failures remain in
  history even after a later observation proves closure. Queue completion,
  retry, recovery, and workspace removal all refuse unresolved cleanup, while
  `get_attempt_cleanup` and reconciliation expose the exact state. Injected
  external cleanup and workspace-removal failures preserve the worker outcome,
  retain the worktree, and block retry. Workspace removal and Git pruning are
  themselves bounded, OS-owned processes; timeouts or unproved termination are
  recorded as failure rather than silently detached. The complete repository
  gate passed with 63 tests and 581 assertions after the final removal gate was
  added.

## HARD-005 — malformed or missing lease recovery

- Severity: P0
- State: closed by `243b0ec`
- Failure: missing or malformed lease evidence can wedge dispatch indefinitely.
- Required change: classify corrupt lease states, preserve their evidence, and
  provide dry-run repair or actionable quarantine without unsafe PID authority.
- Required evidence: malformed JSON, missing record, stale directory, suspend,
  clock change, and two-dispatcher cases all converge or identify the exact
  authority needed.
- Closure updates: runtime contract, Extra High register, doctor/reconcile, and
  lease tests.
- Evidence: versioned inspection distinguishes absent, initializing, live
  local, expired-but-live local, remote, dead local, incomplete, and corrupt
  states. Same-host dead owners recover even with future expiry and preserve
  the old lease under its SHA-256 evidence token. Missing or malformed records
  become eligible for quarantine only after the initialization grace period;
  dry-run returns a proposal while mutation requires a separate named,
  timestamped owner approval and an unchanged token. The standalone command
  remains available when dispatcher startup cannot succeed. Tests cover
  malformed JSON, missing records, stale directories, a live expired owner
  after suspend, a dead owner after clock rollback, remote-host refusal,
  simultaneous recoverers, simultaneous owner actions, stale action tokens,
  and a reconciliation-owner crash. The complete 56-test repository gate
  passed on the implementing revision.

## HARD-006 — public recovery convergence

- Severity: P0
- State: closed for schema-readable single-host state by `1a3f908`
- Failure: some terminal-queue/nonterminal-attempt and live-or-missing identity
  quarantines have no complete public recovery path.
- Required change: versioned legal transition table and `reconcile --dry-run`
  with narrowly typed owner actions; never a general force-complete command.
- Required evidence: every synthesized queue/attempt combination reaches a
  durable terminal state or an actionable quarantine after restart.
- Closure updates: CLI/MCP schemas, operations, and model-based transition
  tests.
- Closure evidence: the public CLI and MCP expose five narrowly typed actions
  for reset, quarantine, exact operation rebinding, immutable terminal
  projection, and cleanup-gated orphan recovery. Approval intent is persisted
  before mutation; exact retries replay one result, mutation-before-result
  owner death reconstructs evidence, stale or manufactured actions are
  refused, and live owners suppress competing action authority. The pure model
  exercises all 80 queue/attempt status pairs under owned and unowned leases
  (450 assertions), plus wrong-job, ambiguous-operation, corrupt-completion,
  and missing-cleanup probes. The action suite exercises the standalone CLI,
  MCP, actual process death, and negative authority cases. The complete gate
  passed with 79 tests and 1,089 assertions. See
  `reconciliation-state-matrix.md` for the preserved transient harness signal
  and full boundary.
- Residual boundary: malformed whole-record bytes remain a blocked diagnostic,
  not permission to invent queue, attempt, or cleanup truth. Missing real-world
  cleanup evidence returns a durable `blocked` result. These cases require the
  named evidence to become readable or provable; they are not force-complete
  escape hatches.

## HARD-007 — complete review evidence binding

- Severity: P0 for Vesserin pilot
- State: closed by `657f0ca`
- Failure: cached review retrieval revalidates the patch but not every artifact
  on which eligibility and review claims depend.
- Required change: immutable or content-addressed terminal evidence and
  validation of job, attempt, status, paths, checks, logs, lineage, and exact
  model/harness profile on every availability transition.
- Required evidence: mutating, deleting, replacing, or adding any bound artifact
  makes the bundle corrupt or unavailable; restart plus worktree removal still
  reconstructs valid evidence.
- Closure updates: runtime contract, review packet schema, evidence verifier,
  and tamper matrix.
- Closure evidence: packet v2 embeds and seals the frozen job, immutable
  terminal attempt, cleanup, verification, paths, inventory, lineage, worker
  and command logs, and the launch-time model/harness profile. Retrieval
  validates every binding before and after the bounded patch read. The tamper
  matrix covers mutation of every local binding, same-size replacement,
  deletion, addition, packet corruption, legacy cache refusal, transition-path
  redirection, harness/config drift, cached-lineage drift, twenty simultaneous
  creators, restart, and removed worktree reconstruction. See
  `review-evidence-seal.md`. The complete gate passed with 82 tests and 1,136
  assertions.
- Residual boundary: this is hash-bound local integrity, not a signature
  against an administrator rewriting the entire evidence graph. It binds the
  requested model profile and local harness/config bytes; live inference-server
  attestation remains broader Phase 3 provenance work.

## HARD-008 — bounded resources and retention

- Severity: P0 for overnight use
- State: confirmed; open
- Failure: command count, total attempt time, output, patch, artifacts,
  worktrees, retries, and external resources are not all bounded and reconciled.
- Required change: owner-profiled quotas, size-aware writes, deliberate
  retention classes, `gc --dry-run`, and external-resource reconstruction from
  frozen owner profiles.
- Required evidence: hung commands, output floods, oversized proposals, disk
  pressure, cleanup failure, and restart cannot exceed a declared bound or
  become invisible.
- Closure updates: operations, doctor/status, artifact contracts, and quota
  tests.

## Gate summary

- Attended generic canary: HARD-001 through HARD-007 closed for the exercised
  lane; HARD-008 enforced at the canary ceilings.
- Vesserin leaf canary: all items closed, plus the Vesserin verifier and
  project-profile qualification gates in the governing plan.
- Overnight trusted proposal production: all items closed under the exact
  machine, worker, model, and execution-boundary profiles in use.

Reopening an item preserves its prior evidence and appends the new failing
revision, reproducer, and disposition. Never rewrite a negative result into a
clean history.
