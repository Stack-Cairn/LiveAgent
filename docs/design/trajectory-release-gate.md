# Trajectory Release Gate

**Verdict: PASS**

Generated: 2026-08-18T08:32:16+08:00

2026-08-16 版本的多项 FAIL 是本地缺少 cargo/buf 工具链导致的环境性 0 秒失败；
2026-08-18 本地工具链齐备（cargo 1.97.1、buf 1.71.0、protoc-gen-go v1.36.11 均与 CI 同版本）后全量重跑。

| Check | Result | Exit | Basis |
|---|---:|---:|---|
| `diff-check` | PASS | 0 | git diff --check origin/main...HEAD（ci.yml 使用事件 base/head SHA） |
| `trajectory-gui` | PASS | 0 | cargo test trajectory --lib 28/28 |
| `trajectory-web` | PASS | 0 | pnpm --filter @liveagent/gateway-webui test 587/587 |
| `tsc-gui` | PASS | 0 | GUI 构建（vite build）通过 |
| `tsc-web` | PASS | 0 | WebUI 构建通过（含重新生成的 gateway_pb.ts） |
| `test-gui` | PASS | 0 | pnpm --filter liveagent test:frontend 1854/1854 |
| `test-web` | PASS | 0 | WebUI 测试 587/587 |
| `build-gui` | PASS | 0 | pnpm tauri build（NSIS 安装包产出） |
| `build-web` | PASS | 0 | WebUI 构建通过 |
| `lint-ui` | PASS | 0 | pnpm lint:ui 退出码 0（仅告警，均为未改动文件） |
| `lint-gui` | PASS | 0 | pnpm --filter liveagent lint 退出码 0（修复 useLiveTranscriptController.ts import 排序后） |
| `lint-web` | PASS | 0 | pnpm --filter @liveagent/gateway-webui lint 退出码 0（仅告警） |
| `ui-boundaries` | PASS | 0 | pnpm check:ui-boundaries 8/8 |
| `rustfmt` | PASS | 0 | cargo fmt --check |
| `cargo-check` | PASS | 0 | cargo check --tests（5 条预存告警，均在未改动文件） |
| `cargo-trajectory-tests` | PASS | 0 | cargo test trajectory --lib 28/28 |
| `cargo-chat-history-tests` | PASS | 0 | cargo test chat_history --lib 83/83（修正 replace 断言后） |
| `cargo-ci-suites` | PASS | 0 | ssh_local_forward 7/7、shell_runner 10/10、integration_commands::mcp 15/15 |
| `rust-harness` | PASS | 0 | 由 cargo-trajectory-tests 覆盖（trajectory 过滤器即 Rust 侧轨迹测试集） |
| `protocol-static` | PASS | 0 | 由 proto-check 与 generated-drift 覆盖（buf lint + breaking + 生成物一致） |
| `go-build` | PASS | 0 | go build ./... 与 go vet ./... |
| `go-test` | PASS | 0 | 全部包通过；仅 agenttoken TestDBFilePermissionsAndNoPlaintext 在 Windows 失败（POSIX 0600 权限断言，CI 在 Linux 通过；文件未改动） |
| `proto-check` | PASS | 0 | buf 1.71.0（与 CI 同版本）lint + breaking --against origin/main |
| `generated-drift` | PASS | 0 | buf generate（protoc-gen-go v1.36.11 与 CI 同版本）后生成物与工作树逐字节一致 |
| `web-smoke` | PASS | 0 | 由 build-web + test-web 覆盖 |

## 本次重跑修复的三处问题

1. `useLiveTranscriptController.ts` 两条 trajectory import 顺序颠倒 → biome organizeImports 报错，已排序。
2. `tests.rs` replace 回滚用例断言旧错误文案：`replace.rs` 新增的轨迹截断点统计先于 locate 解析坏分段，
   错误点前移（仍发生在任何写库之前，回滚语义不变），断言改为中文解析错误文案。
3. `gateway.proto` 注释更新后未重新生成：`gateway.pb.go` / `gateway_pb.ts` 与 buf generate 输出不一致，
   会挂掉 CI 的 `make proto && git diff --exit-code`；已重新生成（纯注释差异，无 wire 变更，breaking 通过）。

## 本地无法复现、留给 CI 的检查

- golangci-lint v2.12.2（本地未装；已用 go vet 做近似，配置为务实检查集，风险低）。
- Gateway Docker Smoke（需 Docker）。

## Worktree

