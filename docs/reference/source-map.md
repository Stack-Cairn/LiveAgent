# 源码索引

## 根目录

| 路径 | 说明 |
|---|---|
| `README.md` | 项目根说明。 |
| `Makefile` | 桌面、Gateway、WebUI、proto、release 常用命令。 |
| `Cargo.toml` | Rust workspace。 |
| `docs/` | 当前架构、功能、设计、运维文档与历史 worklog。 |

## 共享应用 UI

| 功能 | 路径 |
|---|---|
| 包清单 | `crates/agent-ui/package.json` |
| 应用视图 | `crates/agent-ui/src/application/ApplicationView.tsx` |
| Settings 页面 | `crates/agent-ui/src/pages/settings/SettingsPage.tsx` |
| Skills Hub | `crates/agent-ui/src/pages/skills-hub/SkillsHubPage.tsx` |
| MCP Hub | `crates/agent-ui/src/pages/mcp-hub/McpHubPage.tsx` |
| 输入栏/顶部栏 | `crates/agent-ui/src/pages/chat/ChatComposerBar.tsx`、`crates/agent-ui/src/components/chat/ChatHeader.tsx` |
| 历史侧边栏 | `crates/agent-ui/src/components/chat/ChatHistorySidebar.tsx` |
| Hub 公共外壳 | `crates/agent-ui/src/components/hub/HubChrome.tsx` |
| 项目工具 | `crates/agent-ui/src/components/project-tools/*` |
| 宿主契约 | `crates/agent-ui/src/contracts/*` |

## GUI Frontend

| 功能 | 路径 |
|---|---|
| App shell | `crates/agent-gui/src/App.tsx` |
| React entry | `crates/agent-gui/src/main.tsx` |
| Chat page | `crates/agent-gui/src/pages/ChatPage.tsx` |
| Chat turn | `crates/agent-gui/src/pages/chat/turns/runTextConversationTurn.ts`、`runAgentConversationTurn.ts` |
| Chat transcript controller | `crates/agent-gui/src/pages/chat/transcript/ChatTranscript.tsx`、`components/AssistantBubble.tsx` |
| Gateway bridge hooks | `crates/agent-gui/src/pages/chat/gateway/useGatewayBridgeListeners.ts`、`useGatewayBridgeReadiness.ts` |
| Context builders | `crates/agent-gui/src/pages/chat/runtime/conversationContextBuilders.ts` |
| GUI Settings 扩展 | `crates/agent-gui/src/pages/settings/*` |
| 备份与同步设置分区 | `crates/agent-gui/src/pages/settings/BackupSyncSection.tsx` |
| 共享 UI 适配器 | `crates/agent-gui/src/agent-ui-adapters/*` |
| i18n | `crates/agent-gui/src/i18n/*` |

## GUI Libraries

| 功能 | 路径 |
|---|---|
| Model provider layer | `crates/agent-gui/src/lib/providers/llm.ts` |
| Provider proxy helpers | `crates/agent-ui/src/lib/providers/proxy.ts` |
| Settings defaults/storage/sync | `crates/agent-gui/src/lib/settings/*` |
| 配置备份/同步 IPC | `crates/agent-gui/src/lib/backup/index.ts` |
| Builtin tool registry | `crates/agent-gui/src/lib/tools/builtinRegistry.ts` |
| FS tools | `crates/agent-gui/src/lib/tools/fsTools.ts` |
| 项目附加目录策略 | `crates/agent-gui/src/lib/tools/fsTools.ts`、`src/lib/tools/pathUtils.ts` |
| 项目附加目录授权 | `crates/agent-gui/src/lib/workspaceRootGrants.ts`、`src-tauri/src/commands/workspace/root_grants.rs` |
| Shell tools | `crates/agent-gui/src/lib/tools/shellTools.ts` |
| MCP tools | `crates/agent-gui/src/lib/tools/mcpTools.ts`、`mcpManagerTools.ts` |
| Skills tools | `crates/agent-gui/src/lib/tools/skillTools.ts` |
| Memory tools | `crates/agent-gui/src/lib/tools/memoryTools.ts` |
| Cron tools | `crates/agent-gui/src/lib/tools/cronTools.ts` |
| Subagent tools（Agent/SendMessage） | `crates/agent-gui/src/lib/subagents/*` |
| Conversation state | `crates/agent-gui/src/lib/chat/conversation/*` |
| Memory prompt/policy | `crates/agent-gui/src/lib/chat/memory/*` |
| Skills shared logic | `crates/agent-ui/src/lib/skills/*` |
| MCP registry | `crates/agent-ui/src/lib/mcpRegistry/*` |

