# Extra High review register

This register records the Extra High architecture and threat-model outcomes.
Resolved items retain their residual boundaries so later work cannot silently
widen them.

> **Ultra follow-up, 2026-08-04:** the implementation review at `5bf3cf2`
> reopened the first two outcomes below. Attempt fencing, pre-launch recovery,
> lease repair, and the supported Windows process/cleanup boundary were later
> closed by the revisions named in their sections. Schema-readable
> queue/attempt convergence was closed by `1a3f908`. Complete review-evidence
> binding and resource ceilings remain open; no individual closure is a claim
> of unattended readiness. The remaining corrective gates live in
> `vesserin-backend-generation-plan.md`.

## Orphan process recovery

**Outcome: resolved for the supported Windows lane by `caae1c8`, `726e1cf`,
`3afab31`, and `77c2b54`.** Every command is launched through a separate
guardian owned by a PowerShell 7 Windows Job host. The Job is configured and
verified for kernel kill-on-close before Conductor authorizes worker start; its
v2 identity and containment claim are persisted first. Recovery never kills a
bare PID. Guardian events use a nonce-bound control channel separate from
worker stdout and stderr, so worker bytes cannot spoof ownership or exit
evidence.

Normal root exit, cancellation, timeout, owner crash, early cancellation during
host startup, detached Node and Bun descendants, and delayed canaries are
covered. Termination observations and process/resource/workspace cleanup live
in a separate versioned record; failed or unknown cleanup blocks retry without
rewriting the terminal worker result. Bounded Git worktree removal is inside the
same process boundary.

Residual boundary: PowerShell 7 startup is currently paid per command and is a
performance cost, not an authority shortcut. The POSIX process-group fallback
cannot prove that a descendant did not create a new session, so its result is
`unknown`; qualify cgroup-backed ownership before declaring a POSIX unattended
lane. Queue/attempt repair is separately bounded by the HARD-006 closure at
`1a3f908`; malformed whole-record state remains blocked.

## Lease stealing and filesystem semantics

**Outcome: single-host lease repair resolved by `243b0ec`; schema-readable
runtime convergence later resolved by `1a3f908`.** Lease records carry a
monotonic generation, random
instance identity, hostname, process identity, and timestamps. Renewal and
release require the exact generation. Release first atomically renames the
exact lock, so a stale owner cannot delete its successor. A valid dead-owner
lease is recovered only on the same host and is preserved before a successor
is created; a live process keeps ownership through suspend. Future expiry does
not defeat direct same-host process-absence evidence after clock rollback.

Missing and malformed records now receive typed dry-run classifications after
an initialization grace period. Repair output is only a proposal. Mutation
requires a separate attributable owner approval and the exact unchanged
evidence token, then moves the raw directory to durable quarantine rather than
deleting it. A recoverable reconciliation mutex closes the repair-owner crash
window. The malformed, missing, stale, suspend, clock, remote-host, concurrent
owner, and crashed-reconciler tests pass on the implementing revision.

The later HARD-006 action protocol adds typed queue reset, quarantine, binding,
terminal projection, and cleanup-gated orphan recovery. Its exhaustive status
model and crash-replay evidence live in `reconciliation-state-matrix.md`; it
does not change the lease authority described here.

Residual boundary: SMB, mapped network drives, shared Tailscale filesystems,
clock-independent distributed fencing, and multi-host dispatch remain
unsupported. Remote clients should call one host-owned Conductor service rather
than sharing its queue directory.

## Dependent proposal composition

**Outcome: resolved as hash-bound proposal ancestry.** A child reservation
binds exact eligible parent attempts and recursively flattens their ancestry.
Every contribution records its job fingerprint, source and patch baseline,
patch path/size/SHA-256, and verification path/SHA-256. Bindings are revalidated
before application. Ordered patches are applied to a fresh worktree and turned
into a deterministic detached commit without hooks, merges, branch updates, or
even a Conductor-owned ref. The child patch and scope are measured from this
effective baseline, not from canonical source. Worker prompts identify both
revisions and explicitly call inherited changes unaccepted context.

Conflicts, tampering, missing evidence, ineligible, rejected, or superseded
parents, repository mismatch, or source-revision mismatch quarantine the child
before its worker starts. Review handoff revalidates ancestry again. Canaries
cover a three-level lineage, exact baseline reconstruction, post-reservation
patch tampering, and conflicting sibling proposals.

Residual boundary: cross-revision rebasing and semantic conflict resolution are
not automatic. The detached derived object may be garbage-collected after its
worktree disappears; durable contribution evidence is the authority and can
reconstruct it exactly.

## Hostile generated-code execution

**Outcome: container verifier implemented; hostile autonomy remains gated.**
External jobs now freeze an owner-side, digest-pinned Docker profile. Only
file-edit-only host workers qualify. Container commands have no inherited host
environment, no network, a read-only root, non-root UID, zero capabilities,
no-new-privileges, Docker's default seccomp policy, bounded CPU/memory/PIDs, a
bounded tmpfs, and only the proposal worktree mounted read-write. Container
paths are independently allowlisted. Named resources and cleanup commands are
persisted; cancellation removes them and restart recovery cannot retry until
cleanup succeeds or absence is proven.

The real canary passed root-write, network, secret, Docker-socket, UID,
capability, cancellation, and leftover-container probes. The complete result is
still **not ready**: Docker Desktop 4.54.0 / Engine 29.1.2 is below the required
29.6.2 security floor. External job preparation and `doctor` fail closed.

Residual kill gate: ordinary containers share the Linux VM kernel and mount the
worktree read-write. They are appropriate for bounded verifier commands after a
Docker update, not arbitrary hostile agents. Before enabling the self-directed
gameplay wish loop, implement a hypervisor-backed microVM driver—preferably
Docker Sandboxes in `--clone` mode—with no shared skills, locked-down network,
an immutable evaluator, artifact schema/hash/size validation, and deliberate
VM escape/import canaries. This is a real authority and deployment boundary,
not an instruction-level invariant.

Primary references for this boundary are Docker's documentation for
[container run isolation options](https://docs.docker.com/reference/cli/docker/container/run/),
[the default seccomp profile](https://docs.docker.com/engine/security/seccomp/),
[Engine 29 security releases](https://docs.docker.com/engine/release-notes/29/),
and the separate Docker Sandboxes
[security](https://docs.docker.com/ai/sandboxes/security/) and
[isolation](https://docs.docker.com/ai/sandboxes/security/isolation/) model.
