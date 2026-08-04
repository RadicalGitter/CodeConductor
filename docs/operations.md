# Unattended operations

> **Readiness correction:** this is the intended operating procedure, not the
> current readiness claim. The Ultra review of commit `5bf3cf2` reopened the
> unattended gates. Attempt fencing and pre-launch dispatch recovery were
> closed by `a84e8fc`, and malformed/missing lease recovery was closed by
> `243b0ec`. Process-tree closure, complete queue/attempt convergence, evidence
> integrity, and resource budgets remain open. Use attended trusted-worker
> trials only until the hardening exits in
> `vesserin-backend-generation-plan.md` pass.

This run mode watches committed source contracts, queues each newly observed
revision once, runs bounded workers in isolated worktrees, applies deterministic
scope and acceptance gates, and leaves eligible patches for independent review.
It never merges into the project checkout.

## One-time local setup

1. Copy `.env.example` to the ignored `.env.local` and replace `YOUR_USER`.
2. Copy `config/command-profiles.example.json` to the ignored
   `config/command-profiles.local.json`. Keep only absolute executables that the
   owner intentionally allows as setup or acceptance commands.
   If using the external verifier, also copy
   `config/sandbox-profiles.example.json` to the ignored
   `config/sandbox-profiles.local.json`, set
   `CONDUCTOR_SANDBOX_PROFILES_FILE`, and replace the canary-only profile with
   the project's reviewed digest-pinned verifier image.
3. With the intended llama.cpp-compatible server running, create a dedicated
   Kode profile:

   ```powershell
   bun run configure:kode-local
   ```

   The command discovers the exact served model from `/models`, enables
   thinking with high reasoning effort, and refuses to overwrite an existing
   profile unless `--force` is supplied. The profile uses a dummy local API key
   and is separate from the user's interactive Kode configuration.

4. Prove the complete configuration before leaving it unattended:

   ```powershell
   bun run doctor
   bun run smoke:runtime-mcp
   bun run smoke:kode-live
   bun run smoke:sandbox
   bun run check
   ```

The doctor fails closed when runtime reconciliation reports a blocked issue,
Kode is unavailable, its dedicated config is not explicitly inherited,
thinking/high effort is absent, the configured model is not the model currently
served, the runtime data directory cannot initialize, or no owner-side command
profile is available. It never prints API keys.

## External generated-code verifier

The Docker profile is an owner boundary, not a job payload. It binds an exact
image digest and minimum engine version and never pulls implicitly. The current
escape canary uses official BusyBox only to exercise isolation; it is not a
Vesserin verifier image. It checks blocked root writes, blocked network, absent
host secrets, absent Docker socket, non-root UID, zero effective capabilities,
forced cancellation, named cleanup, and no leftover containers.

On 2026-08-04, all isolation and cleanup probes passed, but deployment readiness
correctly failed: installed Docker Desktop 4.54.0 exposes Engine 29.1.2, below
the configured 29.6.2 floor. Evidence is under
`C:\Users\oscar\.conductor\runtime\canaries\sandbox-2026-08-04T12-00-17.479Z`.
`doctor` and external-job preparation therefore fail closed until Docker is
updated. Do not lower the version floor to turn the result green.

For the later gameplay wish loop, prefer Docker Sandboxes or another microVM
backend in private-clone mode with shared skills disabled and locked-down
network policy. The ordinary container driver is suitable for bounded verifier
commands after the update; it is not authority to run an adversarial autonomous
agent or import arbitrary artifacts.

## Start and stop

Register this repository's `bun src/cli.ts` as a stdio MCP server with the
repository root as its working directory. Bun loads the ignored `.env.local`.
On connection, the process acquires the single-machine queue lease and starts
both the dispatcher and source-watch poller. Closing stdin, SIGINT, or SIGTERM
stops polling, waits for active workers by default, releases the lease, and
closes the MCP server.

Use `register_contract_watch` once per repository. Use
`poll_contract_watches` for an immediate cycle and `list_contract_watches` to
see the exact observed revision or the last scan error. Queue operations are
available through `list_queue`, `get_queue_item`, `cancel_queued_job`, and
`retry_queued_job`.

## Inspect and repair a lease

Run the standalone dry-run before manual recovery or whenever MCP startup is
blocked by lease evidence:

```powershell
bun run reconcile --dry-run
```

It starts neither the dispatcher nor a worker. The report classifies the lease,
lists queue/attempt relationship issues, and may include an
`availableActions` proposal. A proposal is deliberately not executable
approval. To authorize quarantine, copy the exact proposal into a separate
JSON file and add an attributable approval:

