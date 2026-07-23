# 协议与同步合同

## 协议总览

自 v2 起，网关的全部实时链路统一为 **WebSocket + Protobuf**（下称 v2 协议）。

| 通道 | 端点 | 方向 | 用途 |
|---|---|---|---|
| **v2** WebSocket | `GET /ws/v2` | WebUI <-> Gateway | 浏览器主链路：本地操作 + `GatewayEnvelope` 直通请求 + 广播事件。 |
| **v2** WebSocket | `GET /ws/v2/agent` | Desktop <-> Gateway | 桌面端常驻双向信封流。 |
| **v2** WebSocket | `GET /ws/v2/terminal` | 两端 <-> Gateway | 终端专用数据面（角色由 hello 区分），承载 `TerminalStreamFrame`，避免终端 IO 与 chat/settings/history 队头阻塞。 |
| HTTP API | `/api/status` | WebUI -> Gateway | Agent 在线状态 + `protocol_usage`（v2 使用计数）。 |
| HTTP upload | `/api/files/import` | WebUI -> Gateway -> Desktop | 上传可读文件并导入桌面 workspace。 |
| Public HTTP | `/api/public/history-shares/{token}` | Browser -> Gateway | 公开只读历史分享。 |

## v2 统一线协议

权威定义：`crates/agent-gateway/proto/v2/gateway_ws.proto`（帧壳），业务消息
全部复用 `proto/v2/gateway.proto`（`GatewayEnvelope`/`AgentEnvelope`/
`TerminalStreamFrame` 等——单一事实源，三端 Go/Rust/TS 均由它生成）。

### 传输与握手

- WebSocket 子协议：`liveagent.v2.pb`（服务端必回显）。
- 一条 WS 二进制消息 = 一条 proto 帧消息，无长度前缀；v2 路径上文本帧被忽略。
- 首帧必须为 `ClientHello{protocol_version=2, role, token, ...}`；服务端应答
  `ServerHello{ok, session_id, heartbeat_period_seconds, max_message_bytes}`；
  鉴权失败以 close code 4401 关闭。agent 角色的 hello 同时完成会话登记。
- 消息大小上限按链路收紧并经 `ServerHello.max_message_bytes` 通告：`/ws/v2`
  浏览器 4 MiB、`/ws/v2/agent` 沿用 `MaxMessageBytes`（默认 64 MiB，上传
  需要）、`/ws/v2/terminal` 浏览器 1 MiB / Agent 16 MiB。并发连接上限
  agent 256 / browser 128 / terminal 512（超限升级前 503）；浏览器链路另有
  每连接在途派发上限 16 与入站令牌桶 100 帧/s（burst 200）。

### 浏览器链路（/ws/v2）

- 请求帧 `WebClientFrame{request_id, agent_id, oneof payload}`；响应帧回显同一
  `request_id`；广播帧 `request_id` 为空。
- **多 Agent 寻址**：目标型请求必须显式携带非空 `agent_id`，缺失时收到
  `local_error: "agent_id is required"`。官方 WebUI 首次连接会先请求
  `agent_list`，自动选择一个在线 Agent 并持久化选择，因此单 Agent 部署无需
  手工操作；广播帧的 `agent_id` 标注事件来源，客户端严格过滤非活跃 Agent。
  `agent_list` 返回全部已登记 Agent 的状态目录（含离线与仅签发凭证的条目）。
- **直通请求** `agent_request`（浏览器直接构造 `GatewayEnvelope` 载荷臂）：
  网关按白名单与限额校验（`internal/protocol/pbws/guard.go`；功能门控按目标 Agent 的 settings 快照判定）、把
  `request_id` 按连接命名空间化后近乎原样转发目标桌面端，
  响应以原始 `AgentEnvelope`（`agent_response` 臂）回送。原先约 90 个
  “JSON 解码 → 手工组 proto → 手工拆 map” 处理器由这一条路径取代。
