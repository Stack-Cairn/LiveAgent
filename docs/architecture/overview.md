# LiveAgent 总体架构

## 系统分层

| 层级 | 主要路径 | 技术栈 | 核心职责 |
|---|---|---|---|
| 桌面 GUI | `crates/agent-gui/src` | React、TypeScript、Vite、Tailwind | Chat shell、Settings、Skills Hub、MCP Hub、Memory UI、历史侧边栏、上传与流式渲染。 |
| 桌面后端 | `crates/agent-gui/src-tauri/src` | Tauri 2、Rust、SQLite、tokio | 系统命令、文件/Shell/进程、MCP runtime、MemoryStore、CronManager、GatewayController、代理服务。 |
| Agent 运行时 | `crates/agent-gui/src/lib/chat`、`crates/agent-gui/src/pages/chat`、`crates/agent-gui/src/lib/tools` | TypeScript、`@mariozechner/pi-ai` | 构造上下文、请求模型、执行工具、压缩上下文、持久化历史、发布 Gateway 事件。 |
| Gateway | `crates/agent-gateway` | Go、gRPC、net/http、WebSocket | 桌面 Agent 与浏览器 WebUI 的远程中继、认证、会话管理、恢复缓冲、静态 WebUI 和分享页。 |
| WebUI | `crates/agent-gateway/web` | React、TypeScript、Vite、WebSocket、SharedWorker | 远程浏览器端 Chat/Settings/Hub 壳层，通过 Gateway 操作本地 Agent。 |
| 资料与策略 | `doc/`、`docs/` | Markdown、SQL | 历史设计、专项计划、当前架构索引。 |

## 进程边界

| 进程/运行环境 | 入口 | 和谁通信 | 权限边界 |
|---|---|---|---|
| Tauri WebView | `crates/agent-gui/src/main.tsx`、`src/App.tsx` | Tauri invoke、Gateway gRPC bridge、模型 API | 用户可见桌面界面，触发本地能力但不直接访问 Rust 内部状态。 |
| Tauri Rust 进程 | `src-tauri/src/main.rs`、`src-tauri/src/lib.rs` | 前端 invoke、SQLite、OS、Gateway gRPC、MCP server | 本地高权限真相源，负责系统能力、持久化与远程桥接。 |
| Gateway Go 进程 | `crates/agent-gateway/cmd/gateway/main.go` | Desktop gRPC、Browser WebSocket/HTTP | 网络中继层，不直接执行本地工具。 |
| Browser WebUI | `crates/agent-gateway/web/src/main.tsx`、`web/src/App.tsx` | Gateway `/ws`、`/api/*` | 远程 UI，仅持有 token、脱敏设置和本地浏览器缓存。 |

## 核心数据流

| 数据流 | 步骤 | 关键路径 |
|---|---|---|
| 本地桌面对话 | GUI composer 提交消息，`ChatPage` 构造上下文，按 execution mode 进入 text 或 agent turn，模型流式返回，必要时执行 builtin tools，最后写入历史 SQLite。 | `src/pages/ChatPage.tsx`、`src/pages/chat/runTextConversationTurn.ts`、`src/pages/chat/runAgentConversationTurn.ts`、`src/lib/providers/llm.ts`、`src/lib/tools/builtinRegistry.ts` |
| WebUI 远程对话 | WebUI 发 `chat.submit`/`chat.edit_resend` command 到 Gateway，Gateway 立即 accepted 并通过 gRPC `AgentConnect` 下发 `ChatCommandRequest` 到桌面端；桌面端本地运行并持续回传 `ChatEvent`/`ChatControlEvent`，Gateway 按 seq 通过 fetch SSE 广播给 WebUI。 | `web/src/lib/gatewaySocket.ts`、`internal/server/http_chat.go`、`internal/server/chat_commands.go`、`proto/v1/gateway.proto`、`src-tauri/src/services/gateway.rs` |
| 设置同步 | GUI load/save 设置到本地 SQLite，同时发布脱敏 settings snapshot 到 Gateway；WebUI 读取/更新 settings 时走 Gateway，普通 sync 不带真实 provider API key。 | `src/lib/settings/*`、`src-tauri/src/commands/settings.rs`、`src/lib/settings/sync.ts`、`web/src/lib/settings/sync.ts` |
| 历史同步 | GUI 持久化 `chatHistory` 和 `chatHistorySegment`，操作后发布 history sync；Gateway 转发给 WebUI，WebUI 刷新列表或详情缓存。 | `src-tauri/src/commands/chat_history.rs`、`src-tauri/src/services/gateway.rs`、`web/src/lib/historySync.ts` |
| 上传文件 | GUI 直接通过 Tauri 导入工作区 uploads；WebUI 走 Gateway HTTP multipart，Gateway 将 bytes 转成 gRPC request，桌面端导入本地工作区后返回文件引用。 | `src-tauri/src/commands/system.rs`、`internal/handler/upload.go`、`web/src/lib/uploadReadableFiles.ts` |
| 记忆召回 | 每轮 Chat 可调用 Rust `MemoryStore` 生成 overview 注入 system prompt；工具层暴露 `MemoryManager` 读写；Settings Memory 展示和管理同一套 store。 | `src-tauri/src/services/memory.rs`、`src/lib/chat/memory/*`、`src/lib/tools/memoryTools.ts`、`src/pages/settings/MemoryPanel.tsx` |

