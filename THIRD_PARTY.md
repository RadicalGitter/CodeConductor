# Third-party dependencies

Conductor's own source is independently implemented and currently unlicensed
for redistribution. External programs and libraries retain their own licenses.

| Dependency                         | Use                                 | License                             |
| ---------------------------------- | ----------------------------------- | ----------------------------------- |
| `@modelcontextprotocol/sdk` 1.29.0 | MCP transport and schemas           | MIT                                 |
| Zod 4.4.3                          | Runtime contract validation         | MIT                                 |
| Bun                                | Development runtime and test runner | MIT                                 |
| TypeScript                         | Type checking                       | Apache-2.0                          |
| Prettier                           | Formatting                          | MIT                                 |
| Docker Desktop / Engine            | Optional external verifier runtime  | Proprietary / Apache-2.0 components |
| BusyBox 1.36.1 image               | Optional escape-canary image        | GPL-2.0                             |

Kode Agent, Codex CLI, Claude Code, Aider, and other worker harnesses are
optional separately installed subprocesses. Their source is not included or
linked into Conductor.
