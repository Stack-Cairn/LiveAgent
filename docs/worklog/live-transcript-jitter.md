# Live transcript activity stability

## Goal

Keep the active assistant turn structurally stable while thinking, tools, tool results, and status updates stream into the desktop GUI and Gateway WebUI. Existing activity must update in place, bottom following must have one owner, and detached readers must keep their viewport anchor.

## Baseline and isolation

- Original development baseline: `upstream/main` at `849daf269762846557cc8243c5fe6e7fb155ed72`.
- Original development branch and Worktree: `codex/fix-live-transcript-jitter` in `target\codex-live-transcript-jitter-worktree`; the older `target\codex-transcript-order-scroll-jitter-worktree` was not reused or modified.
- A post-acceptance fetch on 2026-08-01 advanced `upstream/main` to `7de95a20bf93cfe026a57f6367c453e74a50acef`. The accepted branch was intentionally left unchanged at that time because the two new commits affected only PR governance.
- 2026-08-06 maintenance baseline: latest `upstream/main` at `00a2c6fc43754f40022b0703459824559bee73ea` in the current main workspace on `chore-pr-350-rebase`; no historical Worktree was entered, modified, or cleaned.
- Original PR head `babfd48d` rebased without conflicts to product HEAD `e61a2bdf`; both commits are patch-equivalent in `git range-diff`, with the same 44-file `1681 insertions / 417 deletions` scope.
- The current main workspace's protected `Cargo.toml`, `.codegraph/`, `output/`, and local-only `start-tauri-dev.bat` state remain outside this PR maintenance change.

## Confirmed causes

1. A live thinking block automatically expands its Markdown body inline. When a tool starts, `thinkingOpen` closes it and the virtual row loses that height in one commit.
2. One ordinary tool is projected as `tool`, while a second consecutive tool replaces it with a differently keyed `toolGroup`, remounting the visible activity at the same logical position.
3. Desktop live content is split into several outer virtual rows; only the mutable tail is force-mounted. The active turn therefore changes the virtual row set as blocks arrive.
4. `anchorTo: "end"` in the transcript virtualizer and `useScrollFollow` both compensate the same bottom growth. Resize measurement and bottom pin writes can land sequentially and create a visible direction reversal.
5. Gateway already keeps one outer assistant row per turn, but shares the inline thinking expansion, tool grouping transition, end anchoring, and scroll-follow competition.
6. Runtime frame sampling exposed a second height oscillator after scroll ownership was unified: the live status footer was conditionally removed between tool phases, and long `正在执行…` text wrapped to two lines before returning to one-line `Vibing...`. Each cycle changed the measured height by about 15.2px, so the browser clamped upward before the next bottom pin.
7. Desktop settlement cleared the active activity before its persisted history twin was guaranteed to exist. A one-render persistence lag therefore removed the whole live row; a second turn could also discard the first turn's unresolved stream-origin alias.

## Approved implementation direction

- Project the active desktop assistant turn as one outer live activity row with stable identity; keep its child activity keys stable through settlement.
- Keep ordinary tool activity under one stable group identity from the first tool onward. A single tool may retain its direct visual treatment inside that stable wrapper.
- Render full thinking details in a fixed/absolute overlay. Opening, closing, and automatic running-state changes must not change transcript height.
- Make `useScrollFollow` the only writer for live bottom growth. The virtualizer may still measure and compensate detached/history readers, but must not perform end-anchor writes while following.
- Preserve Gateway-specific store architecture while applying the same activity and scroll invariants.

## Implemented model and rendering decisions

- Desktop live and stream-origin-settled replies now use one `assistantActivity` virtual row keyed by `${replyKey}:activity`. Child unit keys survive tool arrival, result updates, and settlement.
- Consecutive ordinary tools use a stable group keyed by the first tool from the first item onward. The singleton group keeps the existing single-tool visual treatment, avoiding a visible design change while preventing the one-to-many remount.
- `ThinkingActivity` is a props-only mirrored component. The compact row remains in flow; details render through a fixed portal and close on Escape, outside pointer, or focus departure. Placement is clamped for ordinary narrow windows and remains non-zero even for an extremely narrow synthetic viewport.
- Streaming growth is coalesced by `framePinController`, so repeated ResizeObserver notifications schedule at most one bottom write per animation frame. While following, virtualizer resize compensation is disabled and `anchorTo` is `start`; while detached, the existing virtualizer compensation path and `anchorTo: end` preserve history/prepend anchoring.
- Gateway keeps its existing one-row-per-turn store shape, but receives the same stable tool grouping, thinking overlay, frame pinning, and following/detached anchoring policy.
- Both clients keep one compact status tail from the start of streaming. Status text is single-line and truncated, so tool summaries cannot change the footer height. Desktop reuses the same `${replyKey}:footer` key when the settled footer takes over.
- Desktop retains cached activity units while persistence catches up. The same visible Vibing status and footer key remain until the persisted twin takes over, delayed history twins recover their original stream identity, and unresolved aliases survive a newer live turn until hydration can match them.
- Final visual feedback removed Streamdown's trailing live-text caret in both clients. The caret could render as a standalone white bar and reserve an otherwise empty line between a completed text block and the next tool; activity progress is already communicated by the stable status tail, so the duplicate cue is no longer emitted.
- Status width is now bounded through the complete flex chain: the desktop activity row occupies the transcript width, status wrappers allow shrinking and clip overflow, and the status text itself owns the ellipsis. WebUI applies the same footer constraint, so long tool summaries cannot widen either transcript.