- **本地帧**（网关状态直接应答/编排）：`status_get`、`chat_prepare`、
  `chat_command`（携带 `ChatCommandRequest`）、`chat_subscribe`/
  `chat_unsubscribe`/`chat_activities`、`workspace_subscribe`/`workspace_unsubscribe`。 其中 `chat.subscribe` 与 `chat.unsubscribe` 同样属于目标型操作，必须携带非空 `agent_id`；会话流按 `(agent_id, conversation_id)` 隔离，`chat.activities` 是全局目录查询。
- **广播臂**：`history_event`/`settings_event`/`terminal_event`/`sftp_event`/
  `chat_queue_event`/`tunnel_state`/`process_state`/`workspace_activity`
  直转 session 层的 seam 消息；`status`/`chat_activity`/`chat_event`/
  `chat_command_update`/`chat_subscription_reset` 为 proto 化载荷。
  chat 事件载荷保持动态 JSON（`payload_json` bytes）。
- **本地错误**：`local_error`（`ErrorResponse`）。
- 心跳与背压：服务端 WS 控制帧 ping + 应用层 `PingFrame` 双通道；空闲驱逐
  `3×心跳周期+宽限`；写侧为控制优先双队列 + 可掉帧数据 + 关联响应掉帧即
  断连（`internal/transport/wscore` 连接运行时）。

### 桌面端链路（/ws/v2/agent）

hello（role=AGENT）完成鉴权与会话登记后进入双向信封流：网关下行
`GatewayEnvelope`（请求 + 周期 Ping），桌面端上行 `AgentEnvelope`
（响应/事件/Pong）；心跳走独立通道不受数据拥塞影响；传输层保活由 WS 控制帧
ping/pong 承担，客户端以 3×心跳周期无入站为断链判据。

**多 Agent**：网关按 `agent_id` 维护多个并存的 Agent 会话（≤10 台规模），
同 `agent_id` 重连只顶掉该 id 的旧连接，不同 Agent 互不影响。快照
（settings/终端/提示队列/托管进程）与广播事件按 Agent 隔离，隧道帧拒绝
跨 Agent 的 stream_id 伪造。每个桌面端首次初始化设置时自动生成并持久化规范的
`agent-UUIDv4`；设置页只读展示该标识，不依赖 hostname 或用户手工命名。

### Agent 鉴权（每 Agent 独立凭证）

网关默认自动创建内嵌 SQLite 数据库（可用 `-agent-db` 或
`LIVEAGENT_GATEWAY_AGENT_DB` 指定路径）并启用每 Agent 凭证存储：

- Agent 链路接受网关 Token 或按 `agent_id` 签发的独立凭证（`agt_` 前缀）；
- Agent 独立凭证只授权绑定的 Agent 链路，不能冒充浏览器或调用 REST；网关 Token
  同时授权浏览器、管理 API 和 Agent 链路；
- 凭证可持续用于对应 Agent 连接，但明文只在签发响应展示一次，落盘仅存
  SHA-256（SQLite 文件权限 0600）；
- 管理 API（管理 token 门禁）：`GET /api/agents` 目录、
  `POST /api/agents/{id}/token` 签发/轮换并设置可选名称；轮换会立即断开当前 Agent
  会话、使旧凭证无法重连、
  `PATCH /api/agents/{id}` 修改或清空名称、`DELETE /api/agents/{id}` 删除整条记录、
  凭证并即时断开该 Agent 的活跃会话。

Gateway 数据库的首版 Agent 结构为单表 `agents`。`agent_id` 主键服务凭证点查、
名称更新和删除；`(created_at, agent_id)` 组合索引服务数据库层目录分页。

网关 Token 与独立 Agent 凭证可以并存：使用网关 Token 的客户端必须提供稳定的
`agent_id`，使用独立凭证的客户端还会受到 `agent_id` 绑定校验。

### 终端链路（/ws/v2/terminal）

两端共用一条路径，hello.role 区分浏览器/桌面端；hello 之后双向承载
`TerminalStreamFrame`（proto 直传）。浏览器角色以 `hello.agent_id` 绑定数据面的
目标 Agent；`agent_id` 必填，出站按绑定路由、入站只放行同源帧。
attach/detach 维护本连接订阅集，input/resize 需已附着，output 只投递给
已附着连接；桌面端侧就绪信号由 `ServerHello` 承担。

## Chat 协议