```json
{
  "schema": "conductor.reconciliation-action/v1",
  "proposal": {
    "schema": "conductor.reconciliation-action-proposal/v1",
    "kind": "quarantine-unreadable-dispatcher-lease",
    "observedState": "corrupt",
    "evidenceToken": "copy the exact token from dry-run",
    "requiredAuthority": "owner",
    "description": "copy the exact description from dry-run"
  },
  "approval": {
    "approvedBy": "owner identity",
    "approvedAt": "2026-08-04T18:30:00.000Z",
    "reason": "Verified that no dispatcher is initializing or owns this lease"
  }
}
```

Then apply only that file:

```powershell
bun run reconcile --apply .\approved-action.json
```

The evidence token is rechecked immediately before mutation. The original lock
directory and raw bytes move under `queue/lease-evidence`; nothing is silently
deleted. A same-host dead valid owner is recovered automatically and preserved,
regardless of wall-clock expiry. A live local owner is never stolen after
suspend, and a remote-host lease always waits for owner judgment. Queue/attempt
issues are diagnostic in this revision: do not hand-edit state or infer that
the lease action repairs them.

`submit_coding_job` is now a compatibility queue submission, not an alternate
launcher. Its response wraps the current queue `item` and
`idempotentReplay`. An item may remain `queued` when capacity is full; once
dispatch begins it records `dispatchOperationId` and progresses through
`dispatching` and `running`. Cancellation of active work reports `cancelling`
until the attempt reaches a durable terminal state.

## Review handoff

For an eligible terminal attempt, call `get_review_bundle`. The response
contains:

- the frozen job contract and exact base revision;
- deterministic verification and changed paths;
- SHA-256 bindings for the contract, patch, scope evidence, verification, and
  worker logs;
- a bounded proposal patch;
- an advisory reviewer contract with `pass`, `fail`, and `needs-context`
  outcomes.

The packet is cached durably as `review-packet.json` beside the attempt. A
later request refuses to return a patch whose bytes no longer match the bound
hash. A Sonnet or other semantic reviewer remains advisory: it cannot execute,
accept, merge, or mutate. Reviewer integration and correction attempts stay a
separate measured slice so the previously rejected worker self-review pattern
does not re-enter the pipeline under another name.

## Capacity and recovery

`CONDUCTOR_MAX_CONCURRENT` limits simultaneous isolated workers. Start with the
number of validated llama.cpp slots; the current local canary uses one worker,
while the deterministic suite proves concurrency two. Queue state and source
watches survive process restart. Work that was only queued resumes.

On startup, the dispatcher scans the complete attempt set as well as the queue.
It joins partial dispatch state by `dispatchOperationId`: intent with no attempt
returns to `queued`; a reserved or claimed orphan is durably cancelled before a
new attempt is allowed; a terminal attempt completes its queue item; unverifiable
live work becomes `needs-input`. Revision journals remain authoritative when a
projection write was interrupted. Do not edit `queue.json`, `attempt.json`, or
their transition directories by hand.

Every external command has a separate process guardian, and recovery never
kills a bare recorded PID. Current evidence proves several cancellation and
owner-crash paths but not complete closure: detached descendants can survive a
normal root-worker exit, and some live/missing-identity quarantines cannot be
resolved safely through the public API. Treat guardian disappearance as
insufficient for unattended retry until the OS-enforced ownership and
reconciliation campaign passes.

The generation-fenced queue lease is intentionally single-machine. Expired
heartbeats are not stolen from live local processes, which makes suspend safe.
Valid dead-owner leases are preserved and recovered from same-host process
absence. Old missing or malformed records require the explicit approval flow
above.
UNC runtime roots are rejected. Do not place the runtime data directory on SMB,
a mapped network drive, or treat Tailscale access as distributed queue
ownership. Run the dispatcher on the machine that owns its local data root and
expose its bounded control API instead.

## Evidence from the first live lane

The live canary preserves both successes and failures under
`~/.conductor/canaries/`:

- `2026-08-04T04-26-20-942Z`: eligible direct run, about 160 seconds; KAT spent
  most of the run retrying denied command and delegation tools.
- `2026-08-04T04-32-38-817Z`: scope correctly rejected fourteen invented test
  runner files after command tools were removed.
- `2026-08-04T04-36-33-877Z`: eligible direct run in 12.6 seconds after the
  worker contract assigned command acceptance to Conductor.
- `2026-08-04T04-38-40-097Z`: the full source/queue chain correctly
  quarantined an invented status file.
- `2026-08-04T04-40-24-922Z`: the full committed-source → watch → durable queue
  → isolated Kode → deterministic acceptance chain completed and was eligible
  in 12.6 seconds after per-contract file-creation authority was removed.
- `2026-08-04T04-54-02-363Z`: the same full chain completed in 17.5 seconds and
  additionally materialized an untruncated advisory review packet bound to
  patch SHA-256
  `127eb6a0efbf37e3f64a992321deda41f102202e065159cbb94d0e877e35f432`.

These negatives are operational evidence, not artifacts to delete or relabel
as successful work.