## Task tool compatibility

Task tools remain standalone render units, so hiding `TaskCreate`、`TaskUpdate`、`TaskList` cannot hide adjacent ordinary tools or alter their activity identity.

## Verification status

- Git/worktree gate: passed.
- Architecture and prior task-progress worklog review: complete.
- Parallel read-only GUI, WebUI, scroll, test/mirror, and compatibility exploration: complete.
- GUI build/typecheck: passed.
- Gateway WebUI build/typecheck: passed.
- GUI full frontend tests after all additions: 1,423/1,428 passed. The five failures exactly match the unmodified `849daf26` baseline (four mention source-extraction failures and one provider-preset byte-sync failure); baseline had 1,410/1,415 passed with the same five failures.
- Gateway WebUI full tests after all additions: 504/504 passed.
- Focused activity/identity/scroll tests: passed, including 100 appended tools, stable live-to-settled keys, interleaved reasoning/tool/result order, and one-frame pin coalescing.
- Mirrored live-caret regression tests assert that neither GUI nor WebUI round content requests a Markdown caret; both focused tests and both builds pass.
- GUI/WebUI status-width regression tests assert the non-expanding container chain and full-width truncation target; focused tests, touched-file lint, both builds, Mirror Check, and diff hygiene pass.
- Coverage audit follow-up: mirrored special-tool identity tests now cover `TaskCreate`、`TaskUpdate`、`TaskList`、`AskUserQuestion`、`Image`、`Agent`, and hosted-search singleton-to-group stability. Gateway row tests explicitly apply result B before result A, repeat result B, and assert the original A/B order, result ownership, error status, and outer assistant key remain stable.
- GUI lint: 419 errors / 358 warnings / 9 infos versus baseline 428 / 358 / 9. A final targeted Biome check of all 14 touched GUI source files exited successfully with three existing warnings and no errors.
- Gateway WebUI lint: 289 errors / 310 warnings / 10 infos versus baseline 296 / 310 / 10. A final targeted Biome check of all 11 touched WebUI source files exited successfully with 22 existing warnings and no errors.
- Mirror Check: 122/122 passed.
- `git diff --check`: passed; line-ending notices are working-tree conversion warnings, not whitespace errors.
- Independent read-only review: no P0/P1 finding. The final review identified delayed-twin alias loss and settling-status lifecycle as P2 risks. Alias retention is covered by the new-turn hydration test; the settling status intentionally remains visible until the persisted twin atomically takes over, matching the accepted GUI/WebUI behavior.
- Same-worktree Gateway WebUI runtime acceptance: frame-level bottom-follow and detached-reader probes passed after the status-height fix.
- Same-worktree Tauri and Gateway WebUI manual acceptance: passed by the user on 2026-08-01, including the follow-up removal of the stray Markdown caret, preservation of the visible Vibing status, and truncation of overlong status text without transcript-width growth.

## Runtime provenance and preliminary browser checks

