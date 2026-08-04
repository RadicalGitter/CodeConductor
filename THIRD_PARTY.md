# Third-party dependencies

Conductor's own source is independently implemented and currently unlicensed
for redistribution. External programs and libraries retain their own licenses.

| Dependency                         | Use                                 | License    |
| ---------------------------------- | ----------------------------------- | ---------- |
| `@modelcontextprotocol/sdk` 1.29.0 | MCP transport and schemas           | MIT        |
| Bun                                | Development runtime and test runner | MIT        |
| TypeScript                         | Type checking                       | Apache-2.0 |
| Prettier                           | Formatting                          | MIT        |

Kode Agent, Codex CLI, Claude Code, Aider, and other worker harnesses are
optional separately installed subprocesses. Their source is not included or
linked into Conductor.
