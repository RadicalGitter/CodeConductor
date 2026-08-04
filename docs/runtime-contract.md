# Runtime contract

- Status: implemented first slice
- Contract version: `v1`

## MCP surface

| Tool                       | Effect                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `list_worker_adapters`     | Lists configured adapter contracts                                 |
| `submit_coding_job`        | Freezes a job and starts an isolated attempt without waiting       |
| `enqueue_coding_job`       | Freezes a job and durably queues it with dependency metadata       |
| `list_queue`               | Reads compact queue and completion records                         |
| `get_queue_item`           | Reads one queue record                                             |
| `cancel_queued_job`        | Cancels waiting work or its active process tree                    |
| `retry_queued_job`         | Requeues terminal work as a new evidence-preserving attempt        |
| `scan_contract_sources`    | Compiles exact-revision comment contracts without mutation         |
| `enqueue_contract_sources` | Persists and queues a validated source dependency graph            |
| `register_contract_watch`  | Persists an automatic moving-ref scan policy                       |
| `list_contract_watches`    | Reads watch revisions, run ids, and errors                         |
| `set_contract_watch`       | Enables or disables a persisted watch                              |
| `poll_contract_watches`    | Runs one immediate watch cycle                                     |
| `get_attempt`              | Reads a durable attempt manifest                                   |
| `get_verification`         | Reads typed deterministic verification evidence                    |
| `read_attempt_artifact`    | Reads a bounded named artifact without arbitrary path access       |
| `wait_for_attempt`         | Waits only while this process owns the attempt; otherwise reads it |
| `cancel_attempt`           | Cancels the worker and its subprocess tree                         |
| `remove_attempt_workspace` | Removes the exact recorded worktree of a terminal attempt          |

Submission is intentionally non-blocking. Callers retain only compact IDs and
poll durable state instead of holding an architect turn open while a worker
runs. Multiple submissions may execute concurrently; each mutating attempt has
its own worktree.

## Durable layout

```text
<data-root>/
  jobs/<job-id>/
    job.json
    attempts/<attempt-id>/
      attempt.json
      stdout.log
      stderr.log
      proposal.patch
      repository-status.txt
      changed-paths.json
      verification.json
      setup-*.stdout.log / setup-*.stderr.log
      acceptance-*.stdout.log / acceptance-*.stderr.log
  workspaces/<attempt-id>/
  queue/
    items/<job-id>/queue.json
    dispatcher.lock/lease.json
    lease-generation.json
  source-runs/<run-id>/manifest.json
  source-watches/<watch-id>/watch.json
```

Job and initial-attempt reservations become visible through atomic directory
renames only after their JSON is complete. Manifest updates use write-fsync-
rename. An idempotency key maps to a stable job ID; reusing it with a different
request is rejected, and replaying the same request does not spawn another
attempt.

## Authority semantics

`completed` is worker-process evidence, not acceptance. `verificationStatus`
is separate: `eligible` means configured deterministic gates passed;
`ineligible` preserves a completed proposal that failed scope, checks, or
proposal stability. The worker output, worktree, and patch remain proposals.
`reviewDisposition` starts at `not-requested`; no current tool can promote it to
authoritative repository state.

Path rules are exact files or directory prefixes; glob syntax and traversal are
rejected. Empty `allowedPaths` means no positive restriction, while forbidden
and protected rules still apply. Setup commands run before the worker and must
leave Git-visible state clean. Acceptance commands run only after a successful,
in-scope worker result and must not alter the captured patch. Commands execute
without a shell, from real paths inside the worktree, using absolute
owner-allowlisted executables and owner-allowlisted inherited environment
names.

## Restart semantics

Completed manifests, queue items, and artifacts survive process restart. One
generation-fenced heartbeat lease owns dispatch. A lease can be recovered
automatically only after expiration, on the same host, when its recorded owner
process is no longer alive. A live process remains authoritative even after
machine suspend makes the heartbeat old. Renew and release require the exact
owner, instance, and generation; an old owner cannot remove a newer lock.

Every external command runs below a Node guardian whose identity is persisted
before the worker starts. The guardian owns the process tree and kills it when
Conductor's ownership pipe closes. On restart, a merely reserved attempt is
cancelled and retried as a new attempt. An active attempt is retried only after
its recorded guardian is gone; a live guardian or missing identity becomes
`needs-input`. Conductor never kills a bare recorded PID during recovery.

These semantics are local-host semantics. UNC data roots are rejected. Mapped
network drives and distributed dispatch are outside this contract.

Queue completion means the worker completed and deterministic evidence was
eligible. Ineligible successful worker output becomes `needs-input`, not a
successful dependency. Retrying preserves the prior attempt and reserves a new
ordinal.
