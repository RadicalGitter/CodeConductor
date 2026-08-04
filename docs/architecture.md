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
job:     proposed -> validated -> active -> completed
                              \-> cancelled

attempt: reserved -> preparing -> running -> completed | failed
                                          \-> needs-input | cancelled

proposal: completed -> review-pending -> accepted | rejected | superseded
```

Attempt terminal state is never overwritten by review disposition. A retry is a
new attempt under the same frozen job.

## Execution boundary

The first slice provides worktree isolation and conservative subprocess modes.
That protects the primary checkout but is not a hostile-code sandbox. Later VM
execution will implement the stronger boundary required for autonomous
generated-code experiments.

Allowed and forbidden paths are checked independently of worker prose. Setup
and acceptance commands use typed executable-plus-argument arrays, never shell
strings. Network, secrets, resource limits, and host mounts belong to runtime
policy or the stronger executor, not `AGENTS.md`.

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
