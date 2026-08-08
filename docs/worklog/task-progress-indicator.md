# Current-session TodoWrite task progress indicator

## Goal

Project the latest valid full `TodoWrite` list from the current conversation transcript/history and show it as an accessible, mirrored progress pill above the desktop GUI and Gateway WebUI composers.

## Baseline and isolation

- Original development baseline: `upstream/main` at `88e7c5daf31d249453c3a39dd0e50c35219b223f`.
- Original development branch and Worktree: `codex/feat-task-progress-indicator` in `target\codex-task-progress-worktree`.
- The original stacked submission retained commit `580f7b83` from upstream PR #343 without cherry-picking. PR #343 was later closed without merging; PR #345 now intentionally carries that ingress fix as its first commit and declares `Depends-On: none` / `Stack-Root: #345` as the replacement root.
- 2026-08-06 maintenance baseline: latest `upstream/main` at `00a2c6fc43754f40022b0703459824559bee73ea` in the current main workspace on `chore-pr-345-rebase`; no historical Worktree was entered, modified, or cleaned.
- Original PR head `7fb09683` rebased without conflicts to product HEAD `8a0663e4`; both commits are patch-equivalent in `git range-diff`, with the same 28-file `4042 insertions / 61 deletions` scope.
- The main workspace's protected `Cargo.toml`, `.codegraph/`, `output/`, and local-only `start-tauri-dev.bat` state remain outside this PR maintenance change.

## Progress

- Added mirrored pure transcript projection models for successful results and complete streaming-argument fallback.
- Invalid, partial, and failed settled updates preserve the previous valid snapshot; a valid empty list clears it.
- Added a props-only mirrored progress component with running, pending, interrupted, and completed states.
- Added delayed hover/focus close, Escape close, touch toggle, absolute expansion, reduced-motion handling, narrow/long-list constraints, and ARIA progress state.
- Wired both composer adapters, localized copy, composer slots, and mirror manifest entries.
- After the first manual acceptance pass showed the legacy `TodoWrite` list in the transcript, the user clarified that task lists must live only above the composer. Both transcript renderers now hide every `TodoWrite` block while retaining all other tool blocks and the underlying transcript/history data.
- The desktop adapter now subscribes to the current conversation's live rounds, so the first complete streaming `TodoWrite` arguments project into the pill without waiting for history persistence. Gateway WebUI already projects its combined live and folded rows.
- After the second manual pass exposed rAF-coalesced status jumps, the pure model was extended to retain every valid TodoWrite call snapshot in source order and deduplicate live/history overlap by call id. A mirrored sequencer now displays newly observed real snapshots at 180 ms intervals, while initial/restored history adopts the latest state immediately and live-to-history handoff does not replay.
- After the third manual pass showed that later full-replacement calls could shrink or rewrite the visible roster, the first TodoWrite call now anchors the plan structure. That anchor may finish its own streaming roster, but later calls merge only matched task statuses into the fixed titles, order, length, and positional row identities. A valid empty list resets the anchor for the next plan. Status changes remount only the status visual and keep the task label stable.
- After fixed-roster acceptance passed, the user added a turn lifecycle rule: submitting the next user message immediately hides the previous progress indicator. User transcript rows now project a null progress boundary without mutating history; stale history/live overlap cannot revive a known old TodoWrite key, and the first valid TodoWrite after that boundary starts a fresh plan. A terminal null update is suppressed during the same render rather than waiting one effect frame.
- After Windows acceptance completed, an ignored local-only PowerShell launcher was added at `target\gateway-web-acceptance\start-gateway-web-acceptance.ps1` for Gateway WebUI acceptance. It builds a worktree-local Gateway exe, uses isolated data/log paths, starts Vite from this worktree on ports 50052/5173, verifies process paths and health, opens the browser, refuses occupied ports, and cleans up its owned children on normal exit or Ctrl+C.
- Web narrow-window acceptance then exposed two related first-presentation defects. A real-browser mutation trace showed one streamed `TodoWrite` alternating through valid 1-item, invalid partial, valid 4-item, invalid partial, and final 12-item argument frames, which made the pill follow `1 -> hidden -> 4 -> hidden -> 12`. Projection updates now retain whether a snapshot is a tentative arguments frame or a settled result; the sequencer keeps tentative frames hidden until a successful result arrives, or adopts a complete-arguments fallback only after 240 ms of stability. Invalid and failed frames cancel the fallback without clearing a previous valid snapshot. The collapsed pill also keeps its completed count visible below 420 px instead of leaving a trailing separator.
- Added mirrored projection and component interaction tests.

## Verification checkpoint

