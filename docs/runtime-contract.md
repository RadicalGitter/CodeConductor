# Runtime contract

- Status: implemented local core; remaining unattended gates tracked
- MCP contract version: `v1`
- Queue and attempt record version: `v2` (`v1` remains readable)

## MCP surface

| Tool                          | Effect                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| `reconcile_runtime`           | Dry-run lease and queue/attempt relationship inspection             |
| `apply_reconciliation_action` | Applies one evidence-bound, owner-approved lease or runtime repair  |
| `list_worker_adapters`        | Lists configured adapter contracts                                  |
| `submit_coding_job`           | Freezes a job and hands it to the owned dispatcher without waiting  |
| `enqueue_coding_job`          | Freezes a job and durably queues it with dependency metadata        |
| `list_queue`                  | Reads compact queue and completion records                          |
| `get_queue_item`              | Reads one queue record                                              |
| `cancel_queued_job`           | Cancels waiting work or its active process tree                     |
| `retry_queued_job`            | Requeues terminal work as a new evidence-preserving attempt         |
| `scan_contract_sources`       | Compiles exact-revision comment contracts without mutation          |
| `enqueue_contract_sources`    | Persists and queues a validated source dependency graph             |
| `register_contract_watch`     | Persists an automatic moving-ref scan policy                        |
| `list_contract_watches`       | Reads watch revisions, run ids, and errors                          |
| `set_contract_watch`          | Enables or disables a persisted watch                               |
| `poll_contract_watches`       | Runs one immediate watch cycle                                      |
| `get_attempt`                 | Reads a durable attempt manifest                                    |
| `get_attempt_cleanup`         | Reads independent cleanup requirements and observations             |
| `get_verification`            | Reads typed deterministic verification evidence                     |
| `get_review_bundle`           | Revalidates a complete v2 evidence seal and returns a bounded patch |
| `read_attempt_artifact`       | Reads a bounded named artifact without arbitrary path access        |
| `wait_for_attempt`            | Waits only while this process owns the attempt; otherwise reads it  |
| `cancel_attempt`              | Cancels the worker and its subprocess tree                          |
| `remove_attempt_workspace`    | Removes the exact recorded worktree of a terminal attempt           |

Submission is intentionally non-blocking. Both submission tools enter the same
durable queue; `submit_coding_job` is the compatibility form with default
priority and no dependencies. Its result contains `item` plus
`idempotentReplay`, and callers poll the queue item before using its attempt ID.
No MCP route launches an attempt outside the dispatcher. Multiple submissions
may execute concurrently; each mutating attempt has its own worktree.

## Durable layout

```text
<data-root>/
  jobs/<job-id>/
    job.json
    attempts/<attempt-id>/
      attempt.json
      transitions/<revision>/attempt.json
      cleanup.json
      cleanup-transitions/<revision>/cleanup.json
      stdout.log
      stderr.log
      proposal.patch
      repository-status.txt
      changed-paths.json
      verification.json
      review-packet.json
      setup-*.stdout.log / setup-*.stderr.log
      acceptance-*.stdout.log / acceptance-*.stderr.log
  workspaces/<attempt-id>/
  queue/
    items/<job-id>/queue.json
    items/<job-id>/transitions/<revision>/queue.json
    dispatcher.lock/lease.json
    lease-generation.json
    lease-evidence/<evidence-token>/
    lease-evidence/reconciliation-locks/<instance-id>/
    reconciliation-actions/<operation-id>/
      action.json
      result.json
  source-runs/<run-id>/manifest.json
  source-watches/<watch-id>/watch.json
```

Job and attempt reservations become visible through atomic directory renames
only after their JSON is complete. Queue and attempt updates increment a
revision, validate a legal transition, atomically publish a complete journal
snapshot, then update the compact projection. The journal remains authoritative
if the process stops before projection. A stale writer cannot overwrite a newer
revision. Existing v1 records without `revision` read as revision zero and are
upgraded to the v2 record schema on their next transition. Newly reserved
attempts and queue items are v2.

Before launch, an attempt also records a `worker-execution-profile/v1` with the
adapter policy, requested model selector, exact invocation fingerprint, and
hashes for its executable, harness entry, and declared configuration. Missing
required model or configuration provenance makes deterministic verification
ineligible; it does not silently inherit review authority from the current
machine.

Attempt reservation also publishes `cleanup.json` atomically. Its
`conductor.attempt-cleanup/v1` record registers process-tree,
external-resource, and workspace subjects with deadlines, then appends typed
`proven`, `failed`, or `unknown` observations through its own monotonic revision
journal. The latest observation for each required subject derives current
cleanup status; prior negative observations remain durable. Attempt terminal
records cannot be rewritten by cleanup or review updates.

Every dispatch writes one UUID `dispatchOperationId` through queue intent,
attempt reservation, queue binding, and launch claim. The attempt can be
claimed once, only for that operation, and only its recorded launcher instance
may cross the in-process launch seam. An idempotency key maps to a stable job
ID; reusing it with a different request is rejected, and replaying the same
request does not spawn another attempt.

## Authority semantics

`completed` is worker-process evidence, not acceptance. `verificationStatus`
is separate: `eligible` means configured deterministic gates passed;
`ineligible` preserves a completed proposal that failed scope, checks, or
proposal stability. The worker output, worktree, and patch remain proposals.
`reviewDisposition` starts at `not-requested`; no current tool can promote it to
authoritative repository state.

