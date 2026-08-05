# 源码索引

## 根目录

| 路径 | 说明 |
|---|---|
| `README.md` | 项目根说明。 |
| `Makefile` | 桌面、Gateway、WebUI、proto、release 常用命令。 |
| `Cargo.toml` | Rust workspace。 |
| `doc/` | 历史专项文档。 |
| `docs/` | 当前架构总览文档。 |

## GUI Frontend

| 功能 | 路径 |
|---|---|
| App shell | `crates/frontend/src/App.tsx` |
| React entry | `crates/frontend/src/main.tsx` |
| Chat page | `crates/frontend/src/pages/ChatPage.tsx` |
| Chat turn | `crates/frontend/src/pages/chat/runTextConversationTurn.ts`、`runAgentConversationTurn.ts` |
| Chat transcript | `crates/frontend/src/pages/chat/ChatTranscript.tsx`、`AssistantBubble.tsx` |
| Composer/header | `crates/frontend/src/pages/chat/ChatComposerBar.tsx`、`ChatHeader.tsx` |
| History sidebar | `crates/frontend/src/components/chat/ChatHistorySidebar.tsx` |
| Gateway bridge hooks | `crates/frontend/src/pages/chat/useGatewayBridgeListeners.ts`、`useGatewayBridgeBatcher.ts` |
| Context builders | `crates/frontend/src/pages/chat/conversationContextBuilders.ts` |
| Settings page | `crates/frontend/src/pages/SettingsPage.tsx`、`src/pages/settings/*` |
| Skills Hub | `crates/frontend/src/pages/skills-hub/*` |
| MCP Hub | `crates/frontend/src/pages/mcp-hub/*` |
| Shared hub chrome | `crates/frontend/src/components/hub/HubChrome.tsx` |
| i18n | `crates/frontend/src/i18n/*` |

## GUI Libraries

| 功能 | 路径 |
|---|---|
| Model provider layer | `crates/frontend/src/lib/providers/llm.ts` |
| Provider proxy helpers | `crates/frontend/src/lib/providers/proxy.ts` |
| Settings defaults/storage/sync | `crates/frontend/src/lib/settings/*` |
| Builtin tool registry | `crates/frontend/src/lib/tools/builtinRegistry.ts` |
| FS tools | `crates/frontend/src/lib/tools/fsTools.ts` |
| Shell tools | `crates/frontend/src/lib/tools/shellTools.ts` |
| MCP tools | `crates/frontend/src/lib/tools/mcpTools.ts`、`mcpManagerTools.ts` |
| Skills tools | `crates/frontend/src/lib/tools/skillTools.ts` |
| Memory tools | `crates/frontend/src/lib/tools/memoryTools.ts` |
| Cron tools | `crates/frontend/src/lib/tools/cronTools.ts` |
| Subagent tools（Agent/SendMessage） | `crates/frontend/src/lib/subagents/*` |
| Conversation state | `crates/frontend/src/lib/chat/conversation/*` |
| Memory prompt/policy | `crates/frontend/src/lib/chat/memory/*` |
| Skills discovery | `crates/frontend/src/lib/skills/*` |
| MCP registry | `crates/frontend/src/lib/mcpRegistry/*` |

## Tauri Rust

| 功能 | 路径 |
|---|---|
| Tauri entry | `crates/frontend/src-tauri/src/main.rs` |
| App builder/invoke handler | `crates/frontend/src-tauri/src/lib.rs` |
| Chat history commands | `crates/frontend/src-tauri/src/commands/chat_history.rs` |
| Settings commands | `crates/frontend/src-tauri/src/commands/settings.rs` |
| Memory commands | `crates/frontend/src-tauri/src/commands/memory.rs` |
| MCP commands/runtime | `crates/frontend/src-tauri/src/commands/mcp.rs` |
| File commands | `crates/frontend/src-tauri/src/commands/fs.rs` |
| Shell/process commands | `crates/frontend/src-tauri/src/commands/shell.rs`、`process.rs` |
| System commands | `crates/frontend/src-tauri/src/commands/system.rs`、`system_tools.rs` |
| Gateway commands | `crates/frontend/src-tauri/src/commands/gateway.rs` |
| Subagent worktree commands | `crates/frontend/src-tauri/src/commands/workspace/subagent_worktree.rs` |
| Subagent store | `crates/frontend/src-tauri/src/commands/history/subagent_store.rs` |
| MemoryStore | `crates/frontend/src-tauri/src/services/memory.rs` |
| Skills service | `crates/frontend/src-tauri/src/services/skills.rs` |
| Gateway service | `crates/frontend/src-tauri/src/services/gateway.rs`、`gateway_bridge.rs` |
| Cron service | `crates/frontend/src-tauri/src/services/cron.rs` |
| Runtime shell/process | `crates/frontend/src-tauri/src/runtime/*` |