- GUI production build and TypeScript: passed.
- WebUI production build and TypeScript: passed.
- Explicit GUI `tsc --noEmit`: passed.
- Explicit WebUI `tsc --noEmit`: passed.
- WebUI tests: 512/512 passed.
- GUI tests: 1431/1436 passed; the same five unrelated tests fail on unmodified main (1410/1415 passed).
- Focused projection, sequencing, and interaction tests: GUI 21/21 and WebUI 18/18 passed. They cover a 12-item plan receiving a shorter five-item update, same-anchor roster completion, title preservation, reconnect restoration, explicit clear, row-scoped motion, immediate next-user-turn hiding, old live overlap suppression, and fresh-plan recovery.
- Mirror Check: passed for 122 files.
- `git diff --check`: passed.
- Full GUI/WebUI Biome lint still fails on existing main-wide formatting/lint debt and now exactly matches the clean baseline counts: GUI 428 errors / 358 warnings / 9 infos; WebUI 296 errors / 310 warnings / 10 infos. Explicit task-source checks report zero errors.
- The post-flicker-fix focused suites pass: GUI 24/24 and WebUI 21/21. Both production builds, including TypeScript, pass with the tentative/result sequencing and narrow-count changes.
- Post-fix full WebUI tests pass 515/515. Full GUI tests pass 1434/1439 with the same five baseline failures (two mention composer selection source-extraction checks, two mention refetch source-extraction checks, and the provider usage preset byte comparison).
- A fresh worktree-local Gateway executable was built and started on port 50052, then the same 400 px Playwright flow was repeated. Before the fix the observed DOM states were `old 12 -> hidden -> 1 -> hidden -> 4 -> hidden -> 12`; after the fix they are `old 12 -> hidden on user submit -> final 12`, followed only by the expected running-to-paused state transition. The collapsed pill visibly includes `0/12 已完成` at 400 px.
- Gateway launcher smoke: PowerShell parse passed; Gateway `/healthz` and Vite returned HTTP 200; the Vite HTML contained `@vite/client`; PID executable/command lines pointed to this worktree; a timed normal exit released ports 50052/5173 and removed both child processes. The launcher and its runtime directory are ignored and will not be committed.
- Gateway launcher LAN mode: `-Lan` discovers the preferred default-route IPv4, binds Gateway/Vite to all interfaces while keeping the internal Vite proxy on loopback, and prints the LAN WebUI plus desktop Agent settings. Optional elevated `-ConfigureFirewall` creates a Private-profile, LocalSubnet-only temporary rule for the two selected ports and removes it on normal exit. A live smoke on alternate ports bound Gateway/Vite externally and returned HTTP 200 from `192.168.1.2`; the Vite response contained `@vite/client`, and timed exit released every test port.
- Independent read-only review found an unnecessary Escape refocus path; it was removed and retested so Escape closes without a focus-triggered reopen risk.
- A second independent review found no deterministic first-frame, React subscription, accessibility, or result-precedence regression. The raised mixed-tool grouping concern was checked against both grouping implementations and covered by behavior tests: `TodoWrite` is always standalone, so hiding it cannot hide adjacent ordinary tools.
- Sequencer review confirmed timers, conversation-key reset, clear semantics, history hydration, and handoff coverage. Same-call-id blocks are intentionally one logical tool invocation (result replaces streaming args); distinct TodoWrite calls retain distinct ids and are sequenced. Snapshot signatures also suppress visible duplication when legacy data lacks ids.

## Resume

Manual acceptance passed in both Gateway WebUI and the freshly restarted Windows Tauri client. The user confirmed that initial plan creation no longer flickers, progress rows update in place, the next submitted turn hides the previous indicator, and the narrow Web pill retains its completed count. The user then explicitly authorized commit, push, and upstream PR creation.

## 2026-08-06 rebase verification

- Range and overlap audit: rebased the two-commit PR from merge base `849daf26` onto `upstream/main@00a2c6fc`; old/new file sets and stats are identical, both commits are `=` in `git range-diff`, and the six files also touched by newer main changes retain the main tree plus the original PR patch.
- Focused validation: Gateway `internal/session` and `test/websocket` passed; GUI task-progress/row-model tests passed 40/40; Gateway WebUI task-progress/assistant-bubble tests passed 23/23.
- Full validation: Gateway WebUI 515/515; GUI 1422/1427, with the same five failures reproduced on a fresh non-Worktree `upstream/main@00a2c6fc` snapshot at 1398/1403. The failures remain the two mention-selection source extractors, two mention-refetch source extractors, and one Rust/TypeScript preset byte comparison.
- Gateway full tests pass every package except the Windows-only agent-token file-mode assertion (`0666`, expected POSIX `0600`); the same package fails identically on the latest-main snapshot. Gateway task packages and `go vet ./...` pass.
- GUI and Gateway WebUI production builds pass. `cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests` passes after resolving `LIBCLANG_PATH` through the protected launcher's existing Python clang path, with five unrelated unused/dead-code warnings.
- Full lint remains baseline-bound on the Windows CRLF checkout: GUI current `423 errors / 358 warnings / 9 infos` versus the previously recorded same-main baseline `424 / 358 / 9`; WebUI current and baseline are both `292 / 310 / 10`. Focused production-file lint exits zero on both clients (warnings only in existing adapter code).
- Mirror Check passes for 118 files and `git diff --check upstream/main..HEAD` passes.
- Same-HEAD Tauri acceptance ran from `chore-pr-345-rebase@8a0663e4`: Vite returned HTTP 200 and the current-workspace `target/debug/liveagent.exe` window remained responsive.
- The user explicitly confirmed `PR #345 通过` on 2026-08-06 after the rebase acceptance matrix covering the 12-item no-flicker flow, hover/focus/touch/Escape and narrow-window behavior, next-turn clearing, stop/continue recovery, and conversation/history restoration. This authorizes the guarded amend and exact force-with-lease update of the PR branch.