## Tauri Rust

| 功能 | 路径 |
|---|---|
| Tauri entry | `crates/agent-gui/src-tauri/src/main.rs` |
| App builder/invoke handler | `crates/agent-gui/src-tauri/src/lib.rs` |
| Chat history commands | `crates/agent-gui/src-tauri/src/commands/history/chat_history/*` |
| Settings commands | `crates/agent-gui/src-tauri/src/commands/config/settings/*` |
| 配置快照/本地导入导出 | `crates/agent-gui/src-tauri/src/commands/config/settings/backup_snapshot.rs`、`backup_io.rs` |
| WebDAV 同步编排 | `crates/agent-gui/src-tauri/src/commands/config/settings/webdav_sync.rs` |
| Memory commands | `crates/agent-gui/src-tauri/src/commands/integration/memory.rs` |
| MCP commands/runtime | `crates/agent-gui/src-tauri/src/commands/integration/mcp.rs` |
| File commands | `crates/agent-gui/src-tauri/src/commands/workspace/fs.rs` |
| Shell/process commands | `crates/agent-gui/src-tauri/src/commands/runtime/shell.rs`、`process.rs` |
| System commands | `crates/agent-gui/src-tauri/src/commands/app/system.rs` |
| Gateway commands | `crates/agent-gui/src-tauri/src/commands/integration/gateway.rs` |
| Subagent worktree commands | `crates/agent-gui/src-tauri/src/commands/workspace/subagent_worktree.rs` |
| Subagent store | `crates/agent-gui/src-tauri/src/commands/history/subagent_store.rs` |
| MemoryStore | `crates/agent-gui/src-tauri/src/services/memory/*` |
| Skills service | `crates/agent-gui/src-tauri/src/services/skills/*` |
| Gateway service | `crates/agent-gui/src-tauri/src/services/gateway/*`、`gateway_bridge.rs` |
| Automation service | `crates/agent-gui/src-tauri/src/services/automation/*` |
| WebDAV 传输/自动同步 | `crates/agent-gui/src-tauri/src/services/webdav.rs`、`webdav_auto_sync.rs` |
| Runtime shell/process | `crates/agent-gui/src-tauri/src/runtime/*` |

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
| 项目附加目录协议 | `WorkspaceRootGrantsRequest` 的 `list`、`apply`、`revoke` action；`internal/protocol/pbws/guard.go` 负责白名单与字段校验 |

## WebUI

| 功能 | 路径 |
|---|---|
| WebUI entry | `crates/agent-gateway/web/src/main.tsx` |
| App shell | `crates/agent-gateway/web/src/App.tsx`、`src/app/GatewayApp.tsx` |
| Gateway socket | `crates/agent-gateway/web/src/lib/gatewaySocket.ts` |
| Conversation stream client | `crates/agent-gateway/web/src/lib/chat/stream/conversationStreamClient.ts` |
| Terminal stream client | `crates/agent-gateway/web/src/lib/terminal/gatewayTerminalStreamClient.ts` |
| Gateway types | `crates/agent-gateway/web/src/lib/gatewayTypes.ts` |
| Web settings | `crates/agent-gateway/web/src/lib/webSettings.ts`、`web/src/lib/settings/*` |
| History sync/parser | `crates/agent-gateway/web/src/lib/sidebar/webSidebarBackend.ts`、`lib/chat/chatHistory.ts`、`lib/historyParser.ts` |
| Upload | `crates/agent-gateway/web/src/lib/uploadReadableFiles.ts` |
| Transcript | `crates/agent-gateway/web/src/components/GatewayTranscript.tsx` |
| Chat UI controllers | `crates/agent-gateway/web/src/pages/chat/*`、`src/components/GatewayTranscript.tsx` |
| Web Settings 扩展 | `crates/agent-gateway/web/src/pages/settings/*` |
| 共享 UI 适配器 | `crates/agent-gateway/web/src/agent-ui-adapters/*` |
| 兼容层 | `crates/agent-gateway/web/src/shims/*` |
| WebUI i18n | `crates/agent-gateway/web/src/i18n/*` |

## 资料与设计

| 路径 | 说明 |
|---|---|
| `docs/README.md` | 当前文档入口。 |
| `docs/architecture/*` | 当前总览架构文档。 |
| `docs/features/*` | 当前功能域架构文档。 |
| `docs/worklog/*` | 历史专项记录；其中路径和镜像描述按当时状态保留。 |
