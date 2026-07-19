# Provider custom headers worklog

## Goal

Add ordered custom HTTP headers to `CustomProvider` in both mirrored TypeScript frontends, inject them safely into LLM and model-discovery requests, redact header values in debug logs, and expose an editable settings UI.

## Constraints

- Branch: `feat/provider-custom-headers`, based on `upstream/main` at `b11a0a5`.
- Keep `crates/agent-gui` and `crates/agent-gateway/web` mirrored.
- Do not commit, push, or create a PR before manual Tauri validation.
- Do not change Rust unless the gateway model-discovery path proves it is required and the user approves.

## Progress

- [x] Fetched remotes and created the feature branch from the latest `upstream/main`.
- [x] Explored settings, runtime, UI, logging, and test paths with CodeGraph and read-only subagents.
- [x] Stage 1: settings model and normalization (GUI 42 tests, gateway 29 tests, both TypeScript checks passed).
- [x] Stage 2: request injection and debug redaction (Node 22 tests 42/42, both type checks, Rust `cargo check --tests`, and Go handler/server tests passed).
- [x] Stage 3: provider UI and i18n (both Node 22 type checks and GUI i18n tests passed; mirrored custom-header lines match).
- [x] Stage 4: tests and full validation.
  - GUI frontend tests pass 1012/1012; gateway WebUI tests pass 353/353.
  - Both TypeScript checks and Vite production builds pass under Node 22.19.0.
  - Full gateway `go test ./...`, GUI `cargo check --tests`, and GUI `cargo test` (430/430) pass; GUI backend tests pass 10/10.
  - Windows MSVC now links the Common Controls v6 manifest into both production and test executables; both artifacts were inspected after build.
  - Final independent security and mirror reviews found no actionable issues; `git diff --check` passes.
- [x] Applied manual UI feedback: the header-name field is now an editable preset dropdown in both frontends, while arbitrary valid header names remain supported.
- [x] Applied follow-up UI feedback: preset menus align with the header-name field's left edge, and header values use vertically resizable multiline textareas.
- [x] Re-ran both type checks, full frontend test suites, production builds, and mirror checks; restarted the Tauri dev client.
- [x] Manual revalidation completed as part of the provider dialog redesign approval.

## Resume

Manual validation is complete; include this foundation in the validated provider dialog feature submission.
