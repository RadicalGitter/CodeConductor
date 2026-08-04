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

Independent contracts can run concurrently and dependency order is enforced,
but a dependent job still starts from its own frozen repository revision. To
let later gameplay contracts consume earlier unaccepted proposals, design a
proposal-only composition lineage—likely immutable Git trees/commits under a
Conductor-owned ref namespace—without laundering that lineage into canonical
project history or invoking repository hooks.

## Hostile generated-code execution

Worktrees protect the primary checkout, not the host. Setup, workers, and test
commands can still consume host resources or exploit their permitted process.
Before enabling generated-code execution from gameplay wishes without human
review, specify the disposable VM boundary, immutable verifier, mount and
network policy, secret absence, resource ceilings, artifact import validation,
and escape canaries.
