# LiveAgent 总体架构

## 系统分层

| 层级 | 主要路径 | 技术栈 | 核心职责 |
|---|---|---|---|
| 共享应用 UI | `crates/agent-ui/src` | React、TypeScript、Tailwind | GUI/WebUI 共用的 Settings、Skills Hub、MCP Hub、聊天侧边栏、输入栏、项目工具和领域逻辑。 |
| 桌面 GUI | `crates/agent-gui/src` | React、TypeScript、Vite、Tailwind | 桌面启动入口、Chat 数据控制器、Tauri 能力适配器、上传与流式运行态。 |
| 桌面后端 | `crates/agent-gui/src-tauri/src` | Tauri 2、Rust、SQLite、tokio | 系统命令、文件/Shell/进程、MCP runtime、MemoryStore、CronManager、GatewayController、代理服务。 |
| Agent 运行时 | `crates/agent-gui/src/lib/chat`、`crates/agent-gui/src/pages/chat`、`crates/agent-gui/src/lib/tools` | TypeScript、`@earendil-works/pi-ai` | 构造上下文、请求模型、执行工具、压缩上下文、持久化历史、发布 Gateway 事件。 |
| Gateway | `crates/agent-gateway` | Go、net/http、WebSocket+Protobuf（v2） | 桌面 Agent 与浏览器 WebUI 的远程中继、认证、会话管理、恢复缓冲、静态 WebUI 和分享页。 |
| WebUI | `crates/agent-gateway/web` | React、TypeScript、Vite、WebSocket | 浏览器启动入口、Gateway 数据控制器和远程能力适配器，通过 Gateway 操作本地 Agent。 |
| 资料与策略 | `docs/` | Markdown | 当前架构、功能说明、设计规格与历史 worklog。 |

## 进程边界

| 进程/运行环境 | 入口 | 和谁通信 | 权限边界 |
|---|---|---|---|
| Tauri WebView | `crates/agent-gui/src/main.tsx`、`src/App.tsx` | Tauri invoke、Gateway bridge、模型 API | 用户可见桌面界面，触发本地能力但不直接访问 Rust 内部状态。 |
| Tauri Rust 进程 | `src-tauri/src/main.rs`、`src-tauri/src/lib.rs` | 前端 invoke、SQLite、OS、Gateway WebSocket v2、MCP server | 本地高权限真相源，负责系统能力、持久化与远程桥接。 |
| Gateway Go 进程 | `crates/agent-gateway/cmd/gateway/main.go` | Desktop/Browser WebSocket v2（Protobuf 帧）、HTTP | 网络中继层，不直接执行本地工具。 |
| Browser WebUI | `crates/agent-gateway/web/src/main.tsx`、`web/src/App.tsx`、`web/src/app/GatewayApp.tsx` | Gateway `/ws/v2`、`/api/*` | 远程 UI，仅持有 token、脱敏设置和本地浏览器缓存。 |

## 核心数据流

| 数据流 | 步骤 | 关键路径 |
|---|---|---|
| 本地桌面对话 | 共享 composer 提交消息，GUI `ChatPage` 构造上下文，按 execution mode 进入 text 或 agent turn，模型流式返回，必要时执行 builtin tools，最后写入历史 SQLite。 | `crates/agent-ui/src/pages/chat/ChatComposerBar.tsx`、`src/pages/ChatPage.tsx`、`src/pages/chat/turns/*`、`src/lib/providers/llm.ts`、`src/lib/tools/builtinRegistry.ts` |
| WebUI 远程对话 | WebUI optimistic echo 后先经 `/ws/v2` 发 `chat_prepare`，Gateway 通过关联原生 Ping/Pong 验证桌面端信封流并唤醒桌面 Chat Runtime；随后 `chat_command`（`chat.submit`/`chat.edit_resend`）accepted 并经 `/ws/v2/agent` 信封流下发。桌面端本地运行并持续回传 `ChatEvent`/`ChatControlEvent`，Gateway 按 seq 经会话订阅（`chat.subscribe`/`chat.event`）推送给 WebUI。 | `web/src/lib/gatewaySocket.ts`、`internal/protocol/pbws/browser_local.go`、`internal/chatcmd/chatcmd.go`、`proto/v2/gateway.proto`、`src-tauri/src/services/gateway/*` |
| 设置同步 | GUI load/save 设置到本地 SQLite，同时发布脱敏 settings snapshot 到 Gateway；WebUI 读取/更新 settings 时走 Gateway，普通 sync 不带真实 provider API key。 | `src/lib/settings/*`、`src-tauri/src/commands/config/settings/*`、`crates/agent-ui/src/lib/settings/sync.ts`、`web/src/lib/settings/*` |
| 历史同步 | GUI 持久化 `chatHistory` 和 `chatHistorySegment`，操作后发布 history sync；Gateway 转发给 WebUI，WebUI 刷新列表或详情缓存。 | `src-tauri/src/commands/history/chat_history/*`、`src-tauri/src/services/gateway/*`、`web/src/lib/sidebar/webSidebarBackend.ts`、`web/src/lib/historyParser.ts` |
| 上传文件 | GUI 直接通过 Tauri 导入；WebUI 走 Gateway HTTP multipart，Gateway 将 bytes 转成 `UploadReadableFilesRequest` 信封。桌面端统一把文件写入 `~/.liveagent/uploads` 暂存区（工作区外）后返回文件引用。 | `src-tauri/src/commands/app/system.rs`、`internal/handler/upload.go`、`web/src/lib/uploadReadableFiles.ts` |
| 记忆召回 | 每轮 Chat 可调用 Rust `MemoryStore` 生成 overview 注入 system prompt；工具层暴露 `MemoryManager` 读写；共享 Settings Memory 展示和管理同一套 store。 | `src-tauri/src/services/memory/*`、`src/lib/chat/memory/*`、`src/lib/tools/memoryTools.ts`、`crates/agent-ui/src/pages/settings/memory/*` |

