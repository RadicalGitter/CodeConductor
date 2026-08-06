# Unattended operations

> **Readiness correction:** this is the intended operating procedure, not the
> current readiness claim. The Ultra review of commit `5bf3cf2` reopened the
> unattended gates. Attempt fencing and pre-launch dispatch recovery were
> closed by `a84e8fc`, and malformed/missing lease recovery was closed by
> `243b0ec`. Windows process-tree and cleanup closure were closed by `caae1c8`,
> `726e1cf`, `3afab31`, and `77c2b54`. Schema-readable queue/attempt
> convergence was closed by `1a3f908`, and review-evidence integrity by
> `657f0ca`. Resource budgets and retention were closed for the exercised
> trusted-repository Windows lane by `2af6717`. The generic HARD-001 through
> HARD-008 gates are closed for that exact profile. The Vesserin external
> verifier remains blocked on its recorded Docker version canary, and POSIX
> process containment is not an unattended lane.

This run mode watches committed source contracts, queues each newly observed
revision once, runs bounded workers in isolated worktrees, applies deterministic
scope and acceptance gates, and leaves eligible patches for independent review.
It never merges into the project checkout.

## One-time local setup

1. Install PowerShell 7 (`pwsh`) on Windows. It is part of the supported
   process-ownership profile, not an optional administration shell.
2. Copy `.env.example` to the ignored `.env.local`, replace its active path
   placeholders for this machine, and remove route-specific lines for workers
   this machine will not run. Confirm the secret file is ignored before adding
   credentials:

   ```powershell
   git check-ignore -v .env.local
   ```

   For Luna, give every machine its own revocable key and enter it only as
   `OPENAI_API_KEY` in that machine's `.env.local` (or supply it through an
   OS-owned process environment). Edit the file directly rather than putting
   the key in a command argument or shell history. Never copy a populated
   `.env.local` between machines, commit it, add the key to a provider profile,
   or add it to `CONDUCTOR_WORKER_ENV_ALLOWLIST`. Bun loads the ignored file
   when Conductor starts from the repository root.

3. Copy `config/provider-profiles.example.json` to the ignored
   `config/provider-profiles.local.json`. Set
   `CONDUCTOR_PROVIDER_PROFILES_FILE` to that absolute local path. Conductor
   normally reuses the real Bun executable already running it; set
   `CONDUCTOR_OPENAI_RESPONSES_BUN_BIN` only to an absolute `bun.exe` when an
   unusual host requires an override. Do not point it at `bun.ps1`, `bun.cmd`,
   or another shell shim. The provider file contains model, effort, dated rate
   card, and hard budgets; it contains only the key's environment-variable
   name. Verify the rate card against current provider documentation before a
   paid run and reduce budgets for a smaller canary when appropriate.
4. Copy `config/command-profiles.example.json` to the ignored
   `config/command-profiles.local.json`. Keep only absolute executables that the
   owner intentionally allows as setup or acceptance commands.
   If using the external verifier, also copy
   `config/sandbox-profiles.example.json` to the ignored
   `config/sandbox-profiles.local.json`, set
   `CONDUCTOR_SANDBOX_PROFILES_FILE`, and replace the canary-only profile with
   the project's reviewed digest-pinned verifier image.
   Copy `config/resource-profile.example.json` to the ignored
   `config/resource-profile.local.json`, set
   `CONDUCTOR_RESOURCE_PROFILE_FILE`, and review every byte, time, retry, disk,
   and retention limit. Jobs cannot widen this owner profile.
5. If this machine will use the local route, start the intended
   llama.cpp-compatible server and create a dedicated
   Kode profile:

   ```powershell
   bun run configure:kode-local
   ```

   The command discovers the exact served model from `/models`, enables
   thinking with high reasoning effort, and refuses to overwrite an existing
   profile unless `--force` is supplied. The profile uses a dummy local API key
   and is separate from the user's interactive Kode configuration.

6. Prove the complete configuration before leaving it unattended:

   ```powershell
   bun run doctor
   bun run smoke:runtime-mcp
   bun run check
   ```

   `doctor` verifies configured worker routes without printing credential
   values. Run `bun run smoke:kode-live` only on a configured local-worker
   machine and `bun run smoke:sandbox` only when the external verifier profile
   is configured. Run `bun run smoke:openai-live` only when the owner explicitly
   authorizes its small paid request; offline adapter and secret-non-leak tests
   are part of `bun run check`.

