# agent-gateway tests

All project-level gateway tests live under `crates/agent-gateway/test` and are split by boundary:

| Directory | Coverage |
| --- | --- |
| `auth/` | HTTP bearer parsing and WebSocket token auth behavior |
| `http/` | Gateway HTTP route auth, `/api/status`, and SPA fallback |
| `session/` | Session manager behavior |
| `tunnel/` | Public tunnel proxying |
| `upload/` | `/api/files/import` validation, multipart parsing, and agent forwarding |
| `websocket/` | WebSocket auth, request forwarding, chat streaming, and cancellation-facing events |

The gateway no longer ships a WebUI: the browser frontend was folded into
`crates/agent-gui` and the gateway only serves a static retirement page from
`webui-retired/`.

Run the tests from `crates/agent-gateway`:

```sh
go test ./...
```
