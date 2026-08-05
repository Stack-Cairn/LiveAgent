# frontend tests

All new project-level tests live under `crates/frontend/test` and are split by feature area:

| Directory | Coverage |
| --- | --- |
| `settings/` | Settings normalization, provider routing, hooks, cron, MCP, remote config |
| `chat/` | Uploaded files, UI message rounds, seed tool recovery, conversation segments |
| `providers/` | Proxy URL validation, provider payload hooks, caching, storage metadata |
| `tools/` | Workspace-relative path validation and custom system tool registration |
| `i18n/` | Locale normalization and translation key parity |
| `backend/` | Cargo smoke test that runs the existing Tauri backend unit suite |

Run everything from `crates/frontend`:

```sh
pnpm test
```

Run only the faster frontend/node tests:

```sh
pnpm test:frontend
```

Run only the backend smoke wrapper:

```sh
pnpm test:backend
```