- An older Tauri instance from `target\codex-transcript-order-scroll-jitter-worktree` owned port 1420. Only its verified running process tree was stopped; the old worktree was not modified or cleaned.
- Tauri was launched from this task worktree with `pnpm --dir crates/agent-gui tauri dev`; `LIBCLANG_PATH` was resolved from the local Python clang runtime without changing repository configuration.
- Task Vite's command line was rooted at this task worktree and listened on `127.0.0.1:1420`.
- The desktop binary resolved to this worktree's `target\debug\liveagent.exe`, was rebuilt for the acceptance run, and Windows reported the `LiveAgent` window responsive. Source HEAD remained `849daf269762846557cc8243c5fe6e7fb155ed72` plus the uncommitted task diff.
- Gateway was started from this task source with `go run ./cmd/gateway`, listening at `127.0.0.1:18080` with an isolated temporary agent database; no credential value is recorded in this worklog.
- WebUI Vite was rooted in this task worktree. Because the package script forwarded an extra literal `--`, Vite ignored the requested 15173 value; with an older unrelated server already on 5173, this verified task server selected `http://127.0.0.1:5174`. Its root returned HTTP 200 and the expected title.
- A headed Playwright browser authenticated against the task Gateway, and the desktop agent connected to that independent Gateway. The real acceptance conversation executed tools from the task worktree and reported the required branch and baseline HEAD.
- Gateway WebUI acceptance preview: `docs/images/live-transcript-stability-webui.png` captures the completed sequential run in the verified task client.
- At 390x844, document and body widths remain 390px with no horizontal overflow. Sidebar overlay interception followed the normal close-sidebar path. Dark mode applied (`html.dark`, `color-scheme: dark`) and emulated `prefers-reduced-motion: reduce` matched true. Screenshot: `output/playwright/webui-narrow-dark-reduced.png` (acceptance artifact only, not a task source file).
- The first 12-step live run kept two outer transcript rows (one user and one assistant activity) while more than 24 internal activity buttons accumulated, proving that live growth stayed inside one assistant row.
- Diagnostic sampling before the final status fix recorded 57 explicit scroll writes, all owned by `useScrollFollow`, and repeated `+15.2px/-15.2px` pairs. This ruled out a second JavaScript writer and identified conditional/wrapping status height as the remaining oscillator.
- After the stable single-line status fix, a new real six-tool run sampled 8,820 frames. All 20 explicit writes came from `useScrollFollow`; the repeated negative 15.2px deltas disappeared. After the initial pending-to-assistant measurement (`+236px`, then one `-4px` estimate correction), every live tool increment was non-negative and the final bottom gap was 0px.
- A trusted wheel gesture detached the same page by about 700px during a later live run. Across 7,396 animation-frame samples, the selected visible row had 0px maximum/final top drift, 0 removals, 0 reinsertions, and the bottom gap grew from about 700px to 1,361.6px. Live output therefore did not steal the detached reader's position.
- Browser frame probes are prepared under `output/playwright/`: bottom-follow and detached variants sample every animation frame and track the exact row node with a `MutationObserver`; the stop probe reports sample count, node removals/reinsertions, direction reversals, maximum anchor drift, and final bottom gap. These are acceptance artifacts only and will not be staged.
- Tauri, GUI Vite, Gateway, and WebUI Vite all remained rooted in the task worktree throughout the probes. No commit, push, or PR update had occurred before manual acceptance.

## Manual acceptance matrix

All prompts below are read-only unless the row explicitly asks the user to press Stop or toggle the Remote connection. Run the observable rows once in the same-worktree Tauri window and once in the task WebUI. The automated-only rows are covered by the commands/results above and are not represented as manual UI checks.