| 阶段 | WebUI -> Gateway | Gateway -> Desktop | Desktop -> Gateway -> WebUI |
|---|---|---|---|
| 唤醒 | `chat_prepare` | `PingRequest{request_id=chat-runtime-wake-*}` | Rust emit WebView wake，可靠返回关联 `PongResponse`；Gateway 完成真实原生往返后响应当前 status。 |
| 提交 | `chat_command`，`type=chat.submit` | `ChatCommandRequest{type=chat.submit}` | `chat_accepted` 携带 `run_id`/`accepted_seq`；用户消息与 token 事件经会话订阅 `chat_event` 推送。 |
| 编辑重发 | `chat_command`，`type=chat.edit_resend` | `ChatCommandRequest{type=chat.edit_resend, base_message_ref}` | Gateway 先发布 `rebased` 与新用户消息事件，桌面端随后原子截断并运行新 turn。 |
| 恢复 | `chat_subscribe`，`{conversation_id, after_seq, stream_epoch}` | 无 | WebUI 先用 history snapshot/projection hydrate，订阅响应由 Gateway 进程内事件窗口按 conversation seq 跨 run 补发缺失事件（`events_json`/`latest_seq`/`reset`）；epoch 改变或窗口不足时返回 reset。订阅缓冲溢出时 Gateway 发 `chat_subscription_reset`，客户端按游标重新订阅。 |
| 取消 | `chat_command`，`type=chat.cancel` | `ChatCommandRequest{type=chat.cancel}` | Gateway 置 `cancelling` 状态，桌面端真实终态优先，超时由 watchdog 兜底 `run_finished(cancelled)`。 |
| 完成 | 无 | 无 | `ChatEvent.type=DONE` 映射为 `run.completed` 终态。 |

桌面端仍通过 `ChatEvent` 表达 `TOKEN`、`THINKING`、`TOOL_CALL`、`TOOL_RESULT`、`DONE`、`ERROR`、`TOOL_STATUS`、`HOSTED_SEARCH` 等低层事件。Gateway 对外统一附加同 conversation 内单调递增的 `seq`，并把控制事件规范化为 `run.accepted`、`user.message.appended`、`conversation.rebased`、`projection.updated`、`run.completed`、`run.failed`、`run.cancelled` 等 WebUI 事件。命令编排逻辑（去重、探活、接受回执、启动看门狗）收敛于 `internal/chatcmd`。

WebUI 对 command ACK 使用 4 秒上限。连接中断或 ACK 丢失时仅重试一次，并复用完全相同的 payload 与 `client_request_id`；Gateway 在同一进程内原子返回 canonical run，因此不会重复 seed 或 dispatch。成功 prepare 的探测新鲜度绑定 Agent session epoch 并保留 2 秒，紧随 command 可直接复用，避免正常路径重复原生 RTT；`chat_accepted` 与 `chat_prepare` 响应走 WebSocket 控制优先队列，避免被 token 数据帧队头阻塞。

## Settings 同步

| 操作 | 方向 | 语义 |
|---|---|---|
| `SettingsGetRequest`（直通） | WebUI -> Gateway -> Desktop | 读取桌面端当前 settings snapshot。 |
| `SettingsUpdateRequest`（直通） | WebUI -> Gateway -> Desktop | 更新设置；provider secret 使用单独 `providerApiKeyUpdates`。 |
| `settings_event` / `SettingsSyncEvent` | Desktop -> Gateway -> WebUI | GUI 本地保存后广播脱敏 settings snapshot（`settings_json` 由客户端解析）。 |

设置协议的关键约束是 provider API key 不走普通 sync snapshot。WebUI 只能看到 redacted provider 数据和 `apiKeyConfigured` 状态。

## History 同步

| 操作 | 语义 |
|---|---|
| `HistoryListRequest` | 分页读取 conversation summary，用于 sidebar；网关钳制分页（page 默认 1、page_size 默认 80 上限 200）。 |
| `HistoryGetRequest` | 读取 conversation detail；支持 `max_messages` 返回 tail window。 |
| `HistoryRenameRequest` | 修改标题并广播 upsert event。 |
| `HistoryPinRequest` | 修改置顶状态并保持排序。 |
| `HistoryShareGet/SetRequest` | 管理公开分享 token 与 redaction 选项。 |
| `HistoryDeleteRequest` | 删除会话和相关 FTS/share 行。 |
| 编辑重发截断 | 不再暴露独立 WebUI history 命令；由 `chat.edit_resend` 在桌面端处理，并通过 `conversation.rebased`/`projection.updated` 同步视图。 |

