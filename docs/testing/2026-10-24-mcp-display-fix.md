# MCP configuration visibility regression

## Findings

- Native settings loaded legacy SQLite MCP records, then replaced them with K-brain's empty list without importing them.
- Gateway settings reconstruction read MCP from legacy SQLite instead of the backend, so new backend records disappeared from WebUI snapshots.
- An omitted backend `selected` list retained stale legacy selections in the desktop adapter.
- K-brain returned redacted environment/header credentials but erased those credentials when the redacted records were saved again. The paired backend fix preserves omitted credentials and supports explicit empty-map clears.

## Changes

- Import missing legacy MCP servers only into the managed local backend. Keep existing backend records authoritative; record successful migration IDs by native storage identity so deleted records stay deleted. Failed imports remain retryable. External backends never receive local SQLite servers.
- Build Gateway MCP snapshots from authenticated `/v1/mcp` reads. Empty backend lists and omitted selections clear stale SQLite values.
- Keep the frontend responsible for configuration/presentation only; MCP connections and tool execution remain in K-brain.

## Verification

- Settings HTTP regressions cover authenticated migration, conflicting IDs, enabled state, selected IDs, failed-write retry, external-backend isolation, reload and deletion.
- Rust tests cover backend MCP snapshot precedence and authenticated HTTP reads. Gateway unit tests: 31 passed.
- Browser harness: Chrome at 1280×900 and 390×900, desktop and WebUI adapters. Exercised MCP Hub, embedded settings and workspace resource list; toggle, edit/save, search, reload and deletion. Each case also listed and called a real stdio MCP server through K-brain.
- The desktop browser harness uses the shipped settings loader with simulated native SQLite IPC. WebUI uses the shipped settings-sync reducer with backend payloads; the Rust HTTP bridge is covered separately. This is not a full packaged Tauri-to-Gateway acceptance run.
- Desktop frontend suite using the locally built paired K-brain binary: 3428 passed, 10 skipped. WebUI suite: 816 passed. Shared UI/desktop/WebUI TypeScript checks passed.
- The initial desktop suite run without an explicit backend binary failed release-download-dependent tests and one timing-sensitive composer test under load. Repeating with `LIVEAGENT_KBRAIN_BINARY` pointing at the paired local build passed the complete suite.
- K-brain MCP/backend race tests and vet passed, including preservation of redacted credentials and explicit clear regression tests.

## Delivery

The LiveAgent change and the K-brain credential preservation change are paired source fixes. No release tag or packaged dependency update is included in this task.