## Gateway

| 功能 | 路径 |
|---|---|
| Gateway entry | `crates/agent-gateway/cmd/gateway/main.go` |
| Config | `crates/agent-gateway/internal/config/config.go` |
| v2 协议层（WebSocket+Protobuf） | `crates/agent-gateway/internal/protocol/pbws/*`（browser/agent/terminal 三链路、guard 白名单、seam 映射） |
| WS 连接运行时 | `crates/agent-gateway/internal/transport/wscore/*` |
| 协议共用域逻辑 | `crates/agent-gateway/internal/protocol/shared/*`（Origin 校验、终端门控/后处理、终端兴趣跟踪） |
| Chat 命令编排 | `crates/agent-gateway/internal/chatcmd/chatcmd.go` |
| 可观测性 | `crates/agent-gateway/internal/observability/*`（slog 初始化、v2 使用计数） |
| HTTP routes | `crates/agent-gateway/internal/server/http.go`（proto→JSON 塑形：`proto_json.go`） |
| Session manager | `crates/agent-gateway/internal/session/manager.go`、`agent_session.go`、`manager_state.go`、`manager_registry.go`、`manager_*_sync.go`、`manager_terminal.go`、`manager_chat_runs.go` |
| Auth | `crates/agent-gateway/internal/auth/*` |
| Handlers | `crates/agent-gateway/internal/handler/*` |
| Proto source | `crates/agent-gateway/proto/v2/gateway.proto`（业务消息）、`proto/v2/gateway_ws.proto`（v2 帧壳） |
| Generated proto | `crates/agent-gateway/internal/proto/v2/*` |

## WebUI

| 功能 | 路径 |
|---|---|
| WebUI entry | `crates/agent-gateway/web/src/main.tsx` |
| App shell | `crates/agent-gateway/web/src/App.tsx` |
| Gateway socket | `crates/agent-gateway/web/src/lib/gatewaySocket.ts` |
| Conversation stream client | `crates/agent-gateway/web/src/lib/chat/stream/conversationStreamClient.ts` |
| Terminal stream client | `crates/agent-gateway/web/src/lib/terminal/gatewayTerminalStreamClient.ts` |
| Gateway types | `crates/agent-gateway/web/src/lib/gatewayTypes.ts` |
| Web settings | `crates/agent-gateway/web/src/lib/webSettings.ts`、`web/src/lib/settings/*` |
| History sync/parser | `crates/agent-gateway/web/src/lib/historySync.ts`、`historyParser.ts` |
| Upload | `crates/agent-gateway/web/src/lib/uploadReadableFiles.ts` |
| Transcript | `crates/agent-gateway/web/src/components/GatewayTranscript.tsx` |
| Chat UI | `crates/agent-gateway/web/src/pages/chat/*` |
| Settings | `crates/agent-gateway/web/src/pages/SettingsPage.tsx`、`web/src/pages/settings/*` |
| Skills Hub | `crates/agent-gateway/web/src/pages/skills-hub/*` |
| MCP Hub | `crates/agent-gateway/web/src/pages/mcp-hub/*` |
| Tauri shims | `crates/agent-gateway/web/src/shims/*` |
| WebUI i18n | `crates/agent-gateway/web/src/i18n/*` |

## 资料与设计

| 路径 | 说明 |
|---|---|
| `doc/README.md` | 旧文档入口。 |
| `doc/webui-gateway-spec.md` | WebUI/Gateway 协议专项资料。 |
| `doc/memory/README.md` | Memory 设计资料入口。 |
| `doc/memory/schema.sql` | Memory SQLite index schema 参考。 |
| `docs/architecture/*` | 当前总览架构文档。 |
| `docs/features/*` | 当前功能域架构文档。 |