## 当前主要持久化

| 数据 | 位置 | 所有者 | 说明 |
|---|---|---|---|
| 应用设置 | `~/.liveagent/config.sqlite` | Tauri Rust | provider/system/mcp/agents/hooks/cron/remote/memory settings。 |
| Chat 历史 | `~/.liveagent/chat-history.sqlite3` | Tauri Rust | 对话 header、segment、share、FTS 索引。 |
| Memory 文件 | `~/.liveagent/memory/...` | Tauri Rust | Markdown 是记忆事实源，按 global/project/daily 等目录组织。 |
| Memory 索引 | `~/.liveagent/memory/memory-index.sqlite3` | Tauri Rust | `memory_meta`、`memory_fts`、`memory_fts_tri`、audit log。 |
| Skills root | `~/.liveagent/skills` | Tauri Rust + GUI | 用户可安装/创建/打包的 Skills runtime root。 |
| Gateway Chat Event Store | `LIVEAGENT_GATEWAY_CHAT_EVENT_STORE` 或用户配置目录 `LiveAgent/gateway-chat.sqlite3` | Go Gateway | `chat_runs`、`chat_command_dedup`、`chat_events`；支持 Chat Command 幂等和 SSE replay。 |
| WebUI 本地缓存 | Browser localStorage | WebUI | token、脱敏 settings snapshot、UI 偏好与运行态辅助缓存。 |

## 设计原则

| 原则 | 在当前代码中的体现 |
|---|---|
| 桌面端是真相源 | 工具执行、历史、设置、记忆、Cron prompt、MCP runtime 都在 Tauri/GUI 侧落地。 |
| Gateway 不越权 | Gateway 不直接访问用户文件系统，不保存真实 provider key；只维护会话、中继和 Chat 事件日志。 |
| GUI/WebUI 可用性对齐 | WebUI 复制/镜像了大量 GUI 组件与 settings 子树，但用 shims 和 Gateway client 替换 Tauri API。 |
| 长对话可恢复 | 历史使用 segment + summary checkpoint，Gateway chat run 使用 SQLite seq event log，WebUI 可通过 SSE `after_seq`/`Last-Event-ID` 恢复。 |
| 功能域清晰 | Chat runtime、Tools、Memory、Skills、MCP、Cron、Hooks、History 都有独立源码区域与后端命令。 |

## 高层模块图

```text
Browser WebUI
  ├─ React App / Settings / Hubs / GatewayTranscript
  ├─ GatewayWebSocketClient or SharedWorker
  └─ HTTP upload / public share
        │
        ▼
Go Gateway
  ├─ HTTP: /ws, /api/status, /api/files/import, /api/public/history-shares/{token}
  ├─ gRPC: AgentGateway.AgentConnect, Authenticate
  └─ session.Manager: agent session, streams, settings/history subscribers, SQLite chat event log
        │
        ▼
Desktop LiveAgent
  ├─ React GUI: App, ChatPage, SettingsPage, Hub pages
  ├─ Agent runtime: model streaming, tools loop, compaction, memory extraction
  └─ Tauri Rust: commands, services, SQLite, MCP, MemoryStore, Cron, Gateway bridge
```
