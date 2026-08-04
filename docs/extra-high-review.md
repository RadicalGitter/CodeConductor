# Extra High review register

This register records the Extra High architecture and threat-model outcomes.
Resolved items retain their residual boundaries so later work cannot silently
widen them.

## Orphan process recovery

**Outcome: resolved for local-host automatic retry.** Every command is launched
through a separate Node guardian. Its identity is persisted before the guarded
worker starts, and an ownership pipe makes dispatcher death trigger complete
worker-tree termination. A recovered job is retried as a new attempt only when
the guardian is gone. A live or missing identity is quarantined, and recovery
never kills a bare PID. Guardian events use a nonce-bound control channel that
is separate from worker stdout and stderr. Adversarial tests prove worker log
bytes cannot spoof exit evidence, then crash the owning process and prove the
guardian, worker, descendant, and delayed filesystem canary all die.

Residual boundary: a reused guardian PID can conservatively delay work until
human inspection; it cannot authorize a kill or duplicate attempt. Native
Windows Job Objects may reduce latency later but are not required for the
ownership invariant.

## Lease stealing and filesystem semantics

**Outcome: resolved as a deliberately local lease.** Lease records now carry a
monotonic generation, random instance identity, hostname, process identity, and
timestamps. Renewal and release require the exact generation. Release first
atomically renames the exact lock, so a stale owner cannot delete its
successor. Expiration permits recovery only on the same host after the owner PID
is gone; a live process keeps ownership through suspend. UNC roots are rejected.

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
