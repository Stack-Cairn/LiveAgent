# 协议与同步合同

## 协议总览

| 通道 | 端点 | 方向 | 用途 |
|---|---|---|---|
| gRPC unary | `AgentGateway.Authenticate` | Desktop -> Gateway | 桌面端认证与 session 初始化。 |
| gRPC stream | `AgentGateway.AgentConnect` | Desktop <-> Gateway | 桌面端常驻双向通道，承载 GatewayEnvelope 与 AgentEnvelope。 |
| gRPC stream | `AgentGateway.AgentTerminalConnect` | Desktop <-> Gateway | 终端专用字节流，承载 `TerminalStreamFrame`，避免 terminal IO 与 chat/settings/history 队头阻塞。 |
| WebSocket | `GET /ws` | WebUI <-> Gateway | WebUI 非 Chat 请求/响应、状态广播、history/settings 等同步。 |
| WebSocket | `GET /ws/terminal` | WebUI <-> Gateway | WebUI 终端专用二进制流；JSON 控制帧只用于 auth/error，热路径为 bytes frame。 |
| WS Chat Command | WebSocket `chat.command` | WebUI -> Gateway -> Desktop | Chat 提交、编辑重发、取消；命令先被 Gateway accepted，再异步下发桌面端；pre-stream 结果经 `chat.command_update` 推送。 |
| WS Chat Stream | WebSocket `chat.subscribe` / `chat.event` | Gateway -> WebUI | 按 conversation 持久订阅（跨 run）；订阅响应按 `after_seq`/`stream_epoch` 补发缺失事件，之后 `chat.event` 实时推送，`chat.unsubscribe` 结束。 |
| HTTP API | `/api/status` | WebUI -> Gateway | 查询 Agent 在线状态。 |
| HTTP upload | `/api/files/import` | WebUI -> Gateway -> Desktop | 上传可读文件并导入桌面 workspace。 |
| Public HTTP | `/api/public/history-shares/{token}` | Browser -> Gateway | 公开只读历史分享。 |

## gRPC Envelope

`crates/agent-gateway/proto/v1/gateway.proto` 定义两个主 envelope：

| Envelope | 方向 | payload 示例 |
|---|---|---|
| `GatewayEnvelope` | Gateway -> Desktop | `ChatCommandRequest`、`CronManageRequest`、`History*Request`、`ProviderListRequest`、`Settings*Request`、`Skill*Request`、`FileMentionListRequest`、`UploadReadableFilesRequest`、`MemoryManageRequest`。 |
| `AgentEnvelope` | Desktop -> Gateway | `ChatEvent`、`ChatControlEvent`、`CronManageResponse`、`History*Response`、`HistorySyncEvent`、`ProviderListResponse`、`Settings*Response`、`SettingsSyncEvent`、`Skill*Response`、`UploadReadableFilesResponse`、`MemoryManageResponse`、`ErrorResponse`。 |

## Chat 协议

| 阶段 | WebUI -> Gateway | Gateway -> Desktop | Desktop -> Gateway -> WebUI |
|---|---|---|---|
| 提交 | WS `chat.command`，`type=chat.submit` | `ChatCommandRequest{type=chat.submit}` | 响应携带 `run_id`/`accepted_seq`；用户消息与 token 事件经会话订阅 `chat.event` 推送。 |
| 编辑重发 | WS `chat.command`，`type=chat.edit_resend` | `ChatCommandRequest{type=chat.edit_resend, base_message_ref}` | Gateway 先发布 `rebased` 与新用户消息事件，桌面端随后原子截断并运行新 turn。 |
| 恢复 | WS `chat.subscribe`，`{conversation_id, after_seq, stream_epoch}` | 无 | WebUI 先用 history snapshot/projection hydrate，订阅响应由 Gateway 从 SQLite `chat_events` 按 conversation seq 跨 run 补发缺失事件（`events`/`latest_seq`/`reset`）；内存缓存同样按 conversation 汇总最近 run 事件并负责实时 fan-out；订阅缓冲溢出时 Gateway 发 `chat.subscription_reset`，客户端按游标重新订阅补齐。 |
| 取消 | WS `chat.command`，`type=chat.cancel` | `ChatCommandRequest{type=chat.cancel}` | Gateway 置 `cancelling` 状态，桌面端真实终态优先，超时由 watchdog 兜底 `run_finished(cancelled)`。 |
| 完成 | 无 | 无 | `ChatEvent.type=DONE` 映射为 `run.completed` 终态。 |

