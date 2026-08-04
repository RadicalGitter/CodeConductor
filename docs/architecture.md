# Architecture

- Status: initial authority and ownership contract
- Date: 2026-08-04

## Intent

Maximize accepted useful work per unit of scarce owner and premium-agent
attention while preserving enough evidence to reject, repair, reproduce, and
route every attempt honestly.

## Ownership

| Layer                      | Owns                                                                                                | Must not own                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Owner or premium architect | Scope, taste, consequential decisions, canonical integration                                        | Verbose worker polling                           |
| Conductor core             | Job IDs, attempts, policy, queues, workspaces, process lifecycle, artifacts, checks, review packets | Coding judgment or project-specific truth        |
| Worker adapter             | Executable discovery and one harness's argument/event translation                                   | Job policy, retries, worktrees, acceptance       |
| Worker harness/model       | One bounded attempt in its assigned workspace                                                       | Wider scope, canonical merge, evaluator mutation |
| Deterministic verifier     | Contract shape, path scope, commands, hashes, repository state                                      | Semantic taste                                   |
| Semantic reviewer          | Findings and correction proposals against a frozen packet                                           | Mutation, merge, publication, security authority |
| Project plugin             | Project-specific contract discovery, context packs, invariants, and presentation                    | Core process or permission policy                |

No two layers own the same state transition. In particular, the outer runtime
is the only owner of retries, cancellation, worktree allocation, and attempt
status.

## Artifact classes

| Artifact                                | Class                                        | Authority                                |
| --------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| Project repository and accepted commits | Authoritative                                | Owning repository                        |
| Job contract                            | Authoritative for one job                    | Conductor after schema/policy validation |
| Attempt manifest and raw logs           | Audit evidence                               | Append/update only through Conductor     |
| Worker patch                            | Proposal                                     | Worker attempt                           |
| Check results                           | Audit evidence                               | Deterministic runner                     |
| Semantic review                         | Proposal                                     | Reviewer adapter                         |
| Acceptance disposition                  | Authoritative orchestration decision         | Configured owner/policy boundary         |
| Contract comments in project source     | Proposal source until compiled and validated | Owning project/plugin                    |

## Lifecycle

```text
queue:   queued -> running -> completed
              \-> cancelled | failed | needs-input

attempt: reserved -> preparing -> running -> verifying -> completed
                              \-> failed      \-> cancelled
                              \-> needs-input

proposal: completed -> review-pending -> accepted | rejected | superseded

lineage: eligible parent proposals -> derived proposal baseline -> child proposal
```

Attempt terminal state is never overwritten by review disposition. A retry is a
new attempt under the same frozen job.

Only one dispatcher lease owns queue-to-process transitions. Independent jobs
may run up to the configured capacity; every mutation still receives its own
worktree. Dependencies gate start, not acceptance: a dependency is satisfied
only by a completed attempt with eligible deterministic evidence.

Dependent work binds the exact completed attempt for each direct dependency and
flattens its eligible ancestry in deterministic order. Patch and verification
hashes, source revisions, patch baselines, and evidence paths are frozen into
the child attempt before workspace mutation. Conductor revalidates the bindings,
applies patches without repository hooks, and creates a deterministic detached
commit whose sole parent is the authoritative source revision. That commit has
no branch or Conductor ref and is reconstructable from durable evidence. It is
a disposable proposal baseline, never a merge or acceptance decision. The
child patch and path scope are measured from that derived baseline, so inherited
parent changes cannot launder wider authority into the child contract.

The local dispatcher lease is generation-fenced. Expiration alone never
authorizes stealing from a live same-host process, so machine suspend cannot
create a second owner. Release removes only the exact owner/instance/generation
that acquired the lease. UNC queue roots are rejected; this is not a
distributed-filesystem lease.

## Execution boundary

The host executor provides worktree isolation and conservative subprocess
modes. It protects the primary checkout but is not a hostile-code sandbox.

An external-sandbox job may use only a host adapter declared file-edit-only;
all setup and acceptance commands are converted to a frozen owner profile. The
current Docker driver requires a digest-pinned image, minimum engine version,
non-root user, read-only root, zero Linux capabilities, no-new-privileges,
default seccomp, no network, no inherited environment, bounded memory/CPU/PIDs,
and one read-write worktree mount. Container command paths have their own
allowlist. Named resources and exact cleanup invocations are persisted before
start; normal completion/cancellation removes them, and orphan recovery must
remove or prove them absent before retry.

This container tier is a bounded generated-code verifier, not the final
hostile-agent boundary. Full autonomy requires a current hypervisor-backed
microVM executor with a read-only source mount/private clone, no shared skills,
deny-by-default network, immutable evaluator, and validated artifact import.

Allowed, forbidden, and protected paths are checked independently of worker
prose. Setup and acceptance commands use typed executable-plus-argument arrays,
never shell strings. They require owner-allowlisted absolute executables, remain
inside the worktree by real path, receive only allowlisted environment names,
and produce separate logs. Setup must leave repository state clean; acceptance
must leave the captured proposal unchanged. Network, stronger secret isolation,
resource limits, and host mounts belong to the VM executor, not `AGENTS.md`.

Every setup, worker, and acceptance subprocess is owned by a separate guardian
process. Conductor persists the guardian identity before the guarded worker is
started and keeps an ownership pipe open. If Conductor exits or crashes, pipe
closure makes the guardian terminate the complete worker tree. Recovery retries
only after the recorded guardian is provably gone; a live or unprovable
identity is quarantined. A PID is never used by itself as authority to kill.

## Extension boundary

Core plugins may contribute:

- contract-source scanners;
- project context and invariant adapters;
- typed acceptance observations;
- review packet enrichers;
- presentation metadata.

Plugins may not bypass job validation, allocate processes directly, write
canonical state, or grant themselves new authority. The planned Vesserin plugin
will compile structured source comments and query the Impact Atlas without
making either concept a core dependency.
