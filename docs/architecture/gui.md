# 桌面 GUI 与 Tauri 架构

## 模块边界

| 模块 | 路径 | 职责 |
|---|---|---|
| React app shell | `crates/agent-gui/src/App.tsx` | 设置 hydration/save、主题/i18n、Settings overlay、ChatPage、CronPromptRunner、MemoryOrganizerRunner、全局 toast。 |
| Chat 页面 | `crates/agent-gui/src/pages/ChatPage.tsx` | 会话状态、消息发送/取消、历史、上传、模型选择、Gateway bridge、Skills/Memory prompt、压缩与运行态编排。 |
| Chat 子模块 | `crates/agent-gui/src/pages/chat/*` | transcript 数据控制器、agent/text turn、history actions、uploads、上下文构造和 live transcript store；公共 composer/header/视觉组件来自 `crates/agent-ui`。 |
| Settings | `crates/agent-ui/src/pages/settings/*`、`crates/agent-gui/src/pages/settings/*` | 公共 Settings 页面位于 `agent-ui`；GUI 目录只保留快捷键、关于页和 Memory 平台适配器等桌面扩展。 |
| Hub 页面 | `crates/agent-ui/src/pages/skills-hub/*`、`crates/agent-ui/src/pages/mcp-hub/*`、`crates/agent-ui/src/components/hub/*` | Skills Hub、MCP Hub、store/registry 浏览与公共 Hub 外壳。 |
| UI 组件 | `crates/agent-ui/src/components/*`、`crates/agent-gui/src/components/*` | 公共 Sidebar、Markdown、ImagePreview 和基础组件位于 `agent-ui`；GUI 目录保留桌面独有组件。 |
| 前端设置库 | `src/lib/settings/*` | 默认值、normalize、storage、Gateway sync snapshot、provider redaction。 |
| 模型层 | `src/lib/providers/llm.ts` | provider 到具体模型 API 的映射、headers、Responses/Anthropic/Gemini stream、thinking/cache/search。 |
| 工具层 | `src/lib/tools/*`、`src/lib/subagents/*` | builtin tool registry、FS、Shell、MCP、Skills、Cron、Memory、custom system tools；subagents 域提供 `Agent`/`SendMessage` 委托工具。 |
| Tauri 后端 | `src-tauri/src` | 系统命令、SQLite、MCP runtime、MemoryStore、GatewayController、CronManager、代理服务。 |

## App Shell

| 责任 | 当前实现 |
|---|---|
| 初始设置 | 通过 settings API 读取 providers/system/mcp/agents/hooks/cron/remote/memory，并与前端默认值合并。 |
| 设置保存 | Settings 页修改后按配置域保存到 Tauri SQLite，并在需要时 publish settings sync 到 Gateway。 |
| 主题与语言 | `theme` 写入 document root，`LocaleProvider` 提供翻译。 |
| 页面布局 | 主视图以 ChatPage 为中心，Settings 使用 overlay/modal 风格进入。 |
| 后台 runner | `CronPromptRunner` 接管 prompt 类型 cron；`MemoryOrganizerRunner` 接管自动整理记忆。 |
| 远程桥接 | Remote settings 启用时，Tauri GatewayController 连接 Go Gateway，并把 settings/history/chat event 发布出去。 |

## 本机快捷键偏好

桌面端「设置 → 快捷键」中的偏好保存在本机 WebView 的 localStorage，不进入设置同步或 Gateway 配置。

- **发送消息**：行内切换 Enter 与 Ctrl+Enter（macOS 显示 ⌘+Enter，兼容 Ctrl+Enter）。选择组合键发送时，普通 Enter 换行；Shift+Enter 始终换行。发送键只在当前消息输入框中生效，保留输入法选词保护。默认使用 Enter 发送。
- **生效范围**：每个已绑定的应用动作可切换「全局 / 应用」。全局绑定通过 Tauri 系统热键注册；应用绑定仅在 LiveAgent 窗口有焦点时派发，并在 Rust 端再次检查窗口焦点。未带范围字段的旧绑定继续按全局处理。
- **录制与切换**：录制期间同时暂停全局注册和应用内监听；全量注册请求串行执行，切到应用范围时撤销原有系统热键。应用范围的无修饰字符键不会抢占输入框的正常输入，托盘菜单只回显全局范围的快捷键。

主要入口为 `src/lib/shortcuts/globalShortcuts.ts`、`src/pages/settings/GlobalShortcutsSection.tsx`、`src-tauri/src/commands/app/app.rs`；共享消息输入框读取 `agent-ui/src/lib/chat/sendShortcut.ts`。

## ChatPage 编排

