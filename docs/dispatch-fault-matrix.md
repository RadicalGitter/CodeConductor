# Dispatch fault matrix

- Implementing revision: `a84e8fc`
- Scope: queue intent through pre-worker launch
- Result: HARD-001 and HARD-002 closed; later lifecycle and lease-repair items
  remain open

The test harness terminates a fresh dispatcher process at each named boundary,
waits for its dead-owner lease to expire, and starts a new dispatcher over the
same local data root. Recovery must end with exactly one completed worker and
no nonterminal attempt.

| Last durable evidence before termination   | Restart observation                                             | Deterministic disposition                                                  |
| ------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| queue `dispatching`, no attempt            | operation ID has no matching attempt                            | clear operation identity and return the item to `queued`                   |
| attempt `reserved`                         | operation ID joins a dispatching item to one unlaunched attempt | bind it, cancel the orphan attempt, then permit one new attempt            |
| queue `running` bound to reserved attempt  | queue already names the unlaunched attempt                      | cancel the orphan attempt, clear the binding, then permit one new attempt  |
| attempt `claimed`                          | claim belongs to the terminated launcher instance               | cancel the orphan claim; a new launcher cannot resume or duplicate it      |
| journal snapshot published, projection old | latest complete revision is newer than the compact JSON file    | use the journal as authority; the next legal transition repairs projection |
| stale callback after retry                 | callback presents an older queue or attempt revision            | reject with a transition conflict; current state remains unchanged         |

Additional evidence:

- 100 deterministic randomized claim races with 2–20 concurrent callers each
  entered the launch seam exactly once.
- One integration race with 100 concurrent callers created one worktree and
  completed one worker.
- Existing v1 attempt and queue projections without `revision` read as revision
  zero and upgrade on their first transition.
- Active cancellation remains `cancelling` until terminal attempt evidence is
  written.

The matrix does not claim closure for termination after workspace creation,
guardian start, worker exit, verification, terminal evidence, review creation,
external-resource operations, or malformed lease records. Those boundaries
remain tracked by HARD-003 through HARD-008 in the
[hardening register](hardening-register.md).
