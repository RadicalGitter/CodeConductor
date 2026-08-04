# Kode delegate parity map

- Baseline repository: `Z:\Programmering\Kode-CLI`
- Baseline revision: `328676d`
- Baseline package: `packages/mcp-delegate`
- Target: independent Conductor implementation

This is interface and workflow compatibility, not source extraction. Baseline
source remains available only as historical evidence until parity is accepted.

| Workflow or contract                                     | Baseline evidence              | Target owner                | Status  | Verification                |
| -------------------------------------------------------- | ------------------------------ | --------------------------- | ------- | --------------------------- |
| List available Kode/Codex/Claude backends                | MCP `list_delegate_backends`   | Worker registry             | pending | MCP characterization        |
| Create sibling worktree at exact base revision           | Returned `WorktreeHandle`      | Workspace manager           | pending | temporary Git fixture       |
| Explicit conservative permission defaults                | Adapter argument builders      | Worker adapters             | pending | invocation snapshots        |
| Stable job and attempt IDs                               | `kode-delegate-result/v2`      | Job store                   | pending | duplicate/retry tests       |
| Freeze objective/repository/base ref                     | `job.json`                     | Job store                   | pending | mismatch rejection test     |
| Durable atomic attempt manifest                          | `manifest.json`                | Artifact store              | pending | restart/readback test       |
| Store stdout/stderr separately                           | attempt artifacts              | Artifact store              | pending | content/hash test           |
| Distinguish timeout/cancel/spawn/backend/harness failure | manifest fields                | Process runner/orchestrator | pending | lifecycle tests             |
| MCP cancellation reaches complete Windows process tree   | `AbortSignal`, `taskkill /T`   | Process runner              | pending | child-and-grandchild canary |
| Retain worktree after completion or cancellation         | explicit cleanup tool          | Workspace manager           | pending | lifecycle smoke             |
| Explicit worktree removal                                | MCP `remove_delegate_worktree` | Workspace manager           | pending | exact-target test           |
| Caller-specified attempt replay is idempotent            | duplicate result               | Orchestrator                | pending | same-ID no-respawn test     |

## Deliberate first-version changes

- Conductor schemas use a provider-neutral `conductor.*` namespace rather than
  `kode-delegate-*`.
- Job contracts include scope, context, constraints, acceptance commands, and
  escalation triggers from the start.
- Worker output never shares a schema with authoritative acceptance.
- Kode-specific executable discovery and CLI flags live only in its adapter.
- Conductor is private and `UNLICENSED`; no Kode implementation source is
  copied into it.

## Known baseline issues not preserved

- Permission mode strings did not mechanically enforce allowed paths.
- Worktrees did not receive a dependency/setup strategy.
- Acceptance commands were described but not executed by the harness.
- `needs-input` existed in the type vocabulary but was not parsed from worker
  output.
- Full-suite evidence was impractical to obtain inside short test bounds.
