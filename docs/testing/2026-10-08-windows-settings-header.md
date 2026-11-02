# Windows settings header — issue #922

The settings overlay used the old 32px, translucent, native-looking React title bar.
Windows decorations were already disabled in both the platform configuration and Rust
startup. Settings is an overlay in the main window, not a separate native window.

Settings now uses the same AppHeaderFrame as the chat workbench (the shared
app-header-height, background and window control component). The settings header adds
a localized title and Back to Chat button. Existing sidebar navigation and Escape remain.
The chat subtree retains its height while the settings overlay opens or closes.
macOS/Linux do not render this Windows-only header. Boot/error title bars are unchanged.

Validation:

- 10 focused DOM/layout tests passed, including native-command mocks, maximize/restore,
  back navigation, frame identity and non-Windows exclusion.
- Browser component integration passed at 1280px, 480px (Windows minimum) and 390px,
  in light/dark themes: shared height/background, system/providers/MCP/cron navigation,
  minimize/maximize/restore/close command dispatch, focus state, Back/Escape and unchanged
  underlying chat geometry. Actual React components and CSS were used; Tauri window
  methods were mocked. Screenshots are local test artifacts, not Windows OS evidence.
- Desktop and WebUI typechecks and production builds passed. UI boundary check and
  changed-source Biome check passed.
- WebUI suite: 770 passed. Desktop frontend suite had four failures: the three
  kbrain-question-answer production cases and prompts-backend. Running those tests on
  the unchanged base reproduced all four; no titlebar modules are involved in them.

Windows 11 native drag, double-click maximize, OS focus/minimize/close behavior and
decoration visibility still require native Windows acceptance. macOS browser tests do
not establish those OS behaviors. No Rust or native decoration configuration changed.
