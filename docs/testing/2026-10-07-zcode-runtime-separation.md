# ZCode-style runtime separation acceptance

## Architecture

- LA presents chat, permissions, plans and screenshots. Its turn API rejects client tool registration.
- The native host owns process lifecycle, connection credentials and health checks only.
- KB initializes storage and migrates legacy data before starting its runtime. The native host passes
  `-data-dir` and, for default installations, `-legacy-desktop-dir`; it no longer creates configuration
  or copies user data. Explicit data-root overrides do not import unrelated default directories.
- Gateway stays a server-side protocol adapter. HTTP/SSE remains the LA/KB protocol.
- KB owns Cua MCP sessions, tool execution, approval policy and screenshot results.
- Storage stays a KB module, not a separate network service. Multi-endpoint routing is out of scope.

## Verification

- KB full Go suite and focused storage/backend/agent/Cua race tests passed before release preparation.
- Storage tests cover restart persistence, separate roots, invalid configuration preservation,
  configuration permissions, migration idempotence and honoring old desktop migration markers.
- LA boundary/bootstrap/reconnect/turn tests: 63 passed.
- Desktop and Gateway Web TypeScript checks passed.
- Gateway canonical event/settings tests passed, including screenshot conversion.
- Browser checks at 1280×900 and 390×844 passed: settings save/reload, invalid argv JSON,
  missing driver, failed persistence, navigation through MCP/tools/providers, no horizontal overflow
  or page errors. These use an isolated fixture backend, not personal user data.
- Native-host lifecycle: 9 passed; real Go backend integration: 1 passed (authentication,
  stop/restart, configuration preservation). Packaging contract tests: 11 passed.

## Release

- KB `v0.107.6-beta.2`, source `2ec88ab31f66ec6b27b61a72de39776f6d464407`.
- LA targets `v2.0.0-beta.5`; the lock pins KB Release URLs and published SHA-256 checksums.
- LA release jobs download KB binaries; no backend compilation was added to LA CI.

## Remaining limitations

- Cua Driver remains a separately installed prerequisite. It is not downloaded or bundled by this release.
- Installed Cua verification covered protocol discovery and permission status only. macOS Screen Recording
  permission was unavailable; real desktop clicks, capture and drag-and-drop have not been accepted.
- The old frontend self-target guard is no longer used. Equivalent native host-window exclusion is not
  implemented in the KB Cua adapter; backend approval is not a substitute for that exclusion.
- The old native installed-app mention picker has not been migrated to a KB endpoint.
- Legacy tool source modules remain for compatibility, but the KB chat path does not execute them.
- This record does not claim every historical main-branch feature or every OS has been manually tested.
