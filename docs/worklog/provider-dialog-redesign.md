# Provider dialog redesign worklog

## Goal

Redesign the mirrored provider add/edit dialogs in agent-gui and agent-gateway/web using mockups/provider-dialog.html as the interaction baseline: responsive two-column navigation, dedicated basic/network/header panels, table/card header editing, and inline model capability editing.

## Constraints

- Branch: feat/provider-dialog-redesign, based on upstream/main at eff71a0.
- Preserve the existing uncommitted custom-header foundation.
- Keep both TypeScript frontends mirrored while retaining their intentional component API differences.
- Do not change Rust or connect model capabilities to runtime behavior.
- Do not commit, push, or create a PR before manual Tauri validation.
- Do not touch untracked .codegraph/, mockups/, or uploads/.

## Progress

- [x] Read global rules, applicable redesign skills, and the full provider dialog prototype.
- [x] Fetched upstream/main and created feat/provider-dialog-redesign at eff71a0.
- [x] Completed parallel read-only exploration of both dialogs, settings normalization, i18n references, UI primitives, tests, and prototype mapping.
- [x] Stage 1: two-column dialog shell and three local UI panels.
  - Both TypeScript checks pass; GUI settings/i18n tests pass 130/130; gateway settings tests pass 29/29.
- [x] Stage 2: basic/network/header panel content and header editor redesign.
  - Both TypeScript checks pass; relevant GUI tests pass 169/169; gateway settings tests pass 29/29.
- [x] Stage 3: ModelCapability normalization and inline model editing.
  - Both TypeScript checks pass; GUI settings/i18n tests pass 131/131; gateway settings tests pass 30/30.
- [x] Stage 4: responsive layout at max-width 720px.
  - Both TypeScript checks pass; GUI settings/i18n tests pass 131/131; gateway settings tests pass 30/30.
- [x] Stage 5: mirrored i18n, compatibility tests, and complete validation.
  - Full GUI tests pass 1013/1013; full gateway/web tests pass 354/354.
  - Both TypeScript checks and Vite production builds pass under Node 22.19.0; git diff --check passes.
- [x] Started the Tauri debug client, completed manual validation, and stopped the debug process after approval.

## Key findings

- Gateway uses useModalMotion plus settings-modal-* classes; GUI does not.
- Gateway DropdownMenu uses asChild; GUI uses Base UI's render prop.
- No reusable Switch primitive exists in either frontend, so the dialog needs a small local accessible switch component.
- promptCachingEnabled and nativeWebSearchEnabled remain persisted/runtime fields but have no current toggle state in ProviderModal; preserve defaults and omit UI.
- ProviderModelConfig capabilities are mirrored, filtered to reasoning/vision/tools, and covered for legacy and unknown-value normalization.

## Resume

1. Commit the validated changes with a conventional commit message.
2. Push feat/provider-dialog-redesign to the source remote.
3. Open a PR with design notes, changed areas, validation results, and screenshots when available.