桌面端是历史数据库真相源；Gateway 负责 request forwarding 和 sync event broadcasting；WebUI 负责本地列表和 transcript 状态更新。

## Upload 协议

| 步骤 | 说明 |
|---|---|
| 1 | WebUI 将文件通过 multipart POST 到 `/api/files/import`。 |
| 2 | Gateway 读取文件 bytes，注册 request stream，转成 `UploadReadableFilesRequest` 发给 Desktop。 |
| 3 | Desktop 把文件写入应用上传暂存区 `~/.liveagent/uploads/<batch>/`（工作区外），返回 `ChatUploadedFile` 列表和 skipped 列表。 |
| 4 | WebUI 把返回的 uploaded files 附加到下一次 Chat Command。 |

GUI 本地上传不需要 HTTP/Gateway，直接通过 Tauri command 导入。上传臂不在
`agent_request` 直通白名单内（大文件走 HTTP multipart 更合适）。

## Public Share 错误码

`/api/public/history-shares/{token}` 仍然通过 Gateway 转发到桌面端解析 share token。桌面端返回 `ErrorResponse.code` 后，Gateway HTTP 直接按 code 映射状态：

| code | HTTP | 场景 |
|---:|---:|---|
| `400` | Bad Request | share token 为空或请求非法。 |
| `404` | Not Found | 分享链接不存在、已关闭，或对应历史对话不存在。 |
| 其他 | Bad Gateway | 桌面端处理失败或返回未知错误。 |

Gateway 不再通过错误文案推断 public share 状态，错误语义由桌面端产生并通过 proto 传递。

## Terminal Stream 协议

终端为独立 stream 模型。主链路（`/ws/v2` 直通 `TerminalRequest`）只承载
session list/create/close/rename、SSH prompt、SSH tabs 等控制面与 metadata
同步；高频 `attach/input/resize/output/detach` 走 `/ws/v2/terminal` 数据面。

| 层级 | 合同 |
|---|---|
| Browser-Gateway | `GET /ws/v2/terminal` 首帧 `ClientHello{role=BROWSER}`；之后 `TerminalClientFrame{frame}` / `TerminalServerFrame{frame}` 双向承载 proto `TerminalStreamFrame`。 |
| Frame 字段 | `kind` 为 `attach/input/resize/detach/output/snapshot/error`；含 `stream_id/session_id/project_path_key/seq/start_offset/end_offset/cols/rows/max_bytes/truncated/error/data`。 |
| Desktop-Gateway | `GET /ws/v2/terminal` 首帧 `ClientHello{role=AGENT}`，其后承载 `TerminalStreamFrame`；主链路不承载 terminal output/input/resize。 |
| Snapshot | attach 返回 `snapshot` frame，data 为 tail bytes，`start_offset/end_offset` 用于前端去重。 |
| Input | input frame 为 fire-and-forget bytes；不返回 session metadata，不进入普通 request pending map。 |
| Resize | resize frame 只发送最新 cols/rows；不返回 session metadata。 |
| Output | output frame 只携带轻量 session id、project key、offset 与 bytes；React session state 不因 output 更新。 |
| 页面 stream client | 每页按 token 维护一条 terminal stream，上游按 session 复用 attach；同 session 的多个 handle 共享 output。 |

Gateway 的终端连接只维护本连接内的 session attach 集合；detach 只影响这条 terminal stream 的输出投递，不改变桌面端 terminal registry。

## Workspace Activity 协议

Git 面板与文件树不再轮询：桌面端 `workspace_watch` 服务（notify watcher，250ms 去抖，`.git` 内部噪声过滤，changedPaths 封顶 64 + truncated）为每个被观察的 workdir 发出失效信号。

