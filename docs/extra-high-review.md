# Extra High review register

These items are deliberately not resolved under the current reasoning level.
They do not block conservative unattended proposal generation, but widening
automation across them requires a fresh Extra High architecture and threat-model
review.

## Orphan process recovery

Current behavior quarantines an item as `needs-input` when dispatcher ownership
is recovered while its attempt manifest remains active. It does not kill a
recorded PID or automatically duplicate the attempt. Before automatic retry,
design a process identity stronger than a bare PID and validate Windows Job
Object kill-on-close behavior, PID reuse, machine suspend, and a process that
outlives its original dispatcher.

## Lease stealing and filesystem semantics

The queue has one directory lease with heartbeats and stale-owner recovery.
Before treating this as a distributed or network-filesystem lease, review the
compare-and-swap guarantees required during lease renewal, stealing, and
release on NTFS versus SMB/Tailscale-accessed storage. Today it is a
single-machine, single-dispatcher boundary.

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