桌面端仍通过 `ChatEvent` 表达 `TOKEN`、`THINKING`、`TOOL_CALL`、`TOOL_RESULT`、`DONE`、`ERROR`、`TOOL_STATUS`、`HOSTED_SEARCH` 等低层事件。Gateway 对外统一附加同 conversation 内单调递增的 `seq`，并把控制事件规范化为 `run.accepted`、`user.message.appended`、`conversation.rebased`、`projection.updated`、`run.completed`、`run.failed`、`run.cancelled` 等 WebUI 事件。旧 HTTP SSE Chat 路由（`GET /api/chat/events`）已下线。

Chat command（WS `chat.command`）只接受 `{ type, payload }` envelope；`command`、顶层裸 payload、`request_id` 别名都不再作为兼容输入。

## Settings 同步

| 操作 | 方向 | 语义 |
|---|---|---|
| `settings.get` | WebUI -> Gateway -> Desktop | 读取桌面端当前 settings snapshot。 |
| `settings.update` | WebUI -> Gateway -> Desktop | 更新设置；provider secret 使用单独 `providerApiKeyUpdates`。 |
| `settings.event` / `SettingsSyncEvent` | Desktop -> Gateway -> WebUI | GUI 本地保存后广播脱敏 settings snapshot。 |

设置协议的关键约束是 provider API key 不走普通 sync snapshot。WebUI 只能看到 redacted provider 数据和 `apiKeyConfigured` 状态。

## History 同步

| 操作 | 语义 |
|---|---|
| `history.list` | 分页读取 conversation summary，用于 sidebar；`running_conversations` 会附带 `run_id`、`first_seq`、`latest_seq`、`run_epoch`，让 WebUI 观察远程运行时从当前 run 起点发起 `chat.subscribe`。 |
| `history.get` | 读取 conversation detail；支持 `max_messages` 返回 tail window。 |
| `history.rename` | 修改标题并广播 upsert event。 |
| `history.pin` | 修改置顶状态并保持排序。 |
| `history.share.get/set` | 管理公开分享 token 与 redaction 选项。 |
| `history.delete` | 删除会话和相关 FTS/share 行。 |
| 编辑重发截断 | 不再暴露独立 WebUI history 命令；由 `chat.edit_resend` 在桌面端处理，并通过 `conversation.rebased`/`projection.updated` 同步视图。 |

桌面端是历史数据库真相源；Gateway 负责 request forwarding 和 sync event broadcasting；WebUI 负责本地列表和 transcript 状态更新。

## Upload 协议

| 步骤 | 说明 |
|---|---|
| 1 | WebUI 将文件通过 multipart POST 到 `/api/files/import`。 |
| 2 | Gateway 读取文件 bytes，注册 request stream，转成 `UploadReadableFilesRequest` 发给 Desktop。 |
| 3 | Desktop 根据 workdir 导入 `.liveagent`/uploads 类工作区位置，返回 `ChatUploadedFile` 列表和 skipped 列表。 |
| 4 | WebUI 把返回的 uploaded files 附加到下一次 Chat Command。 |

GUI 本地上传不需要 HTTP/Gateway，直接通过 Tauri command 导入。

## Public Share 错误码

`/api/public/history-shares/{token}` 仍然通过 Gateway 转发到桌面端解析 share token。桌面端返回 `ErrorResponse.code` 后，Gateway HTTP 直接按 code 映射状态：

| code | HTTP | 场景 |
|---:|---:|---|
| `400` | Bad Request | share token 为空或请求非法。 |
| `404` | Not Found | 分享链接不存在、已关闭，或对应历史对话不存在。 |
| 其他 | Bad Gateway | 桌面端处理失败或返回未知错误。 |

Gateway 不再通过错误文案推断 public share 状态，错误语义由桌面端产生并通过 proto 传递。

## Terminal Stream 协议

终端已从普通 WebSocket RPC 模型切换为独立 stream 模型。普通 `/ws` 只保留 session list/create/close/rename、SSH prompt、SSH tabs 等控制面与 metadata 同步；高频 `attach/input/resize/output/detach` 不再作为 `/ws` request/response 存在。

