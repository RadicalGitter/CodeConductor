# Runtime contract

- Status: implemented first slice
- Contract version: `v1`

## MCP surface

| Tool                       | Effect                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `list_worker_adapters`     | Lists configured adapter contracts                                 |
| `submit_coding_job`        | Freezes a job and starts an isolated attempt without waiting       |
| `get_attempt`              | Reads a durable attempt manifest                                   |
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
  workspaces/<attempt-id>/
```

Job and initial-attempt reservations become visible through atomic directory
renames only after their JSON is complete. Manifest updates use write-fsync-
rename. An idempotency key maps to a stable job ID; reusing it with a different
request is rejected, and replaying the same request does not spawn another
attempt.

## Authority semantics

`completed` is process evidence, not acceptance. The worker output, worktree,
and patch remain proposals. `reviewDisposition` is a separate field and starts
at `not-requested`; no current tool can promote it to authoritative repository
state.

The first slice parses and freezes path scope, setup commands, and acceptance
commands so their future meaning is versioned. It deliberately does not claim
to enforce or execute them yet.

## Restart semantics

Completed manifests and artifacts survive process restart. A restarted process
can read any attempt, but it cannot recover ownership of an already-running OS
process in this slice. `wait_for_attempt` therefore returns the last durable
state when no in-memory execution owner exists. Lease and orphan recovery
belong to the durable-queue slice.
