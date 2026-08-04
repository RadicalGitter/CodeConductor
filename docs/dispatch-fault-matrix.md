# Dispatch fault matrix

- Implementing revision: `a84e8fc`
- Scope: queue intent through pre-worker launch
- Result: HARD-001 and HARD-002 closed at `a84e8fc`; HARD-005 lease repair
  closed separately at `243b0ec`; process/cleanup closure was later recorded in
  the hardening register; HARD-006 was later closed by `1a3f908`, while
  HARD-007 was later closed by `657f0ca`, while HARD-008 remains open

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

The pre-launch matrix does not claim closure for termination after workspace
creation, guardian start, worker exit, verification, terminal evidence, review
creation, or external-resource operations. Malformed lease records are covered
by the later matrix below. Process and cleanup boundaries were closed for the
supported Windows lane by the later HARD-003/HARD-004 extension in the
[parity map](parity-map.md). Public recovery and evidence sealing were closed
by their later matrices; resource bounds remain tracked by HARD-008 in the
[hardening register](hardening-register.md).

## Lease-repair fault matrix

- Implementing revision: `243b0ec`
- Result: HARD-005 closed; HARD-006 was closed later by `1a3f908`

| Observed lease evidence                             | Authority                  | Disposition                                                                |
| --------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| No lock directory                                   | deterministic              | create normally                                                            |
| New lock directory without `lease.json`             | deterministic              | wait through one initialization grace interval                             |
| Old directory without `lease.json`                  | owner                      | propose exact-token quarantine; preserve directory after separate approval |
| Old malformed `lease.json`                          | owner                      | propose exact-token quarantine; preserve raw bytes after separate approval |
| Valid live same-host lease, even expired            | existing owner             | wait; suspend cannot authorize theft                                       |
| Valid remote-host lease                             | remote owner               | wait; local PID state has no authority                                     |
| Valid dead same-host lease, including future expiry | deterministic              | preserve evidence, increment generation, create one successor              |
| Two simultaneous recoverers or owner actions        | filesystem election        | exactly one preserves the source; stale observation loses                  |
| Reconciler process dies while holding its mutex     | deterministic on same host | preserve the dead mutex record and resume repair                           |

The standalone dry-run starts no dispatcher, so damaged lease evidence cannot
hide its own repair surface. The full 56-test gate passed on the implementing
revision. Queue/attempt mismatches were visible but not included in this lease
closure claim; their later action/crash matrix is documented in
[`reconciliation-state-matrix.md`](reconciliation-state-matrix.md).
