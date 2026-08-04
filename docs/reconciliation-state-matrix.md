# Runtime reconciliation state matrix

- Implementing revision: `1a3f908`
- Scope: schema-readable queue items, attempt manifests, and cleanup records on
  the single-host runtime
- Result: HARD-006 closed for this scope

Reconciliation preserves three separate authorities:

- the queue owns scheduling and the current queue-to-attempt binding;
- the attempt manifest owns immutable worker outcome and verification state;
- the cleanup record owns process, external-resource, and workspace closure.

No repair action may synthesize worker success, rewrite terminal attempt
evidence, mark cleanup proven without observations, accept a proposal, or
merge code. `reconcile_runtime` and `bun run reconcile --dry-run` only inspect.
Mutation requires an exact returned proposal plus a separately attributable
owner approval.

## Typed owner actions

| Action                                    | Exact precondition                                                           | Authoritative effect                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `reset-abandoned-queue-item`              | queued or dispatching record whose retained dispatch evidence has no attempt | clear dispatch, attempt, and completion fields; return to `queued`                                                                  |
| `quarantine-queue-item`                   | untrusted or irreconcilable queue relationship                               | move queue routing to `needs-input` and clear the binding; retain the prior revision in the journal                                 |
| `bind-queue-to-attempt`                   | one nonterminal attempt has the same job and dispatch operation              | bind that exact attempt and advance the queue to `running`; do not launch or modify the attempt                                     |
| `synchronize-queue-from-terminal-attempt` | terminal attempt and readable cleanup record are bound by exact identity     | derive queue status and completion only from the immutable attempt and cleanup evidence                                             |
| `recover-interrupted-attempt`             | nonterminal attempt has no active dispatcher owner                           | invoke the existing process/resource/workspace evidence gate; return `blocked` rather than force completion when closure is unknown |

Every proposal binds the complete relevant state with a SHA-256 evidence token
and includes the expected revisions and identities. The executor re-runs the
deterministic inspector, requires the exact proposal to still be offered,
acquires the dispatcher lease, and rechecks the token before mutation. A live
or initializing dispatcher suppresses all competing runtime actions.

## Durable action protocol

Before mutation, the approved action is written beneath:

```text
queue/reconciliation-actions/<operation-id>/action.json
```

The operation ID is the SHA-256 identity of the complete approved action. The
result is then written atomically to `result.json` in the same directory. An
exact retry returns the existing result. If the reconciler dies after the
authoritative mutation but before `result.json`, the retry recognizes only the
action-specific postcondition and reconstructs result evidence; unrelated
newer state is refused as stale.

Runtime mutations use a dedicated reconciliation transition validator rather
than widening ordinary queue transitions. This keeps repair authority out of
normal scheduler and callback paths.

## Exhaustive model evidence

The pure relationship classifier evaluates all 80 combinations of eight queue
statuses and nine attempt statuses plus a missing-attempt case. Under an
unowned lease, every synthesized inconsistent pair has a typed action and a
matching evidence token. Under an active owner, the same issues become
`wait-for-owner` and expose no action. Additional probes cover cross-job
bindings, corrupt completion, ambiguous operation identity, and a terminal
attempt whose cleanup record is unavailable.

Execution tests cover exact replay, stale and manufactured action refusal,
specialized-transition rejection, CLI and MCP application, terminal queue
projection, exact operation rebinding, cross-job quarantine, evidence-gated
orphan recovery, and abrupt process death after mutation but before result
recording. The complete repository gate passed with 79 tests and 1,089
assertions on the documentation revision.

One earlier mixed focused run transiently missed an injected in-process
pre-launch failpoint while the stronger abrupt-process matrix passed. The test
passed immediately in isolation and again in the complete gate without a code
or test relaxation. It remains a load-sensitive harness signal to watch, not
discarded negative evidence.

## Deliberate boundaries

- Entirely unreadable queue or attempt stores and unreadable cleanup records
  are reported as blocked. This slice does not invent valid records from
  malformed bytes.
- A terminal attempt without readable cleanup evidence is never rebound as
  running and cannot be projected into a queue completion.
- An orphan recovery may durably return `blocked`; the missing real-world
  process or resource absence evidence cannot be manufactured by approval.
  Repeated approvals therefore create repeated auditable blocked operations
  unless external evidence changes.
- The protocol is local-host only. Network filesystem and multi-host fencing
  remain unsupported.

These are evidence boundaries rather than a hidden manual-edit path. Operators
must restore readable evidence from an authoritative source or satisfy the
named cleanup observation; editing compact projections by hand is unsupported.