| 层级 | 合同 |
|---|---|
| Browser-Gateway | `GET /ws/terminal` 首帧发送 `{type:"auth", token}`；之后使用二进制 frame：`version(1) + kind(1) + headerLength(2, big endian) + JSON header + bytes`。 |
| Frame header | `kind` 为 `attach/input/resize/detach/output/snapshot/error`；header 包含 `streamId/sessionId/projectPathKey/seq/startOffset/endOffset/cols/rows/maxBytes/truncated/error`。 |
| Desktop-Gateway | `AgentTerminalConnect(stream TerminalStreamFrame) returns (stream TerminalStreamFrame)`；`AgentConnect` 不承载 terminal output/input/resize。 |
| Snapshot | attach 返回 `snapshot` frame，data 为 tail bytes，header 的 `startOffset/endOffset` 用于前端去重。 |
| Input | input frame 为 fire-and-forget bytes；不返回 session metadata，不进入普通 request pending map。 |
| Resize | resize frame 只发送最新 cols/rows；不返回 session metadata。 |
| Output | output frame 只携带轻量 session id、project key、offset 与 bytes；React session state 不因 output 更新。 |
| 页面 stream client | `BrowserGatewayTerminalStreamClient` 每页按 token 维护一条 terminal stream，上游按 session 复用 attach；同 session 的多个 handle 共享 output。 |

Gateway 的 `/ws/terminal` 连接只维护本连接内的 session attach 集合；detach 只影响这条 terminal stream 的输出投递，不改变桌面端 terminal registry。

## Workspace Activity 协议

Git 面板与文件树不再轮询：桌面端 `workspace_watch` 服务（notify watcher，250ms 去抖，`.git` 内部噪声过滤，changedPaths 封顶 64 + truncated）为每个被观察的 workdir 发出失效信号。

| 层级 | 合同 |
|---|---|
| Desktop 内 | Tauri 事件 `workspace:activity`，payload `{workdir, revision, fs, git, changedPaths, truncated}`；前端经 `workspace_watch_set(workdirs)` 声明式注册本 webview 的观察集合。 |
| Desktop→Gateway | `AgentEnvelope.workspace_activity`（`WorkspaceActivityEvent`，字段 90）。Gateway→Desktop 用 `GatewayEnvelope.workspace_watch`（`WorkspaceWatchRequest`，声明式全量 workdir 集合；订阅计数变化与 agent 重连时重发）。 |
| Browser-Gateway | `/ws` 方法 `workspace.subscribe/unsubscribe {workdir}`，事件 `workspace.activity`。 |
| 语义 | best-effort 失效信号，不保证不丢事件：客户端在（重）订阅、通道重建、revision 回退时必须自标脏并 refetch。revision 为 per-workdir 单调计数（agent 进程内）。 |
| 消费端 | 两端镜像的 `lib/workspace-activity/useWorkspaceInvalidation`：面板隐藏时只置脏、激活时冲刷；数据本体仍走既有 fs/git 拉取命令（invalidate-push + fetch-on-demand）。 |

## Skills 与 Memory 管理协议

| 能力 | WebUI 方法 | Desktop 落点 |
|---|---|---|
| Skills 列表和管理 | `skills.list`、`skills.manage`、`skills.read-metadata`、`skills.read-text` | `system_ensure_builtin_skills`、`system_manage_skill`、`system_read_skill_*`、`services/skills.rs` |
| Memory 管理 | `memory.manage` | `commands/memory.rs`、`services/memory.rs` |
| Cron 管理 | `cron.manage` | `commands/cron.rs`、`services/cron.rs`、settings cron 表 |

## 恢复与去重机制

| 机制 | 位置 | 目的 |
|---|---|---|
| `clientRequestId` | WebUI Chat Command -> Gateway session manager | 避免重复提交导致两个真实 chat run。 |
| `conversationId` -> run index | Gateway session manager | 当前会话刷新/切换后可定位正在运行的事件流。 |
| `Seq` | Gateway SQLite `chat_events` / `chat.event` payload | 同 conversation 内单调递增；断线后 `chat.subscribe` 携带 `after_seq` 游标补发缺失事件。 |
| done retention | Gateway session manager | 已结束 run 短时间保留，支持刷新后看到终态。 |
| local running ids | WebUI App | 避免正在运行会话被错误切换或误删。 |

## 协议改造注意点

| 场景 | 必查点 |
|---|---|
| 新增 Gateway request | 同步 `proto/v1/gateway.proto`、Go server、Tauri gateway bridge、WebUI client method。 |
| 新增 settings 字段 | GUI settings normalize/storage、Rust settings save/load、Gateway redaction whitelist、WebUI settings copy 都要同步。 |
| 新增 history 字段 | Rust summary model、proto `ConversationSummary`、Gateway websocket payload、GUI/WebUI sidebar render 都要同步。 |
| 新增 chat event | Desktop event publisher、proto enum、Gateway 事件规范化与 `chat.event` payload、WebUI event reducer/transcript 都要同步。 |
| 涉及 secret | 默认不进普通 sync，必须设计单向或显式更新通道。 |