The doctor fails closed when runtime reconciliation reports a blocked issue, no
worker adapter is available, a configured Kode or OpenAI Responses route is
unavailable, Kode's dedicated config is not explicitly inherited,
thinking/high effort is absent, the configured local model is not the model
currently served, the runtime data directory cannot initialize, disk falls
below the owner reserve, a GC action was interrupted or failed, or no owner-side
command profile is available. It reports the current resource profile and
dry-run GC summary and never prints API keys.

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
`retry_queued_job`. Use `get_attempt_cleanup` to inspect the independent cleanup
record for an attempt; do not infer cleanup from terminal worker status.

## Inspect and repair a lease

Run the standalone dry-run before manual recovery or whenever MCP startup is
blocked by lease evidence:

```powershell
bun run reconcile --dry-run
```

It starts neither the dispatcher nor a worker. The report classifies the lease,
lists queue/attempt relationship issues, and may include one or more
`availableActions` proposals. A proposal is deliberately not executable
approval. Copy one exact proposal into a separate JSON file and add an
attributable approval. This lease example shows the envelope:

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

Do not hand-author a runtime proposal: copy its v2 object byte-for-byte from the
dry-run and approve only that bounded effect. The evidence token is rechecked
under an exclusive dispatcher lease immediately before mutation. Runtime
actions can reset abandoned intent, quarantine an untrusted binding, restore
an exact operation binding, synchronize a queue from terminal attempt and
cleanup evidence, or run cleanup-gated orphan recovery. The latter may return
`blocked`; approval cannot manufacture process or resource absence evidence.
Approved runtime actions and results remain under
`queue/reconciliation-actions/<operation-id>/` for replay and audit.

For lease quarantine, the original lock directory and raw bytes move under
`queue/lease-evidence`; nothing is silently deleted. A same-host dead valid
owner is recovered automatically and preserved, regardless of wall-clock
expiry. A live local owner is never stolen after suspend, and a remote-host
lease always waits for owner judgment. Do not edit queue, attempt, cleanup, or
lease state by hand.

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

The v2 packet is cached durably as `review-packet.json` beside the attempt. Every
request revalidates the job, terminal attempt, cleanup, patch, status, changed
paths, verification, worker and command logs, lineage, complete attempt
inventory, and launch-time model/harness profile before and after reading the
bounded patch. A v1 cache is refused rather than silently upgraded. If Codex is
used as a worker, set `CONDUCTOR_CODEX_CONFIG_FILE` to the exact config file
whose hash must be bound; Kode binds `KODE_CONFIG_DIR/config.json`.

A Sonnet or other semantic reviewer remains advisory: it cannot execute,
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

On Windows, every external command has a separate guardian inside a verified
kill-on-close Job Object. The guarded command starts only after ownership
evidence is persisted. Normal exit, cancellation, timeout, and owner-crash
tests prove closure for detached Node and Bun descendants. Recovery never kills
a bare PID: absence of a verified v2 Windows Job owner proves closure, while a
legacy guardian or non-kernel POSIX process group remains `unknown` and blocks
retry.

Each attempt has a separate `cleanup.json` and revision journal. Its registered
process-tree, external-resource, and workspace obligations converge only from
typed observations. Failed and unknown observations remain in history even
when a later retry proves release. Automatic and manual worktree removal use a
30-second total deadline; their Git removal and prune commands are individually
bounded and Job-owned. External cleanup uses the frozen owner profile and must
finish with proven process termination. Queue completion becomes
`needs-input`, and reconciliation emits `attempt-cleanup-unresolved`, whenever
cleanup is not `not-required` or `proven`.

Every new v2 job also freezes the complete owner resource budget. One deadline
spans setup, worker execution, and acceptance; cleanup retains its own bounded
closure window. Process logs and proposal patches have exact byte caps. Attempt
artifacts, worktrees, changed paths, command count, attempts, automatic
infrastructure retries, lineage, external resources, Git operations, and free
disk are also bounded or actively monitored. `get_resource_policy` shows the
profile for new jobs; the job artifact remains authority after restart. See
[resource budgets and retention](resource-budgets-and-retention.md) for the
exact enforcement and host-worktree overshoot boundary.

Inspect retention without mutation through `plan_retention_gc` or:

```powershell
bun run gc --dry-run --out .\gc-plan.json
```

Applying GC is deliberately owner-only and absent from the model-facing MCP
surface. It requires the exact unexpired plan plus named approval. Worktree and
artifact reclamation are separate passes, and compact attempt, cleanup,
verification, transition, action, and tombstone evidence survives deletion.

PowerShell host startup is currently paid for each guarded command and can add
seconds to short operations, especially cold. Treat timings from a loaded
machine as correctness observations only. Optimize the host lifecycle only
after preserving the ownership gate and typed termination evidence.

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
