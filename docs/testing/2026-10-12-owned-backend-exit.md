# LA-owned backend shutdown — 2026-10-12

## Implementation

- LA stops its owned backend before other exit cleanup. Native `Exit` also invokes
  the idempotent cleanup, so it does not rely on Rust destructors at process exit.
- An ordinary exit request without local terminal confirmation pending proceeds;
  confirmed exits retain the existing terminal confirmation behavior.
- A permanent exit flag cancels startup/health checks and rejects later startup
  requests. Ordinary backend `shutdown()` remains restartable.
- Ownership is the spawned `Child` handle, not a process-name search. Other LA
  instances and separately started backends are not selected for termination.
- Existing two-second forced-termination fallback remains for an unresponsive
  owned backend. Normal shutdown starts immediately rather than waiting for it.
- The companion KB patch closes the HTTP listener/connections before cancelling
  and joining runs, avoiding the old ten-second SSE drain wait. It refuses new
  HTTP requests, runs and compactions during shutdown and cancels runs before
  waiting on scheduler cleanup. Terminal cancellation is persisted before exit.

## Verification

macOS arm64, isolated bundle identifier/configuration/history. Both LA and KB were
built from the modified source. The local model fixture called real Bash `sleep`
while an SSE stream remained connected. Tests only cleaned up their own processes.

| Native action | LA, KB and tool all gone at first observation |
| --- | --- |
| Application menu Quit | 0.164 seconds |
| Cmd+Q | 0.196 seconds |
| Red close button with close behavior set to exit | 0.164 seconds |

No forced termination was needed in these cases. The desktop webview was inspected
through its test bridge and rendered the application. Close-to-tray was separately
checked: LA, KB and the active tool remained alive, as expected for hiding a window.
A later test used the exit preference and verified the physical close button.

The standalone KB process fixture measured 0.002 seconds when idle and 0.020–0.023
seconds with an active Bash task, including SSE and LA-style EOF plus TERM. No tool
process remained alive. Default standalone mode still ignores stdin EOF.

Rust manager tests cover owned-process isolation, startup cancellation, permanent
exit, restartable ordinary stop, forced termination of an unresponsive fixture,
authentication and a real compiled KB artifact. Existing backend-manager tests pass.
KB's full Go suite, backend race suite, CLI parent-stdio regressions and `go vet`
pass. The frontend and native desktop build succeeded. Windows shutdown was not
executed on a Windows host in this verification.

## Delivery

Both source patches are needed for the measured graceful active-task shutdown.
K-brain v0.107.6-beta.9 publishes commit 7728f5054eab45cef6b680b4a43c78fd4cb131e6,
including the memory-retention fix. The desktop lock now pins that release and
its verified SHA-256 values for all four desktop targets. No local binary is
committed; desktop release CI downloads the published backend/helper artifacts.
The intended desktop release is v2.0.0-beta.13. Installed user apps were not replaced
by the verification tests.
