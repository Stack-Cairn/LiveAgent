# WebUI 架构

## 定位

WebUI 是 Gateway 承载的浏览器端操作台。它与 GUI 共同复用 `crates/agent-ui`，但不直接执行 Agent、本地工具或 Tauri 命令。所有需要本地权限的操作都通过 Gateway WebSocket/HTTP 转发到桌面端。

## 主要模块

| 模块 | 路径 | 职责 |
|---|---|---|
| App shell | `crates/agent-gateway/web/src/App.tsx`、`web/src/app/GatewayApp.tsx` | `App` 负责登录与启动，`GatewayApp` 负责 socket、settings/history/chat 状态和共享 UI 的数据装配。 |
| Socket client | `web/src/lib/gatewaySocket.ts` | v2 WebSocket（Protobuf 帧）请求/响应、广播监听、连接超时、原生 Chat Runtime 唤醒、Chat command ACK 恢复与错误处理；proto 生成代码位于 `web/src/lib/proto/gen/`。 |
| Conversation stream | `web/src/lib/chat/stream/conversationStreamClient.ts` | 按会话持久订阅注册表：维护 `after_seq`/`stream_epoch` 游标、重连自动重订阅、gap resync 与有界退避重试。 |
| Gateway types | `web/src/lib/gatewayTypes.ts` | WebUI 侧协议类型。 |
| Settings storage | `web/src/lib/webSettings.ts`、`web/src/lib/settings/*` | 浏览器本地设置缓存、脱敏 provider snapshot、settings sync payload。 |
| History sync | `web/src/lib/sidebar/webSidebarBackend.ts`、`web/src/lib/chat/chatHistory.ts`、`web/src/lib/historyParser.ts` | 历史摘要/事件同步、详情读取和大历史 worker 解析。 |
| Transcript | `web/src/components/GatewayTranscript.tsx`、`web/src/pages/chat/*` | WebUI 行模型、流式快照和虚拟列表；composer/header/消息操作等公共视觉来自 `agent-ui`。 |
| Shared UI | `crates/agent-ui/src/*` | GUI/WebUI 共用的 Settings shell、Hub、chat sidebar、project tools 与领域逻辑。 |
| 宿主能力 | `web/src/agent-ui-adapters/*`、`web/src/shims/*` | 为共享 UI 提供 Gateway/browser 实现，并隔离残留的 Tauri 兼容入口。 |

## 连接与认证

| 阶段 | 行为 |
|---|---|
| token 读取 | WebUI 从浏览器存储读取 token，或通过 LoginPage 输入。 |
| socket 创建 | `getGatewayWebSocketClient(token)` 建立 `/ws/v2` 连接（Protobuf 二进制帧，子协议 `liveagent.v2.pb`）；连接建立总超时为 10 秒，认证另有 15 秒超时，旧连接迟到的 close 不会误伤新连接。 |
| 状态订阅 | 订阅 Gateway status，展示 Desktop Agent online/offline。 |
| 请求响应 | 所有 request 带 id，Gateway 用同 id 返回 payload 或 error。 |
| Chat 唤醒 | 用户消息先即时 optimistic echo，再串行发送 `chat.prepare`；Gateway 通过关联原生 Ping/Pong 真正唤醒桌面 Chat Runtime，并让紧随其后的 command 复用同一 Agent session 上 2 秒内的新鲜探测，避免正常路径重复一个原生 RTT。准备请求最多等待 2.5 秒，旧 Gateway 不支持该方法时回退到 `status.get`，最终仍由 `chat.command` 作为兜底唤醒信号。 |
| Chat 流 | 提交/编辑/取消走 WebSocket `chat.command`；ACK 最多等待 4 秒，连接中断或 ACK 丢失时只重试一次，并复用完全相同的 payload 与 `client_request_id`。流式输出走按会话持久订阅 `chat.subscribe`（`chat.event` 推送，seq 续传）。 |
| 断线恢复 | WebSocket client 处理普通同步重连；Chat 订阅在 history snapshot hydrate 后重发 `chat.subscribe`，按同 conversation 单调递增的 `after_seq`（配合 `stream_epoch`）跨 run 补齐内存窗口内的缺失事件；单次订阅 5 秒超时，失败后以 250ms、500ms、1s、2s、5s 上限加 jitter 自恢复。观察正在运行的远程会话时优先使用 `history.list.running_conversations[].first_seq - 1` 作为当前 run 的订阅起点。 |

## WebUI 本地状态

