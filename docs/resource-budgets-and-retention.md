# Resource budgets and retention

## Authority boundary

Resource policy belongs to the Conductor owner, not to a worker or a submitted
job. `CONDUCTOR_RESOURCE_PROFILE_FILE` may point to a reviewed
`conductor.owner-resource-profile/v1` JSON file. If it is unset, Conductor uses
the built-in `overnight-local-v1` profile. The complete effective budget and a
SHA-256 fingerprint are frozen into `conductor.job/v2` before any attempt side
effect. A request may shorten its total timeout but cannot widen an owner
limit. Existing jobs continue to use their frozen budget after restart or an
owner-profile change.

The initial local profile is:

| Limit                                     |    Default |
| ----------------------------------------- | ---------: |
| Total worker attempt                      | 45 minutes |
| Setup plus acceptance commands            |         32 |
| Attempts per job                          |         16 |
| Automatic infrastructure retries          |          1 |
| Changed paths                             |         20 |
| Proposal patch                            |      5 MiB |
| Each stdout or stderr log                 |     10 MiB |
| Attempt artifact directory                |     50 MiB |
| Worktree                                  |      2 GiB |
| Lineage contributions                     |         32 |
| External resources                        |         32 |
| Each internal Git operation               | 60 seconds |
| Cleanup closure                           | 30 seconds |
| Required free disk before and during work |      1 GiB |
| Unreviewed terminal evidence              |     7 days |
| Dispositioned review evidence             |    30 days |
| GC proposal validity                      | 15 minutes |

The job request, command count, lineage count and bytes, attempt count, and
external-resource count are checked before their corresponding side effects.
Worker and deterministic-command logs are byte-capped by the process guardian;
the persisted file is truncated defensively before return if a host writes
outside the expected stream path. Git patch capture stops at the patch ceiling,
so an oversized patch is not first written and then diagnosed. Internal Git
uses a resolved executable, no shell, disabled hooks, isolated global/system
configuration, no credential prompt, bounded aggregate output, a timeout, and
tree termination on timeout, cancellation, or output flood.

One deadline spans setup, worker execution, and acceptance. Cleanup has its own
short closure deadline so terminating an attempt cannot abandon resources when
the work deadline expires. The attempt artifact and worktree ceilings are
sampled while work runs and rechecked at phase boundaries. Crossing one aborts
the owned process tree and records `resource-limit`; unlike the exact log and
patch write caps, a host-worktree writer can overshoot between samples. The
free-disk reserve prevents that monitored overshoot from consuming the volume.
A future strict untrusted-code lane should use a bounded virtual disk or
filesystem quota rather than claiming byte-exact host-worktree isolation.

Docker cleanup never executes the command stored in mutable attempt evidence.
Conductor validates the resource against the job's frozen sandbox binding and
reconstructs `docker rm --force <recorded-id>` using the frozen executable,
profile fingerprint, image, cleanup deadline, and log ceiling. A mismatch is a
cleanup failure and blocks retry and workspace removal.

## Retention classes

`plan_retention_gc` and `bun run gc --dry-run` classify the complete readable
attempt set:

- `active`: any nonterminal attempt; never a candidate;
- `reviewable`: an eligible completed proposal without an authoritative
  disposition; retained indefinitely;
- `retained`: terminal evidence still inside its frozen retention period;
- `quarantine`: missing, unreadable, failed, pending, or unknown cleanup
  evidence; never a candidate;
- `expired`: terminal evidence beyond its frozen retention period and safe to
  propose for cleanup.

GC deliberately takes two passes when a worktree remains. The first plan can
propose only the exact worktree. After owner-approved removal records positive
cleanup evidence, a new dry-run may propose heavy attempt files. Artifact GC
keeps `attempt.json`, `cleanup.json`, `verification.json`, both transition
journals, and a `gc-tombstone.json`; it removes only the exact hash-bound files
listed in the approved plan. Queue and attempt identity therefore remain
diagnosable after reclamation.

Create a plan without mutation:

```powershell
bun run gc --dry-run --out .\gc-plan.json
```

Review its observations, exact candidates, hashes, byte estimates, data root,
fingerprint, and expiry. Applying is intentionally absent from the model-facing
MCP surface. The local owner can approve that exact short-lived plan:

```powershell
bun run gc --apply --plan .\gc-plan.json --approved-by "owner identity" --reason "Reviewed expired evidence and exact paths"
```

Apply revalidates the plan fingerprint, data root, validity window, manifest
and cleanup revisions/hashes, workspace existence, and every artifact size and
hash before the first deletion. It writes an `approved` action record under
`<data-root>/gc/actions/` before mutation and replaces it with `completed` or
`failed` evidence. If the owner process dies mid-apply, `doctor` reports the
remaining `approved` action as interrupted; it is never silently replayed.
Run a fresh dry-run after inspecting the partial action.

## Diagnostics and supported boundary

`bun run doctor` reports the active owner profile, disk reserve, reclaimable GC
candidates, and interrupted or failed GC actions. `get_resource_policy` exposes
the limits for newly prepared jobs; each existing `job.json` is the authority
for its own frozen budget. Queue items expose their automatic retry count, and
attempt failures distinguish `timeout` from `resource-limit`.

These controls close HARD-008 for the exercised trusted-repository Windows
lane. They do not qualify the POSIX process-containment lane, make ordinary
containers a hostile-agent sandbox, attest a live inference server, or waive
the separately recorded Docker engine/version canary. Those remain explicit
environmental or later-phase gates.

The closing repository gate passed 90 tests and 1,180 assertions. It includes
output flood, total deadline, oversized patch, attempt ceiling, stale GC,
retention refusal, cleanup quarantine, frozen external cleanup, restart,
process-tree, reconciliation, evidence-seal, source compiler, and queue tests.
