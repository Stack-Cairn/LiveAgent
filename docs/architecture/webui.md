# WebUI 架构

## 定位

WebUI 是 Gateway 承载的浏览器端操作台。它复用/复制了大量 GUI 交互形态，但不直接执行 Agent、本地工具或 Tauri 命令。所有需要本地权限的操作都通过 Gateway WebSocket/HTTP 转发到桌面端。

## 主要模块

| 模块 | 路径 | 职责 |
|---|---|---|
| App shell | `crates/agent-gateway/web/src/App.tsx` | 登录、socket 生命周期、settings/history/chat 状态、页面切换、composer/transcript。 |
| Socket client | `web/src/lib/gatewaySocket.ts` | WebSocket 请求/响应、广播监听、Chat command 与会话流订阅、恢复与错误处理。 |
| Conversation stream | `web/src/lib/chat/stream/conversationStreamClient.ts` | 按会话持久订阅注册表：维护 `after_seq`/`stream_epoch` 游标、重连自动重订阅、gap resync。 |
| Gateway types | `web/src/lib/gatewayTypes.ts` | WebUI 侧协议类型。 |
| Settings storage | `web/src/lib/webSettings.ts`、`web/src/lib/settings/*` | 浏览器本地设置缓存、脱敏 provider snapshot、settings sync payload。 |
| History sync | `web/src/lib/historySync.ts`、`web/src/lib/historyParser.ts` | 历史列表/详情同步，大历史 worker 解析。 |
| Transcript | `web/src/components/GatewayTranscript.tsx`、`web/src/pages/chat/*` | WebUI 对话渲染、checkpoint、tool trace、composer/header。 |
| Shared UI copy | `web/src/components/*`、`web/src/pages/*`、`web/src/lib/*` 中的镜像实现 | 与 GUI 对齐的 Settings、Hub、chat sidebar、image preview 等实现。 |
| Tauri shims | `web/src/shims/*` | 将 `@tauri-apps/api/*` 替换为 WebUI 可用的 Gateway/browser 实现。 |

## 连接与认证

| 阶段 | 行为 |
|---|---|
| token 读取 | WebUI 从浏览器存储读取 token，或通过 LoginPage 输入。 |
| socket 创建 | `getGatewayWebSocketClient(token)` 建立 `/ws` 连接。 |
| 状态订阅 | 订阅 Gateway status，展示 Desktop Agent online/offline。 |
| 请求响应 | 所有 request 带 id，Gateway 用同 id 返回 payload 或 error。 |
| Chat 流 | 提交/编辑/取消走 WebSocket `chat.command`；流式输出走按会话持久订阅 `chat.subscribe`（`chat.event` 推送，seq 续传）。 |
| 断线恢复 | WebSocket client 处理普通同步重连；Chat 订阅在 history snapshot hydrate 后重发 `chat.subscribe`，按同 conversation 单调递增的 `after_seq`（配合 `stream_epoch`）跨 run 补齐缺失事件；观察正在运行的远程会话时优先使用 `history.list.running_conversations[].first_seq - 1` 作为当前 run 的订阅起点。 |

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
| 源码组织 | WebUI 保留自己的复制/镜像文件，不直接从 `agent-gui` import 大量源码。右侧边栏（project-tools）与 `lib/workspace-activity` 的镜像文件必须逐字节一致：清单在 `scripts/mirror-manifest.json`，CI 以 `node scripts/check-mirror.mjs` 强制校验；平台差异只允许出现在两端各自的适配文件（ChatPage/GatewayApp、workspace-activity client、SshTunnelPanel）。 |
| Tauri API | WebUI 通过 Vite alias 指向 shims，避免真实 Tauri 依赖进入浏览器运行时。 |
| 数据通道 | GUI 走 Tauri invoke；WebUI 走 Gateway WebSocket/HTTP。 |
| 执行权限 | GUI 可以触发本地工具；WebUI 只能请求桌面端代执行。 |

## WebUI 支持的主要 Gateway 方法

| 方法族 | 示例 |
|---|---|
| Auth/status | `status.get`、socket auth/unauthorized handling |
| Chat | WS `chat.command`（`chat.submit`/`chat.edit_resend`/`chat.cancel`）、`chat.subscribe`/`chat.unsubscribe`、`chat.activities`；事件经 `chat.event`/`chat.command_update` 推送 |
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
| 复制维护成本 | 列入 `scripts/mirror-manifest.json` 的文件由 CI 逐字节校验，改动必须双端同 PR 落地；未列入清单的镜像组件仍需双端一起检查。 |
| 浏览器存储不是权威 | Settings 和 history 的真实来源仍是桌面端 SQLite 与 Gateway sync。 |