| 层级 | 合同 |
|---|---|
| Desktop 内 | Tauri 事件 `workspace:activity`，payload `{workdir, revision, fs, git, changedPaths, truncated}`；前端经 `workspace_watch_set(workdirs)` 声明式注册本 webview 的观察集合。 |
| Desktop→Gateway | `AgentEnvelope.workspace_activity`（`WorkspaceActivityEvent`，字段 90）。Gateway→Desktop 用 `GatewayEnvelope.workspace_watch`（`WorkspaceWatchRequest`，声明式全量 workdir 集合；订阅计数变化与 agent 重连时重发）。 |
| Browser-Gateway | `/ws/v2` 帧 `workspace_subscribe/workspace_unsubscribe {workdir}`，事件臂 `workspace_activity`。 |
| 语义 | best-effort 失效信号，不保证不丢事件：客户端在（重）订阅、通道重建、revision 回退时必须自标脏并 refetch。revision 为 per-workdir 单调计数（agent 进程内）。 |
| 消费端 | 两端镜像的 `lib/workspace-activity/useWorkspaceInvalidation`：面板隐藏时只置脏、激活时冲刷；数据本体仍走既有 fs/git 拉取命令（invalidate-push + fetch-on-demand）。 |

## Skills 与 Memory 管理协议

| 能力 | 直通请求臂 | Desktop 落点 |
|---|---|---|
| Skills 列表和管理 | `SkillFilesListRequest`、`SkillManageRequest`、`SkillMetadataReadRequest`、`SkillTextReadRequest` | `system_ensure_builtin_skills`、`system_manage_skill`、`system_read_skill_*`、`services/skills.rs` |
| Memory 管理 | `MemoryManageRequest` | `commands/memory.rs`、`services/memory.rs` |
| Cron 管理 | `CronManageRequest` | `commands/cron.rs`、`services/cron.rs`、settings cron 表 |

## 恢复与去重机制

| 机制 | 位置 | 目的 |
|---|---|---|
| `clientRequestId` | WebUI Chat Command -> Gateway session manager | 进程级 24 小时幂等键；并发或单次 ACK 恢复重试返回同一 canonical run。Gateway 重启后不保留。 |
| `conversationId` -> run index | Gateway session manager | 当前会话刷新/切换后可定位正在运行的事件流。 |
| `Seq` | Gateway 进程内 conversation event window / `chat_event` payload | 同 conversation 内单调递增；断线后 `chat_subscribe` 携带 `after_seq` 游标补发窗口内缺失事件，窗口不足时 reset + history hydrate。 |
| 直通关联 id 命名空间 | Gateway v2 relay | 多标签页共享一个桌面端；网关按连接为 `request_id` 加前缀转发、回程剥离，杜绝跨连接冲突。 |
| done retention | Gateway session manager | 已结束 run 短时间保留，支持刷新后看到终态。 |
| local running ids | WebUI App | 避免正在运行会话被错误切换或误删。 |

## 协议改造注意点

| 场景 | 必查点 |
|---|---|
| 新增 Gateway request | 在 `proto/v2/gateway.proto` 加请求/响应臂（编号只增不改）→ `buf generate` → v2 直通白名单（`internal/protocol/pbws/guard.go`）放行 → WebUI client method + adapter；桌面端 `envelope_handler.rs` 增加分支。不再需要 Go 手工 payload 塑形。 |
| 新增本地/编排操作 | `proto/v2/gateway_ws.proto` 加帧臂 → pbws 本地处理器 → 客户端方法。 |
| proto 演进纪律 | CI `buf breaking`（WIRE_JSON）把关；删除字段用 `reserved`；v2 业务消息永不改号、永不弃用。 |
| 新增 settings 字段 | GUI settings normalize/storage、Rust settings save/load、Gateway redaction whitelist、WebUI settings copy 都要同步。 |
| 新增 history 字段 | Rust summary model、proto `ConversationSummary`、GUI/WebUI sidebar render 都要同步。 |
| 新增 chat event | Desktop event publisher、proto enum、Gateway 事件规范化与 `chat_event` payload、WebUI event reducer/transcript 都要同步。 |
| 涉及 secret | 默认不进普通 sync，必须设计单向或显式更新通道。 |
