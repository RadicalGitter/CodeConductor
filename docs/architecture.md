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
```

Attempt terminal state is never overwritten by review disposition. A retry is a
new attempt under the same frozen job.

Only one dispatcher lease owns queue-to-process transitions. Independent jobs
may run up to the configured capacity; every mutation still receives its own
worktree. Dependencies gate start, not acceptance: a dependency is satisfied
only by a completed attempt with eligible deterministic evidence.

The local dispatcher lease is generation-fenced. Expiration alone never
authorizes stealing from a live same-host process, so machine suspend cannot
create a second owner. Release removes only the exact owner/instance/generation
that acquired the lease. UNC queue roots are rejected; this is not a
distributed-filesystem lease.

## Execution boundary

The host executor provides worktree isolation and conservative subprocess
modes. It protects the primary checkout but is not a hostile-code sandbox.
Later VM execution will implement the stronger boundary required for
autonomous generated-code experiments.

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