| Scenario | Client | Trigger and steps | Expected result |
| --- | --- | --- | --- |
| Thinking → tool → thinking | GUI + WebUI | Send the sequential twelve-step prompt below. Keep the transcript at the bottom for steps 1–4. | Existing thinking/tool rows never exchange positions; each tool updates in place; no up/down direction reversal. |
| Twelve tools, long activity list | GUI + WebUI | Let the complete sequential prompt finish. Expand and scroll the activity region while later steps arrive. | First tool keeps the same DOM identity; new items append; no prior item remounts; scroll remains usable through all twelve steps. |
| Detached reader | GUI + WebUI | During steps 5–8, scroll the transcript upward until the “back to bottom” affordance appears and keep the pointer still. | The visible anchor top stays within about 1px; new activity does not steal the viewport. |
| Return to bottom | GUI + WebUI | Activate the return-to-bottom affordance once, then leave the viewport untouched. | It returns once and subsequent growth stays bottom-pinned with at most one final correction per frame. |
| Thinking details overlay | GUI + WebUI | Activate a compact “Thinking process” row by mouse, keyboard Enter/Space, and touch emulation; then close using Escape, outside click, and focus departure. | A fixed dialog appears without changing transcript/composer height; trigger focus returns on Escape; reduced motion has no height animation. |
| Parallel and out-of-order tools | GUI + WebUI | Send the parallel-subagent prompt below. | Items remain in first-seen order even when the shorter subagent completes first; results update their original items. |
| Tool failure and recovery | GUI + WebUI | Send the failure prompt below. | The failed tool changes to failed in place, later successful tool appends after it, and the activity container remains stable. |
| Stop/cancel | GUI + WebUI | Send the stop prompt; after the long-running tool begins, press Stop once. | Running item becomes cancelled/aborted in place; no duplicate status row; turn settles once without a final jump. |
| Retry | GUI + WebUI | Use the existing retry action on the failed turn exactly once. | A new attempt is represented without reordering the settled prior turn; repeated click is not duplicated. |
| AskUserQuestion | GUI + WebUI | Send the question prompt; wait five seconds, select “继续”, submit once. | Pending card and surrounding activities do not move; answering resumes the same turn; duplicate submission is blocked. |
| Task tool compatibility | GUI + WebUI | The twelve-step prompt creates tasks once and updates each by stable ID. | Hidden task tools never split adjacent ordinary tools or change their identity; the progress snapshot retains stable task IDs. |
| Image | GUI + WebUI | Attach a small image and ask the agent to inspect its dimensions/read visible text, without editing files. | Image tool/activity stays at its original position as result arrives; preview/details still open. |
| Hosted search | GUI + WebUI | Ask: “使用 hosted search 查找 LiveAgent 仓库主页，只返回标题和 URL。” | Search row updates in place and does not regroup neighboring shell/file tools. |
| Subagent | GUI + WebUI | Use the parallel-subagent prompt. | Both subagent activities keep stable identity, progress/result details remain accessible. |
| Narrow/light/dark/reduced motion | WebUI + GUI | Repeat overlay and live-list checks at ~390px, light and dark theme, with reduced motion enabled. | No horizontal overflow; overlay is clamped; no layout-height animation. |
| Conversation switch/history restore | GUI + WebUI | While idle, switch to another conversation and back; reload WebUI once. | Restored settled order equals the live order and no duplicate/remounted activity appears. |
| Gateway reconnect | WebUI | During a long step, disable Remote Access in Tauri for 3–5 seconds, then re-enable with unchanged settings. | Browser reports disconnect/reconnect, rehydrates the same order, and does not duplicate or move existing activities. |
| History prepend/floor navigation | GUI + WebUI | Open a long conversation, scroll upward to load older history, then use floor navigation once. | The visible keyed anchor is preserved; the one explicit navigation owns the scroll; no corrective bounce. |
| Invalid/duplicate/late events | Automated only | GUI/WebUI projection and store tests, including replay/reconnect and delayed-result fixtures. | Existing IDs and relative order remain unchanged; invalid/duplicate events are idempotent. |
| 50/100-item stress | Automated only | `transcript-row-model.test.mjs` and Web projection tests; 100 appended ordinary tools are built incrementally. | One outer activity key and the first tool key survive; no identity churn or maximum-depth/ResizeObserver error. |

### Sequential twelve-step prompt

```text
这是实时活动稳定性验收。不要修改任何文件，不要并行、合并、跳过或批量完成步骤。

1. 首先为下面 12 项工作分别调用 TaskCreate，并记录执行器返回的稳定 taskId；创建完成后用 TaskUpdate 将第 1 项设为 in_progress。
2. 每完成一项，立即用 TaskUpdate 按 taskId 将刚完成项设为 completed、下一项设为 in_progress；不要重建或重排任务。
3. 每次 TaskUpdate 后执行 Start-Sleep -Seconds 2，再执行下一项。
4. 每项必须使用一次独立工具调用，严格串行：
   1) 获取当前工作目录
   2) 获取当前 Git 分支
   3) 获取当前 HEAD SHA
   4) 查看 git status --short
   5) 获取 Node.js 版本
   6) 获取 pnpm 版本
   7) 获取 rustc 版本
   8) 获取 Cargo 版本
   9) 获取 Go 版本
   10) 检查 crates/agent-gui/package.json 是否存在
   11) 检查 crates/agent-gateway/web/package.json 是否存在
   12) 只读汇总前面结果
5. 在相邻工具之间可以简短说明当前进度，但不要修改文件，不要调用 AskUserQuestion。
```

### Parallel/out-of-order subagent prompt

```text
只读验收，不修改文件。连续启动两个独立 Agent/subagent 活动，保持首次出现顺序：第一个等待 4 秒后读取当前分支；第二个等待 1 秒后读取当前 HEAD。允许并行并让第二个先返回。两者完成后再用一个普通 shell 工具汇总结果。不得重排或重新命名已有活动。
```

### Failure/recovery prompt

```text
只读验收。先执行一个必然失败且不修改系统的命令，输出固定错误并以非零状态退出；失败后不要重试该命令，继续用新的独立工具调用执行 git rev-parse HEAD，最后说明两个结果。不要并行。
```

