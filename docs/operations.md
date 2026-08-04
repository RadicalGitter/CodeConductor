# Unattended operations

This run mode watches committed source contracts, queues each newly observed
revision once, runs bounded workers in isolated worktrees, applies deterministic
scope and acceptance gates, and leaves eligible patches for independent review.
It never merges into the project checkout.

## One-time local setup

1. Copy `.env.example` to the ignored `.env.local` and replace `YOUR_USER`.
2. Copy `config/command-profiles.example.json` to the ignored
   `config/command-profiles.local.json`. Keep only absolute executables that the
   owner intentionally allows as setup or acceptance commands.
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
   bun run check
   ```

The doctor fails closed when Kode is unavailable, its dedicated config is not
explicitly inherited, thinking/high effort is absent, the configured model is
not the model currently served, the runtime data directory cannot initialize,
or no owner-side command profile is available. It never prints API keys.

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

Every external command has a separate process guardian. If Conductor crashes,
the guardian observes ownership-pipe closure and kills the complete worker
tree. A replacement dispatcher retries the job as a new attempt only after the
recorded guardian is gone. A live guardian or missing process identity is
quarantined as `needs-input`; recovery never kills a bare PID. This favors a
safe false-positive quarantine over duplicate mutation or PID-reuse damage.

The generation-fenced queue lease is intentionally single-machine. Expired
heartbeats are not stolen from live local processes, which makes suspend safe.
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