| 子系统 | 说明 | 关键路径 |
|---|---|---|
| 会话运行态 | 当前 conversation、session、message list、live stream、tool status、running/canceling 状态。 | `ChatPage.tsx`、`pages/chat/hooks/useChatPageRuntimeStore.ts`、`lib/chat/conversation/liveTranscriptStore.ts` |
| 发送入口 | 将用户文本、附件、选中模型、execution mode、workdir、system tools 等合并为 turn request。 | `ChatPage.tsx` |
| text 模式 | 只做模型文本流式，不注入本地工具。 | `pages/chat/turns/runTextConversationTurn.ts`、`lib/providers/llm.ts` |
| tools/agent-dev 模式 | 构造 builtin tools，执行模型 tool loop，写工具 trace，并同步 Gateway chat event。 | `pages/chat/turns/runAgentConversationTurn.ts`、`lib/chat/conversation/run/*` |
| 历史持久化 | V3 segment 写入 Tauri SQLite，支持 append segment、active segment update、rename/delete/pin/share。 | `lib/chat/conversation/conversationState.ts`、`src-tauri/src/commands/history/chat_history/*` |
| 上下文压缩 | 在 pre-send、mid-stream、post-tool 等阶段生成 summary checkpoint，避免超上下文。 | `pages/chat/runtime/conversationContextBuilders.ts`、`lib/chat/compaction/*` |
| 记忆注入 | 每轮根据 workdir 读取 memory overview，并附加到 system prompt。 | `lib/chat/memory/*`、`src-tauri/src/services/memory/*` |
| Skills 注入 | 根据 Settings Skills 选择与 always-on builtin skills 生成 skills prompt。 | `crates/agent-ui/src/lib/skills/index.ts`、`crates/agent-ui/src/lib/skills/useChatSkills.ts` |
| 上传 | GUI 直接调用 Tauri import readable files/image preview；工作区外文件复制到 `~/.liveagent/uploads` 暂存区（不污染工作区），工作区内文件原地引用。 | `pages/chat/hooks/usePendingUploads.ts`、`src-tauri/src/commands/app/system.rs` |
| 外部目录 | Composer 可选择工作区外目录并将其挂载为当前项目的只读 workspace root；活动 root 会显示在 File Tree 中，但不加入工作区 activity watcher。 | `ChatPage.tsx`、`pages/chat/hooks/useUploadZoneDrop.ts`、`crates/agent-ui/src/components/project-tools/file-tree/*` |
| Gateway bridge | 本地运行时接收远程 command，把 token/thinking/tool/done/error 等事件发布给 Gateway；listener 与 worker id 在组件生命周期内保持稳定。 | `pages/chat/gateway/useGatewayBridgeListeners.ts`、`lib/chat/conversation/run/gatewayBridgeEvents.ts` |

## Tauri Invoke Surface

`src-tauri/src/lib.rs` 用 `tauri::generate_handler!` 注册桌面端所有命令。按领域可归纳为：

| 领域 | 命令族 |
|---|---|
| Chat history | `chat_history_list/search/get/upsert/upsert_active_segment/append_segment/rename/set_pinned/share_get/share_set/delete` |
| Subagent store | `subagent_identity_upsert/list`、`subagent_run_save/list/load/prune`、`subagent_message_append/list` |
| File system | `fs_read_text/read_image_source/write_text/edit_text/delete/list/glob/grep/mention_list` |
| Subagent worktree | `subagent_worktree_create/status/apply/cleanup` |
| MCP runtime | `mcp_list_tools/call_tool/runtime_status/stop_server/test_server/restart_server` |
| Memory | `memory_list/read/search/write/update/delete/accept/apply_batch/organize_* /index_overview/paths_info/recent_rejections/today_daily/wipe_all` |
| Settings | `settings_load_all/save_providers/save_system/save_mcp/save_agents/save_hooks/save_cron/save_remote/save_memory` |
| Hooks/Cron | `hook_run_script/run_http_requests`、`cron_validate_expression/list_logs/clear_logs/take_pending_prompt_runs/complete_prompt_run` |
| Shell/process | `shell_run/cancel`、`managed_process_start/status/stop/read_log` |
| System | folder/file picker、uploads、skill metadata/text/manage、debug jsonl、power activity、cron task manage |
| Gateway | `gateway_connect/disconnect/status/nudge_connection/send_chat_event/publish_conversation_activity/publish_settings_sync` |
| Proxy | `proxy_get_server_info` |

## Rust Services 与 Runtime