### Stop prompt

```text
只读验收。先说明将开始等待，然后执行一个持续 30 秒的等待命令；等待结束后才允许读取当前分支。不要后台运行，不要并行。我会在等待期间按一次 Stop。
```

### AskUserQuestion prompt

```text
只读验收。先调用 AskUserQuestion 询问“是否继续稳定性验收？”，只提供“继续”和“取消”两个选项。在我回答前不要调用其他工具；选择继续后读取当前 HEAD 并结束。
```

## Frame-level evidence protocol

- Browser probe chooses the transcript `[data-scroll-viewport]`, captures the currently stable assistant row node and its `getBoundingClientRect().top`, and samples it with `scrollTop` on every animation frame.
- A `MutationObserver` records whether that exact node is removed/reinserted while later tool rows arrive.
- Bottom-follow acceptance: final bottom gap ≤1px, no repeated sign reversal among meaningful (>0.5px) live-tool deltas, and no more than one final pin per sampled frame. A one-time initial estimate correction is recorded separately from steady-state live growth.
- Detached acceptance: select a visible historical row as anchor after the user scrolls up; maximum absolute top drift target ≤1px while new activity and ResizeObserver measurements land.
- Record sample count, maximum anchor drift, direction reversals, node removal count, and final bottom gap for both desktop-observable and WebUI runs. WebUI is sampled directly through Playwright; desktop uses the same visual scenario plus source/process provenance because the Tauri WebView is not exposed as a Playwright page.

## Resume

The original 2026-08-01 manual acceptance is complete. The 2026-08-06 maintenance run must obtain fresh acceptance from the current main workspace and rebased product HEAD before amending this worklog or updating the remote PR branch.

## 2026-08-06 rebase verification

- Range audit: rebased both commits from merge base `849daf26` onto `upstream/main@00a2c6fc`; each commit is `=` in `git range-diff`, old/new file sets remain the same 44 files, and both ranges remain `1681 insertions / 417 deletions`.
- Latest-main overlap audit: only `GatewayApp.tsx` and `scripts/mirror-manifest.json` overlap changes made between the old and new baselines. The main-side CLI identity removal and overlay-host placement remain intact together with the PR's viewport-following prop and new mirror entries.
- Pairwise audit: PR #350 overlaps PR #345 in 6 files and the live PR #366 head in 12 files; neither PR is an ancestor or descendant of #350, so all three remain independent roots.
- Focused validation: GUI activity/identity/scroll/overlay suites pass 46/46; Gateway WebUI equivalents pass 47/47, including stable ordinary-tool identity, 100-item pressure, out-of-order/duplicate results, frame-pin coalescing, following/detached resize policy, overlay placement, status width, and stream-caret removal.
- Full validation: Gateway WebUI passes 504/504. GUI passes 1411/1416; the same two mention-selection extractors, two mention-refetch extractors, and one Rust/TypeScript preset-sync test fail on the previously captured fresh non-Worktree `upstream/main@00a2c6fc` baseline at 1398/1403.
- GUI and Gateway WebUI production builds pass. Full lint equals the same-main baseline exactly: GUI `424 errors / 358 warnings / 9 infos`, WebUI `292 / 310 / 10`. Focused lint exits zero for all 14 GUI and 11 WebUI production files, with warnings only.
- Gateway full tests pass every package except the Windows-only agent-token file-mode assertion (`0666`, expected POSIX `0600`), reproduced identically on latest main; `go vet ./...` passes.
- `cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests` passes using the existing local Python clang runtime, with five unchanged unused/dead-code warnings.
- Mirror Check passes for 118 files and `git diff --check upstream/main..HEAD` passes. Independent Git and GUI/WebUI semantic reviews found no P0/P1/P2 blocker; the details overlay remains intentionally user-activated while `thinkingOpen` drives only the compact running state, matching Issue #349 and the original acceptance matrix.
- Fresh same-HEAD Tauri acceptance ran from `chore-pr-350-rebase@e61a2bdf`: Vite returned HTTP 200 and the current-workspace `target/debug/liveagent.exe` window remained responsive.
- The user explicitly confirmed `PR #350 通过` on 2026-08-06 after the rebase acceptance matrix covering stable streaming identity/order, bottom-follow and detached-reader anchoring, thinking overlay interactions, parallel/out-of-order tools, failure/retry, Stop/cancel, AskUserQuestion, history/reconnect restoration, narrow layout, themes, and reduced motion. This authorizes the guarded amend and exact force-with-lease update of the PR branch.