| 状态 | 来源 | 用途 |
|---|---|---|
| `token` | 用户输入/localStorage | WebSocket 和 HTTP API 认证。 |
| `settings` | Gateway `settings.get`、`settings.event`、local redacted cache | 渲染 Settings、Chat mode、model list、MCP/Skills/Memory 等。 |
| `historyItems` | Gateway `history.list`、`history.event` | 侧边栏、pin/share/delete/rename。 |
| `visible transcript` | `history.get`、live chat events、本地 draft | 当前会话内容。 |
| `live stream cache` | Chat Command 返回、`chat.subscribe` replay 与 `chat.event` 推送 | 保持运行中会话流式可见。 |
| `draft conversation` | WebUI 本地临时 id | 新对话提交后迁移到桌面端返回的真实 conversationId。 |
| upload cache | HTTP upload response | 将导入后的 `ChatUploadedFile` 附到下一次 Chat Command。 |

## 与 GUI 的共享和分离

| 维度 | 说明 |
|---|---|
| 视觉/交互 | Settings、Skills Hub、MCP Hub、Chat sidebar、AssistantBubble 等与 GUI 保持 parity。 |
| 源码组织 | 公共源码位于 `crates/agent-ui`；WebUI 只保留 Gateway、登录、远程状态和浏览器传输等应用逻辑。`scripts/check-ui-boundaries.mjs` 阻止共享层反向依赖具体应用，并禁止应用保留同路径副本。 |
| 能力差异 | Settings 通过 `UiExtensionRegistry` 注册页面：WebUI 独有 `devices`，GUI 独有 `shortcuts` 与 `about`。 |
| Tauri API | WebUI 通过 Vite alias 指向 shims，避免真实 Tauri 依赖进入浏览器运行时。 |
| 数据通道 | GUI 走 Tauri invoke；WebUI 走 Gateway WebSocket/HTTP。 |
| 执行权限 | GUI 可以触发本地工具；WebUI 只能请求桌面端代执行。 |

## WebUI 支持的主要 Gateway 方法

| 方法族 | 示例 |
|---|---|
| Auth/status | `status.get`、socket auth/unauthorized handling |
| Chat | WS `chat.prepare`、`chat.command`（`chat.submit`/`chat.edit_resend`/`chat.cancel`）、`chat.subscribe`/`chat.unsubscribe`、`chat.activities`；事件经 `chat.event`/`chat.command_update` 推送 |
| History | `history.list`、`history.get`、`history.rename`、`history.pin`、`history.share.get`、`history.share.set`、`history.delete` |
| Settings | `settings.get`、`settings.update` |
| Providers | `providers.list`、provider model scan related request |
| Skills | `skills.list`、`skills.manage`、`skills.read-metadata`、`skills.read-text` |
| MCP | MCP settings 通过 settings 更新；运行期工具由桌面端执行。 |
| Cron | `cron.manage` |
| Memory | `memory.manage` |
| Files | upload HTTP `/api/files/import`，mentions/fs roots/list dirs 走 Gateway request。 |

## Provider Secret 处理

| 场景 | 处理 |
|---|---|
| GUI -> Gateway settings sync | provider API key 被 redaction，只同步 `apiKeyConfigured` 等 presence 信息。 |
| Gateway -> WebUI | WebUI 只能看到脱敏快照。 |
| WebUI 保存已有 provider | 未输入新 key 时不把空/脱敏值覆盖回 GUI 真实 key。 |
| WebUI 输入新 key | 通过 `providerApiKeyUpdates` 单向发回 GUI 更新。 |
| WebUI localStorage | 保存 redacted provider settings，避免浏览器长期保存真实 secret。 |

## WebUI 的重要限制

| 限制 | 影响 |
|---|---|
| 不直接执行工具 | Shell、FS、MCP、Memory mutation、Cron prompt 都必须回到桌面端。 |
| 依赖 Gateway 在线 | Gateway 或 Desktop offline 时，Chat/Settings/History 能力受限。 |
| 共享边界 | 公共交互改动只修改 `crates/agent-ui`；应用差异必须留在 `@liveagent/adapters` 或扩展注册表中。 |
| 浏览器存储不是权威 | Settings 和 history 的真实来源仍是桌面端 SQLite 与 Gateway sync。 |
| Gateway relay 不是持久历史 | `chat.subscribe` 的 seq replay 来自 Gateway 进程内的有界事件窗口；Gateway 重启或窗口 reset 时，WebUI 以桌面历史 snapshot 重新 hydrate。 |
