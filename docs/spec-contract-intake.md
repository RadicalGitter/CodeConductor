# Specification contract intake

The specification intake scripts provide the short path from approved product
meaning to one watched Conductor proposal job. They do not add another queue,
worker, review, or acceptance authority.

## Commands

From the Conductor checkout:

```powershell
bun run contract:builder -- start --title "Feature title" --target-project <profile-id> --seed "Initial request"
bun run contract:builder -- status --spec <draft-path>
bun run contract:builder -- finalize --spec <draft-path>

bun run contract:from-spec -- --spec <specification-path>
```

`contract:builder` copies the workspace template into `design-specifications`,
persists an ordinary Markdown draft, and reports the next missing question
batch. The model edits the draft through normal guarded file tools. `finalize`
requires every visible placeholder and readiness checkbox to be resolved, then
sets the frontmatter status to `conductor-ready`.

`contract:from-spec` hashes the specification bytes and parses only its
frontmatter; it does not ask the premium model to read or summarize the body.
It resolves the owner profile, compiles and enqueues one bounded job, and
remains as a non-model watcher. At terminal state it creates or validates the sealed review
bundle and sends a queued follow-up to the originating DSH session through the
local `/api/session.prompt` endpoint. `DSH_SESSION_ID` and `DSH_WEB_URL` are
already contributed to DSH shell environments.

The launcher should normally run as a background process. No persistent DSH
goal is needed.

## Specification frontmatter

```yaml
---
specification:
  slug: example-feature
  status: conductor-ready
  title: Example feature
  targetProject: example-project
conductor:
  initialPhase: phase-1
  scopeHints:
    - packages/example-feature
  verificationProfiles:
    - example-package
---
```

The body remains the authority for behavior, architecture, verification, and
acceptance. Frontmatter only selects owner policy and the first bounded scope.
A draft cannot launch. Scope hints are positive repository-relative paths and
must not contain traversal or glob syntax.

The default template is bundled in `templates/`; drafts default to the
workspace-level `design-specifications` directory beside the Conductor checkout.
Override them with `CONDUCTOR_SPEC_TEMPLATE` and `CONDUCTOR_SPEC_DIR` when the
checkout layout differs.

## Owner specification profiles

Profiles default to `~/.conductor/spec-profiles.json`; override the path with
`CONDUCTOR_SPEC_PROFILES_FILE`. The file is machine-local because it contains
repository, executable, model, and resource choices.

```json
{
  "schema": "conductor.spec-profiles/v1",
  "profiles": {
    "example-project": {
      "repositoryPath": "C:\\projects\\example",
      "baseRef": "HEAD",
      "adapterId": "kode",
      "adapterOptions": {},
      "protectedPaths": ["AGENTS.md"],
      "contextRefs": ["AGENTS.md"],
      "constraints": ["Preserve repository authority."],
      "verificationProfiles": {
        "example-package": [
          {
            "executable": "C:\\Program Files\\nodejs\\node.exe",
            "args": ["test.js"],
            "timeoutMs": 120000
          }
        ]
      }
    }
  }
}
```

The profile, not the model or specification, owns the repository route, worker
adapter, protected paths, executable commands, and timeout. Every named
verification profile in the specification must exist in the selected owner
profile or compilation fails.

Use `--dry-run` to inspect the compiled queue request without initializing or
mutating the Conductor runtime:

```powershell
bun run contract:from-spec -- --spec <path> --dry-run
```

## Review and correction

The watcher follow-up names the exact job, attempt, sealed packet, proposal
patch, changed paths, verification state, and specification. Review remains a
premium/owner action.

When review finds issues, launch a dependent correction against the proposal
lineage:

```powershell
bun run contract:from-spec -- \
  --spec <path> \
  --parent-job <job-id> \
  --finding "First independent issue" \
  --finding "Second independent issue"
```

The specification hash, parent jobs, findings, and profile identity produce a
deterministic idempotency key. A correction without findings is rejected. The
new launcher instance arms the next watcher and wakes the same DSH session when
it finishes.

## Boundaries

- Worker output remains proposal-only.
- The watcher can only prompt a loopback DSH URL.
- The watcher does not accept, merge, promote, commit, or push output.
- Failed or ineligible attempts still wake the session, but no review bundle is
  claimed.
- The MVP watcher is process-backed rather than restart-reconstructed. The
  durable queue and attempt evidence survive, but a killed launcher must be
  restarted manually to restore its DSH notification.
