# AI approval settings UI consistency

## Scope

The AI approval section now reuses `SettingsSection`, `SettingsCard`,
`SettingsRow`, `SettingsToggleGroup`, and the searchable, provider-grouped
`ModelPicker` used by other LA settings. Chinese and English strings live in
shared translation catalogs. Backend approval semantics and the three modes
(`off`, `risk_only`, `auto`) remain unchanged.

The form now shows mode-specific descriptions, missing/unavailable model
validation, loading/saving/dirty status, reload with discard confirmation,
and retriable errors. Turning approval off retains the reviewer choice.
Unchanged/invalid/in-flight settings cannot be submitted. Save requests still
contain only the `aiApproval` subtree through the host adapter; no model
execution has moved into the frontend.

Async operations discard responses from obsolete adapter instances and check
the direct backend connection before saving or applying results. Gateway
connections expose no direct backend identity, so those checks do not assert
identity guarantees for gateway session switches.

## Verification

- Frontend suite: 3159 passed, 1 skipped, 0 failed, using the existing pinned KB.
- Seven focused DOM tests cover modes, failed writes and retry, draft discard,
  missing capability, unavailable models, failed reads and retry, direct backend
  changes, and stale asynchronous load responses.
- GUI and WebUI TypeScript checks passed.
- Shared UI boundary and changed production-file Biome checks passed.
- Chrome fixture at 1280×1000 and 390×844 exercised real shared controls:
  mode selection, model search, save/reload, failed save and retry, failed load
  and retry, draft-discard cancellation/confirmation, removed model recovery,
  Chinese/English, WebUI manual-approval notice, and the computer-settings page
  sharing the backend settings document. No page errors or horizontal overflow.
- Browser settings responses were intercepted fixtures. This UI-only work did
  not call paid models, exercise live risk decisions, modify user configuration,
  or launch the installed Tauri application.

Reproducible browser fixture and instructions:
`crates/agent-gui/test/settings/ai-approval-browser/README.md`.

Changes are isolated on `fix/ai-approval-settings-ui`, based on `v2-kbrian`.
The previous MCP/instruction-file worktree remains untouched. The destination
branch is `v2-kbrian`; this change does not create a release.