A queued dependency binds an exact eligible attempt, not merely a job name.
The child manifest records the complete proposal ancestry with patch and
verification SHA-256 values. Immediately before use, Conductor revalidates each
terminal status, repository, source revision, evidence record, size, and hash.
It applies the ordered patches into a fresh source-revision worktree and creates
a deterministic detached commit without hooks or refs. Conflicts, missing
evidence, known rejected or superseded parents, cross-repository ancestry,
differing source revisions, and tampering become `needs-input` before the child
worker starts. Review-packet creation revalidates the lineage again. The child
worker is told both the frozen source and effective proposal baseline; its own
scope and patch are evaluated only against the latter.

`get_review_bundle` requires an eligible completed attempt and safe cleanup.
Packet v2 embeds the job, complete terminal attempt, cleanup, verification,
changed paths, launch profile, and reviewer contract. File bindings cover all
worker and command logs, patch/status evidence, lineage inputs, and profile
files; a recursive attempt-directory inventory detects additions. Every
retrieval validates the seal and bindings before and after reading the bounded
patch. Legacy v1 caches fail closed. Full details and the tamper matrix are in
`review-evidence-seal.md`.

Path rules are exact files or directory prefixes; glob syntax and traversal are
rejected. Empty `allowedPaths` means no positive restriction, while forbidden
and protected rules still apply. Setup commands run before the worker and must
leave Git-visible state clean. Acceptance commands run only after a successful,
in-scope worker result and must not alter the captured patch. Commands execute
without a shell, from real paths inside the worktree, using absolute
owner-allowlisted executables and owner-allowlisted inherited environment
names.

`executionBoundary.kind=external-sandbox` names an owner profile which is
resolved and frozen into the job. Preparation fails unless the Docker engine
meets the profile's security floor and the exact digest-pinned image is already
present; images are never pulled implicitly. Host command-capable worker
adapters are rejected. Container commands receive no host environment values
and can use only profile-allowlisted absolute container paths. Verification
records include the profile fingerprint, image, container name, and boundary.
Active external resources are durable attempt state, and a retry is prohibited
until cleanup succeeds or Docker proves the container absent. The same gate
prevents removal of the resource's worktree and cleanup working directory.

## Restart semantics

Completed manifests, queue items, and artifacts survive process restart. Queue
state uses `queued -> dispatching -> running`, while attempt state uses
`reserved -> claimed -> preparing -> running`. Active cancellation remains
`cancelling` until terminal attempt evidence exists. One generation-fenced
heartbeat lease owns dispatch. A valid lease can be recovered automatically on
the same host when its recorded owner process is no longer alive; direct
absence evidence wins even when a backward clock change left a future expiry.
A live process remains authoritative even after machine suspend makes the
heartbeat old. Remote-host leases are never interpreted from local PID state.
Renew and release require the exact owner, instance, and generation; an old
owner cannot remove a newer lock.

Lease inspection classifies absence, initialization, active local ownership,
expired-but-live local ownership, remote ownership, recoverable dead ownership,
incomplete records, and corrupt records. Automatic dead-owner recovery first
moves the exact content-identified lease directory under `lease-evidence`.
Incomplete or corrupt records outliving one lease interval produce an action
proposal, not authorization. `apply_reconciliation_action` requires that exact
proposal plus an explicit approver, approval time, and reason; it rechecks the
evidence token and preserves the original directory. Concurrent repair is
serialized by a staged, recoverable local reconciliation mutex whose dead-owner
record is also retained.

`reconcile_runtime` and `bun run reconcile --dry-run` do not mutate state. They
also report unreadable stores and queue/attempt relationship mismatches. The
standalone command deliberately constructs no dispatcher, so it remains usable
when a damaged lease prevents MCP startup. Returned v2 proposals may reset an
abandoned queue intent, quarantine an untrusted binding, restore one exact
operation-to-attempt binding, project a terminal attempt plus cleanup into its
queue record, or invoke cleanup-gated orphan recovery. There is no
force-complete command.

Runtime action approval is persisted before mutation under
`queue/reconciliation-actions/<operation-id>/action.json`; its atomic result is
stored beside it as `result.json`. The operation ID identifies the complete
approved action. Exact replay returns the same result. Recovery after a crash
between mutation and result recording accepts only the action-specific
postcondition. Every other changed state is stale and refused. The executor
holds the dispatcher lease during mutation, and ordinary queue transitions are
not widened to acquire repair authority. See
`reconciliation-state-matrix.md` for the transition and evidence matrix.

Startup reconstructs a missing queue-to-attempt link from the operation ID,
returns intent without an attempt safely to `queued`, cancels unlaunched orphan
attempts before retry, and scans every nonterminal attempt rather than trusting
queue visibility alone. Abrupt-process tests cover the four pre-launch
boundaries. Recovery after workspace creation is governed by the independent
cleanup record.

On Windows, every external command runs inside a verified kill-on-close Job
Object whose v2 guardian identity is persisted before the worker starts.
Conductor never kills a bare recorded PID during recovery. An absent verified
Job owner proves kernel closure; a live owner remains running; legacy guardian
disappearance and non-kernel POSIX process-group absence are `unknown` and
cannot authorize retry. External-resource and workspace subjects must also be
proven released. Git worktree removal and pruning run as bounded, Job-owned
processes under one 30-second workspace-cleanup deadline.

Schema-readable queue/attempt disagreements now have public, evidence-bound
convergence or an exact blocked cleanup requirement. Malformed whole-record
bytes are still diagnostic only. Review-evidence sealing and bounded resource
retention remain separate HARD-007 and HARD-008 gates; this state-machine
closure is not a claim of broader unattended readiness.

These semantics are local-host semantics. UNC data roots are rejected. Mapped
network drives and distributed dispatch are outside this contract.

Queue completion means the worker completed, deterministic evidence was
eligible, and cleanup is `not-required` or `proven`. Ineligible successful
worker output or unresolved cleanup becomes `needs-input`, not a successful
dependency. Retrying preserves the prior attempt, requires safe cleanup, and
reserves a new ordinal.
