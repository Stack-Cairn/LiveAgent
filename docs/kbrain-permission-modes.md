# K-brain permission modes

The shared composer mode selector is used by desktop and Gateway WebUI. Mode changes update settings and the plan control; execution and approval remain backend-owned.

| Label | Persisted selection | K-brain `permission_mode` |
| --- | --- | --- |
| 计划模式 / Plan | `planModeEnabled: true` | `plan` |
| 变更前确认 / Confirm changes | `ask` | `normal` |
| 自动编辑 / Auto edit | `autoEdit` | `auto_edit` |
| 自动审查 / Auto review | `autoReview` | `auto_review` |
| 完全访问 / Full access | `auto` (existing selection) | `full_access` |
| 沙箱 / Sandbox | `sandbox` | `auto_edit` + `sandbox: {mode: "workspace", network: true}` |
| 离线沙箱 / Offline sandbox | `sandboxOffline` | `auto_edit` + `sandbox: {mode: "workspace", network: false}` |
| 始终允许 / Always allow | `always` | `always` |

Selecting a non-plan mode leaves plan mode. Selecting plan preserves the underlying permission selection so leaving plan can restore it. Existing plan submission/approval continues through K-brain's `ExitPlanMode` flow.

Shift+Tab in the composer editor cycles 始终询问 → 自动编辑 → 计划 → 始终询问 (ask → auto edit → plan → ask) in both hosts. Entering plan keeps auto edit underneath, so the plan pill restores it; leaving plan with Shift+Tab selects ask. From auto review, always allow or a sandbox mode one press returns to ask; always allow is only chosen from the menu. An open completion popup keeps Shift+Tab, and outside agent mode or while the composer is disabled Shift+Tab keeps its focus behaviour. The new mode is named beside the selector for 1.5 s. A change made while a turn runs applies from the next run, because the mode is sent when a run starts; turns already queued keep the mode they were queued with (strictest wins), so with a queue the notice says the change reaches new messages. In a background pane the first Shift+Tab only focuses the pane, like its other controls, so a step never changes one of its two settings without the other.

The new `always`, `auto_edit` and `auto_review` modes require K-brain to advertise them through `/v1/health`. Both the desktop HTTP client and Gateway backend client reject unsupported modes before submitting a run. Deploy the matching K-brain changes before enabling these modes in production; the pinned release is not changed by this implementation.

Full access honors backend per-tool ask/deny rules and configured AI review. Always allow skips interactive/AI review but not explicit denials or filesystem/sandbox boundaries. Auto review uses the reviewer configured in AI approval settings; unavailable or uncertain review falls back to a user confirmation, not silent approval.

The sandbox modes approve file edits automatically and run shell commands without asking, inside K-brain's OS sandbox: commands can write only to the workspace (and temp), sensitive directories are hidden where the platform supports read masking, and the offline variant also blocks the network. A configured AI reviewer still sees every command, and explicit deny rules still apply. Plan mode keeps the sandbox for anything it lets through.

Commands run in K-brain, so the desktop selector reads `capabilities.run_sandbox` from K-brain's `/v1/health`, not a desktop probe; the WebUI leaves it unknown and relies on the Gateway's check at submission. On the desktop the entries are disabled, with K-brain's reason, when the capability is absent or unsupported; the offline entry also needs `network_control`, and the description drops the read-masking promise when `read_masking` is false. Both entries are also disabled when `path_protection` is false (K-brain's Linux Landlock fallback): the protected workspace paths (`.liveagent/`, `.k-brain/`, `.git/hooks`, `.git/config`) would stay writable inside the sandbox and are later used outside it. Older K-brain builds omit the field and count as protected, unless they report the `landlock` mechanism. The desktop client and the Gateway both refuse to submit a sandboxed run the backend cannot enforce, including one without path protection, and K-brain itself rejects one with `400 options.sandbox`, so a sandbox mode never runs commands unconfined. A remote/queued request cannot loosen a stricter local selection.

Transport ownership:

```text
Desktop composer → HTTP run request → K-brain authorization/execution
Gateway WebUI → WebSocket command → Gateway → HTTP run request → K-brain
K-brain events → desktop / Gateway → WebSocket events → WebUI
```

The transport does not make authorization decisions. The existing run/client-request identity and accepted-run recovery prevent a reconnect from creating duplicate work.

## Verification (2026-10-18)

- GUI frontend: 3,234 tests passed, one unrelated skip; WebUI: 793 passed. Shared UI, GUI and WebUI TypeScript checks passed.
- `permission-modes-backend.test.mjs` starts the actual K-brain executable and uses LiveAgent's HTTP client and shared mode mapper. Nine scenarios verify actual Write/Bash side effects, permission rejection/approval, plan restrictions, automatic edits, full access, always allow and low/unknown AI review. The model provider is a localhost scripted HTTP fixture; no production credentials are used.
- Gateway tests transmit real Protobuf WebSocket frames through the browser handler into the HTTP backend client for all six modes. Separate client tests reject unsupported modes before POST and preserve request identity. Related Gateway packages passed the Go race detector.
- Shared selector verified in Chrome at 1280×850 and 390×850 through both GUI and WebUI entry points: all six choices, plan exit, reload persistence, bounded menus and no uncaught page errors.
- macOS arm64 native debug build launched with isolated home/config directories and the matching K-brain binary. All six choices worked in the actual composer; always allow survived reload and was persisted to the isolated SQLite configuration. No personal configuration was modified. Native settings normalization test passed.

Reproduce the cross-repository tool-execution test after building K-brain:

```sh
cd /path/to/K-brain
go build -o /tmp/kbrain-permission-modes ./cmd/kn
cd /path/to/LiveAgent/crates/agent-gui
LIVEAGENT_KBRAIN_BINARY=/tmp/kbrain-permission-modes node --test test/chat/permission-modes-backend.test.mjs
```

The native verification used `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'` and a debug backend override; it is not a release packaging test. Production upstream models, Windows/Linux native applications and release signing/updater delivery were not exercised. The backend release pin remains unchanged until a matching K-brain release is available.