## 当前主要持久化

| 数据 | 位置 | 所有者 | 说明 |
|---|---|---|---|
| 应用设置 | `~/.liveagent/config.sqlite` | Tauri Rust | provider/system/mcp/agents/hooks/cron/remote/memory settings。 |
| Chat 历史 | `~/.liveagent/chat-history.sqlite3` | Tauri Rust | 对话 header、segment、share、FTS 索引。 |
| Memory 文件 | `~/.liveagent/memory/...` | Tauri Rust | Markdown 是记忆事实源，按 global/project/daily 等目录组织。 |
| Memory 索引 | `~/.liveagent/memory/memory-index.sqlite3` | Tauri Rust | `memory_meta`、`memory_fts`、`memory_fts_tri`、audit log。 |
| Skills root | `~/.liveagent/skills` | Tauri Rust + GUI | 用户可安装/创建/打包的 Skills runtime root。 |
| WebUI 本地缓存 | Browser localStorage | WebUI | token、脱敏 settings snapshot、UI 偏好与运行态辅助缓存。 |

Gateway 的 Chat relay state 不属于持久化数据：conversation event window 默认保留最近 10 分钟并受 4096 条/约 8 MiB 硬上限约束，`client_request_id` 幂等记录在当前进程保留 24 小时。Gateway 重启后由桌面历史 snapshot、run ledger 与 RuntimeStatus 重新对账。

## 设计原则

| 原则 | 在当前代码中的体现 |
|---|---|
| 桌面端是真相源 | 工具执行、历史、设置、记忆、Cron prompt、MCP runtime 都在 Tauri/GUI 侧落地。 |
| Gateway 不越权 | Gateway 不直接访问用户文件系统，不保存真实 provider key；只维护会话、中继和有界的进程内 Chat 事件窗口。 |
| GUI/WebUI 可用性对齐 | 两端从 `crates/agent-ui` 复用组件与领域逻辑，通过 `@liveagent/adapters` 提供 Tauri 或 Gateway 适配器；应用独有能力由扩展注册表选择性启用。 |
| 长对话可恢复 | 历史使用桌面端 segment + summary checkpoint；短时断线由 Gateway 内存 seq window 和 `chat.subscribe.after_seq` 补齐，窗口 reset 或 Gateway 重启时回到桌面历史 snapshot。 |
| 功能域清晰 | Chat runtime、Tools、Memory、Skills、MCP、Cron、Hooks、History 都有独立源码区域与后端命令。 |

## 高层模块图

```text
Browser WebUI
  ├─ React entry / Gateway controllers / GatewayTranscript
  ├─ Shared UI: Settings / Hubs / sidebar / composer / project tools
  ├─ GatewayWebSocketClient (chat command/subscribe + sync)
  └─ HTTP upload / public share
        │
        ▼
Go Gateway
  ├─ HTTP/WS: /ws/v2, /ws/v2/agent, /ws/v2/terminal, /api/status, /api/files/import, /api/public/history-shares/{token}
  └─ session.Manager: agent session, streams, settings/history subscribers, bounded chat relay window
        │
        ▼
Desktop LiveAgent
  ├─ React GUI: App, ChatPage, desktop adapters
  ├─ Shared UI: Settings / Hubs / sidebar / composer / project tools
  ├─ Agent runtime: model streaming, tools loop, compaction, memory extraction
  └─ Tauri Rust: commands, services, SQLite, MCP, MemoryStore, Cron, Gateway bridge
```
