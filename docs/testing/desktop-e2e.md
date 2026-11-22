# Desktop end-to-end tests

The suite in `crates/agent-gui/e2e` drives the real desktop app (debug build,
production frontend embedded) through WebdriverIO, `tauri-driver` and
WebKitWebDriver on Linux. It never uses a real model provider, API key, or your
own data. Every spec file starts the app in a fresh temporary home whose K-brain
config points at a local fake OpenAI-compatible streaming server.

## What is covered

| Spec | Flow |
| --- | --- |
| `01-launch` | App boots to the chat composer; About reports K-brain healthy |
| `02-chat-stream` | A new session gets a streamed reply (several partial frames observed) |
| `03-tool-approval` | In "ask" mode the fake model's `Bash` call waits for approval; the marker file only exists after approving |
| `04-settings-persist` | Hiding a sidebar shortcut in Settings survives an app restart |
| `05-command-palette` | Open with Ctrl/Cmd+K, filter, run "open settings" |
| `06-session-switch` | Two sessions keep separate transcripts; switching via the sidebar |

## Running

### Docker (any host, closest to CI)

```sh
# arm64 hosts: no pinned arm64 Linux kn exists, so build one and pass it in.
LIVEAGENT_KBRAIN_BINARY=/abs/path/to/linux/kn crates/agent-gui/e2e/run-docker.sh
# Re-run without rebuilding the image or the app; extra args go to wdio.
E2E_SKIP_IMAGE_BUILD=1 E2E_SKIP_APP_BUILD=1 crates/agent-gui/e2e/run-docker.sh --spec specs/03-tool-approval.e2e.mjs
```

The script copies the checkout into a named Docker volume (Linux
`node_modules`, `target/` and the pnpm/cargo caches stay in volumes), builds the
app with network access, then runs the suite with `--network none` under Xvfb.
On x86_64 hosts `LIVEAGENT_KBRAIN_BINARY` can be omitted if the pinned release
is already in `crates/agent-gui/src-tauri/binaries/`
(`node scripts/release/prepare-kbrain.mjs --release`).

### Linux host

```sh
crates/agent-gui/e2e/docker/install-linux-deps.sh
cargo install tauri-driver --locked --version 2.0.6
node scripts/release/prepare-kbrain.mjs --release   # or set LIVEAGENT_KBRAIN_BINARY
pnpm build:e2e:desktop
xvfb-run -a dbus-run-session -- pnpm test:e2e:desktop
```

### Browser host smoke (macOS/Windows, no native shell)

`tauri-driver` has no macOS support. For a quick check of the same specs
against the browser host (Vite dev server talking to kn directly, headless
Chrome):

```sh
LIVEAGENT_KBRAIN_BINARY=/abs/path/to/kn pnpm --filter @liveagent/desktop-e2e test:web
```

This exercises the shared UI and kn, not the Tauri shell, IPC or WebKitGTK.

### Useful variables

| Variable | Purpose |
| --- | --- |
| `LIVEAGENT_KBRAIN_BINARY` | Absolute path to kn; otherwise the pinned release in `src-tauri/binaries` (downloaded if missing) |
| `E2E_ARTIFACTS_DIR` | Screenshots, page HTML, app/kn logs, fake provider request log (default `e2e/.artifacts`) |
| `E2E_RUN_DIR` | Temporary homes and workspaces (default `e2e/.run`) |
| `E2E_SCREENSHOTS=always` | Also screenshot passing tests |
| `E2E_APP_BINARY` | Use a different desktop binary |
| `E2E_TARGET=web` | Browser host target (what `test:web` sets) |
| `E2E_TEST_TIMEOUT` / `E2E_RETRIES` | Per-test timeout in ms (default 180000) and retries (default 1 in CI, 0 locally) |
| `E2E_LOG_LEVEL=info` | Log every WebDriver command to `<artifacts>/wdio-logs` |

## CI

`.github/workflows/desktop-e2e.yml` runs on `ubuntu-24.04` with the same
package list as the Docker image. It runs on PRs that touch the desktop app,
shared UI or build inputs, on pushes to `main` (to refresh the Rust cache),
nightly, and on demand. Screenshots and logs are uploaded as the
`desktop-e2e-artifacts-*` artifact when the job fails.

## Writing a spec

- Add `specs/NN-name.e2e.mjs`. Each file runs in its own app session and home,
  so do not depend on state from another file.
- Select elements by `data-testid` (or existing `data-*` hooks), never by
  visible text: the UI is localized and defaults to Chinese. Add a
  `data-testid` to the component when no stable hook exists.
- Steer the model through the prompt. `support/fake-provider.mjs` streams
  `replyFor(prompt)` for plain prompts and answers prompts containing
  `TOOL_MARKER` with a `Bash` tool call that writes `toolMarkerFile`. Add a new
  marker there for new model behaviour instead of matching on request details.
- Use the helpers in `support/app.mjs` (`sendPrompt`, `waitForAssistantText`,
  `waitForIdle`, `openSettings`, `openCommandPalette`, `restartApp`) and wait
  on conditions, not sleeps. App shortcuts are registered in effects after the
  first render; wait for a readiness marker (like `data-command-palette-ready`
  on `<html>`) before pressing them instead of racing the listener.
- The first-run guide is turned off for every spec (`LIVEAGENT_SKIP_ONBOARDING=1`
  for the debug desktop build, `VITE_LIVEAGENT_SKIP_ONBOARDING=1` for the web
  target) so it never covers the app. A spec whose file name contains
  `onboarding` keeps it on; that only works on the Tauri target.
- `restartApp()` relaunches the desktop process with the same home on the
  Tauri target (a page reload on the web target).
- Type with `insertText()` / `typePrompt()`, not `browser.keys()` with a
  string: WebKitWebDriver drops repeated characters and spaces when sending
  text key by key into a contenteditable.
- In CI each test is retried once; a test that only passes on retry is still
  shown in the log and should be fixed. The first launch of a session is also
  relaunched once if WebKitGTK comes up blank (logged as
  `[e2e] launch attempt 1 failed`).

The bundle, size, knip and performance checks that run next to this suite are
described in [ci-checks.md](ci-checks.md).