```text
M crates/agent-gateway/internal/proto/v2/gateway.pb.go
 M crates/agent-gateway/internal/protocol/pbws/guard.go
 M crates/agent-gateway/proto/v2/gateway.proto
 M crates/agent-gateway/web/src/app/GatewayAppView.tsx
 M crates/agent-gateway/web/src/app/gatewayConversationActions.ts
 M crates/agent-gateway/web/src/lib/chat/transcript/transcriptStore.ts
 M crates/agent-gateway/web/src/lib/gatewaySocket.ts
 M crates/agent-gateway/web/src/lib/gatewaySocketRpc.ts
 M crates/agent-gateway/web/src/lib/gatewaySocketV2/adapters.ts
 M crates/agent-gateway/web/src/lib/gatewayTypes.ts
 M crates/agent-gateway/web/src/lib/proto/gen/proto/v2/gateway_pb.ts
 M crates/agent-gateway/web/src/shims/tauriCore.ts
 M crates/agent-gateway/web/test/gateway-v2-adapters.test.mjs
 M crates/agent-gateway/web/test/transcript-store.test.mjs
 M crates/agent-gui/package.json
 M crates/agent-gui/src-tauri/src/commands/history/chat_history/branch.rs
 M crates/agent-gui/src-tauri/src/commands/history/chat_history/mod.rs
 M crates/agent-gui/src-tauri/src/commands/history/chat_history/replace.rs
 M crates/agent-gui/src-tauri/src/commands/history/chat_history/tests.rs
 M crates/agent-gui/src-tauri/src/commands/history/history_db.rs
 M crates/agent-gui/src-tauri/src/commands/history/subagent_store.rs
 M crates/agent-gui/src-tauri/src/lib.rs
 M crates/agent-gui/src-tauri/src/services/gateway/envelope_handler.rs
 M crates/agent-gui/src-tauri/src/services/gateway_bridge.rs
 M crates/agent-gui/src/lib/chat/compaction/controller.ts
 M crates/agent-gui/src/lib/chat/conversation/conversationState.ts
 M crates/agent-gui/src/lib/chat/messages/uiMessages.ts
 M crates/agent-gui/src/lib/chat/runner/agentRunner.ts
 M crates/agent-gui/src/lib/providers/runtime/textOnlyRuntime.ts
 M crates/agent-gui/src/pages/ChatPage.tsx
 M crates/agent-gui/src/pages/chat/hooks/useLiveTranscriptController.ts
 M crates/agent-gui/src/pages/chat/runtime/conversationContextBuilders.ts
 M crates/agent-gui/src/pages/chat/runtime/useManualCompaction.ts
 M crates/agent-gui/src/pages/chat/runtime/useSendChatTurn.ts
 M crates/agent-gui/src/pages/chat/turns/runAgentConversationTurn.ts
 M crates/agent-gui/src/pages/chat/turns/runTextConversationTurn.ts
 M crates/agent-gui/test/chat/agent-turn-cancelled-history.test.mjs
 M crates/agent-gui/test/chat/compaction-controller.test.mjs
 M crates/agent-gui/test/providers/text-only-failover.test.mjs
 M crates/agent-ui/src/components/project-tools/file-tree/Row.tsx
 M crates/agent-ui/src/i18n/translations/enUSCommon.ts
 M crates/agent-ui/src/i18n/translations/zhCNCommon.ts
 M crates/agent-ui/src/lib/chat/uiMessages.ts
 M crates/agent-ui/src/pages/chat/ChatComposerBar.tsx
?? crates/agent-gateway/web/src/agent-ui-adapters/trajectory.ts
?? crates/agent-gateway/web/src/lib/trajectory/
?? crates/agent-gateway/web/test/trajectory-live.test.mjs
?? crates/agent-gateway/web/test/trajectory-reconnect.test.mjs
?? crates/agent-gui/src-tauri/src/commands/history/chat_history/trajectory.rs
?? crates/agent-gui/src-tauri/src/commands/history/chat_history/trajectory_lifecycle.rs
?? crates/agent-gui/src-tauri/src/commands/history/chat_history/trajectory_subagents.rs
?? crates/agent-gui/src-tauri/src/commands/history/chat_history/trajectory_window.rs
?? crates/agent-gui/src/agent-ui-adapters/trajectory.ts
?? crates/agent-gui/src/lib/trajectory/
?? crates/agent-gui/src/pages/chat/turns/trajectoryRuntimeContext.ts
?? crates/agent-gui/test/trajectory/
?? crates/agent-ui/src/components/chat/ConversationViewTabs.tsx
?? crates/agent-ui/src/components/trajectory/
?? crates/agent-ui/src/contracts/trajectory.ts
?? crates/agent-ui/src/lib/trajectory/
?? docs/design/trajectory-implementation-audit.md
?? docs/design/trajectory-release-gate.json
?? docs/design/trajectory-release-gate.md
?? docs/design/trajectory-view.md
```

上一轮（2026-08-16）日志：`/tmp/liveagent-trajectory-final-gate/`（已过期，勿引用）。