| 路径 | 作用 |
|---|---|
| `src-tauri/src/services/gateway/*` | GatewayController，维护桌面端到 Gateway 的连接、原生唤醒、inbox、状态同步与重连。 |
| `src-tauri/src/services/gateway_bridge.rs` | 将 Gateway 请求转成前端/Tauri 能处理的操作，处理 settings/history/chat 等桥接。 |
| `src-tauri/src/services/memory/*` | MemoryStore，负责 Markdown 记忆文件、SQLite FTS 索引、quota、daily、organizer。 |
| `src-tauri/src/services/skills/*` | Skills root、builtin seed、install/create/validate/package、ClawHub。 |
| `src-tauri/src/services/automation/*` | 自动化调度与存储，覆盖 bash/http/prompt task 和运行记录。 |
| `src-tauri/src/services/proxy.rs` | 本地 proxy server，用于 provider proxy 和上游访问。 |
| `src-tauri/src/runtime/shell_runner.rs` | Shell 脚本执行抽象。 |
| `src-tauri/src/runtime/managed_process.rs` | 长任务/后台进程管理。 |
| `src-tauri/src/runtime/task_runner.rs` | 通用异步任务运行辅助。 |

## Gateway 连接与 Runtime 唤醒

| 机制 | 当前实现 |
|---|---|
| 稳定 WebView listener | `useGatewayBridgeListeners` 用 ref 保存 worker id 和最新回调，effect 只在组件挂载/卸载时注册或销毁；普通 React render 不再重建 listener、制造接收空窗或重复上报 `suspended`。 |
| 原生往返唤醒 | Rust 收到 `chat-runtime-wake-` 前缀的关联 Ping 后 emit `gateway:chat-runtime-wake`；所有 Pong（唤醒与心跳）经专用出站控制通道（64 深，与数据队列 merge 进同一信封流（v2 WebSocket））`try_send` 返回，token 流打满数据队列时探测仍可被应答，且绝不阻塞 inbound receive loop。 |
| 生命周期 nudge | `online`、`focus`、`pageshow`、`visibilitychange`、WebView `resume` 与 Tauri `RunEvent::Resumed` 会唤醒 runtime；`online`/focus 类事件经 `gateway_nudge_connection` 走 offline/stale-heartbeat 健康检查后才重建连接（不强制），仅 `RunEvent::Resumed` 保留强制重连。 |
| 快速重连 | 信封流自动重连从 250ms 指数退避到 5s（v2 `/ws/v2/agent`），稳定连接 30s 后重置；stale 判断使用 heartbeat interval 加 20s（最多 60s）。 |
| inbound 优先 | 信封流（`/ws/v2/agent`）建立后立即进入 inbound receive loop。Runtime status 先恢复，settings、terminal、tunnel、process 与 run ledger 延迟 200ms 后在可中止后台任务中低优先级 replay，并在批次间 yield。 |
| 启动空窗消除 | WebView 在 Tauri listener 异步注册完成前就先 heartbeat + drain 一次；native wake、request-ready 与 Gateway online 事件都会继续触发 drain。 |

## 本地持久化模型

| 数据域 | Rust 命令/服务 | 表或文件 |
|---|---|---|
| Providers/System/MCP/Agents/Hooks/Cron/Remote/Memory settings | `commands/config/settings/*` | `~/.liveagent/config.sqlite` 内多张 settings 表 |
| Chat history | `commands/history/chat_history/*`、`commands/history/history_db.rs` | `~/.liveagent/chat-history.sqlite3` 的 `chatHistory`、`chatHistorySegment`、`chatHistoryShare`、FTS |
| Memory | `services/memory/*` | `~/.liveagent/memory/**/*.md` + `memory-index.sqlite3` |
| Skills | `services/skills/*` | `~/.liveagent/skills` |
| Cron logs | `commands/config/settings/*`、`services/automation/*` | `cron_execution_logs` |
| Subagent identity/run/message | `commands/history/subagent_store.rs` | chat history 库内 `subagentMeta` 版本标记 + `subagentIdentity`/`subagentRun`/`subagentRunSegment`/`subagentMessage`（schema v2，版本不符即 drop-and-recreate，无 event 表） |

## GUI 的设计取舍

| 取舍 | 原因 |
|---|---|
| ChatPage 仍是总编排层 | 对话运行时跨模型、工具、历史、压缩、记忆、Gateway、上传和 UI 状态，保留一个编排中心能减少跨模块隐式状态。 |
| 高权限能力放 Rust | 文件系统、Shell、MCP 进程、SQLite、Gateway 连接、Cron 更适合在 Tauri 后端做权限与生命周期控制。 |
| GUI 与 WebUI 共享应用 UI | Settings、Hub、聊天侧边栏、输入栏和公共视觉只在 `crates/agent-ui` 保留一份；GUI 通过宿主适配器接入 Tauri 能力。 |
| Settings 按域保存 | provider secret、remote、cron、memory 等域有不同验证和同步策略，分域保存便于限制泄露与减少误覆盖。 |
| Gateway 控制面优先 | 远程首条 Chat command 与 Ping/Pong 必须先于大体积状态 reconciliation；后台 snapshot replay 只负责最终一致性，不阻塞 inbound。 |
