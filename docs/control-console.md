# Conductor control console and Windows tray

The control console is a standalone loopback Queue/Settings UI backed by the
durable Conductor queue. It serves versioned snapshots and an SSE stream; it
never reads full worker logs into the browser.

## Start

```powershell
bun run start:mcp      # authoritative dispatcher; also hosts the console when available
bun run start:console  # observer/model-control host; does not acquire the dispatcher lease
bun run start:tray
```

The standalone console deliberately does not become a second dispatcher. Its
cancel/retry controls are disabled unless it is hosted by the process that owns
dispatcher control authority. `start:tray` is Windows-only. It creates one notification-area icon per
Conductor data root. A second invocation activates the existing icon. **Exit
Tray** removes only the icon; it does not cancel jobs or stop the separately
running console/model process.

The default console is `http://127.0.0.1:8787`. `CONDUCTOR_CONSOLE_HOST` and
`CONDUCTOR_CONSOLE_PORT` are owner-machine overrides. Hostnames are resolved at
startup and every address must be loopback. The tray derives this endpoint from
the same environment/settings document rather than assuming the default port.

## Model-service profile

Profiles are machine-local and default to
`~/.conductor/model-service-profiles.json` (override with
`CONDUCTOR_MODEL_SERVICE_PROFILES_FILE`). Example:

```json
{
  "schema": "conductor.model-service-profiles/v1",
  "profiles": {
    "qwen38-256k": {
      "schema": "conductor.model-service-profile/v1",
      "profileId": "qwen38-256k",
      "endpoint": { "host": "127.0.0.1", "port": 7332, "basePath": "/" },
      "expected": {
        "model": "Qwen3.8-27B-NVFP4-MTP-MEDIUM",
        "context": 262144,
        "contextSource": {
          "kind": "probe",
          "path": "/slots",
          "field": "0.n_ctx"
        }
      },
      "launch": {
        "executable": "C:\\Windows\\System32\\cmd.exe",
        "args": [
          "/d",
          "/s",
          "/c",
          "\"Z:\\Programmering\\launch-qwen38-text-256k-kv.bat\""
        ],
        "cwd": "Z:\\Programmering"
      },
      "readiness": {
        "startupTimeoutMs": 900000,
        "probeIntervalMs": 2000,
        "requestTimeoutMs": 5000
      },
      "stopTimeoutMs": 30000
    }
  }
}
```

Conductor probes first. It starts only when the endpoint is offline, refuses a
wrong model/context, and serializes starts with a machine-local fence. A started
service runs inside the existing process guardian. Stop authority is an
in-memory guardian handle and is never reconstructed from a PID, executable
name, or stale state record. Executable and script hashes are persisted as
evidence; command arguments and process IDs are omitted from browser/MCP
projections.

The console refuses unload while queue work is dispatching, running, or
cancelling, while `/slots` reports active inference, or when slot activity cannot
be verified. Externally started servers are visible but cannot be unloaded by
Conductor. Probe timeouts, malformed responses, and HTTP failures are treated as
indeterminate and never authorize a second launch. Tray model operations run off
the WinForms thread and notify only after a durable completed outcome or failure.

## Mutation safety

Browser mutations require JSON, same-origin browser requests, a live CSRF
token, an idempotency key, and the caller's observed queue/settings/model
revision. Stale controls receive HTTP 409. Idempotency is recorded only after a
successful operation. Console bind, model profile, and dispatcher-concurrency
changes apply after process restart; saved concurrency is used unless the
`CONDUCTOR_MAX_CONCURRENT` owner override is present.

## Next improvement pass and residual risks

**Status:** planned supporting guidance, not implemented behavior. Read this
section when improving the tray, control console, dispatcher coexistence, model
lifecycle, settings durability, or large-queue performance.

The next pass should address these boundaries in roughly this order:

1. **Separate model-lifecycle broker.** A model launched by Conductor is owned by
   a guardian handle in the launching console/MCP process. Exit Tray remains
   harmless, but force-killing or crashing that owner process closes the guardian
   and therefore terminates its model tree. Move lifecycle ownership and stop
   authority into one dedicated local broker before claiming that console-process
   failure cannot affect a Conductor-owned model.
2. **Atomic shared-client drain before unload.** Unload currently refuses active
   Conductor queue states and busy or unverifiable llama `/slots`. This prevents
   the known unsafe cases but is an observation, not a server-side drain lock: an
   unrelated client could begin inference after the idle probe and immediately
   before stop. Until the model server exposes a drain/lease protocol, treat
   unload as safe only in an owner-controlled client environment.
3. **Durable mutation replay and cross-process settings CAS.** HTTP idempotency
   bindings are memory-resident and disappear on console restart. Queue/model
   revisions still reject most duplicate effects, and settings writes are atomic,
   but two independent settings writers do not share a lock. A restart during a
   retry may therefore return a stale-revision conflict instead of replaying the
   original success; concurrent settings writers may require one owner to reload
   and reapply.
4. **Dispatcher command forwarding.** A standalone console intentionally does
   not acquire or steal the dispatcher lease. When MCP owns the dispatcher but
   cannot host the console because another process already occupies the console
   port, the observer UI disables Cancel/Retry rather than attempting an unsafe
   in-memory cancellation. Add an authenticated local command channel to the
   lease owner before enabling those controls in an observer process. A
   `recoverable-dead-local` or corrupt lease still requires the existing typed
   reconciliation flow; the console never repairs it implicitly.
5. **External endpoint refresh.** The console observes an external model at
   startup and Conductor-owned process completion updates state, but externally
   started or stopped services are not continuously reprobed. The page can be
   stale until restart or an explicit model action. Add a bounded shared observer
   cadence without overlapping long lifecycle operations.
6. **Large-queue and browser behavior.** SSE snapshot construction is shared and
   coalesced, but each snapshot still reads and projects the whole queue and the
   browser replaces the full table. Large histories may increase disk latency,
   memory use, lost focus/scroll position, and screen-reader noise. Add durable
   pagination, incremental rows, focus preservation, and quieter live regions.
7. **Evidence and power-loss hardening.** Model launch hashes still have a
   pre-spawn replacement window, missing absolute argument files are not all
   explicit failures, launch logs reuse fixed filenames, fence liveness can be
   delayed by PID reuse, and atomic JSON rename does not fsync the parent
   directory. These do not create transferable PID kill authority, but they can
   weaken provenance, retention, stale-lock recovery, or sudden-power-loss
   durability.

Phase 1 also deliberately does not implement pause/resume, transcript
checkpointing, or KV save/restore. Disabled controls must remain disabled until
the later cooperative safe-point protocol has its own durable transition and
failure evidence.

## Phase boundary

This phase provides Queue/Settings, load/unload, notifications, and durable
state projection. **Pause All**, **Withdraw Pending Pause**, and **Resume** are
visible but disabled. They become active only after the cooperative Kode and KV
checkpoint protocol is implemented; this console does not claim transcript or
in-flight generation pause.
