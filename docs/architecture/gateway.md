# Go Gateway 架构

## 职责边界

Gateway 是远程访问中继，不是 Agent 执行环境。它同时面对桌面 Agent 和浏览器 WebUI，
两端统一走 WebSocket+Protobuf（v2 协议）：

| 方向 | 协议 | 作用 |
|---|---|---|
| Desktop Agent -> Gateway | WebSocket `/ws/v2/agent`（Protobuf 帧） | 桌面端注册在线 session，接收 WebUI 请求（`GatewayEnvelope`），返回 chat/history/settings/memory/skills 等响应与事件（`AgentEnvelope`）。 |
| Desktop/Browser -> Gateway | WebSocket `/ws/v2/terminal`（Protobuf 帧） | 专用终端字节流（角色由 hello 区分），承载 attach snapshot、input、resize、output，不与普通控制面共享队列。 |
| WebUI -> Gateway | WebSocket `/ws/v2`（Protobuf 帧） | 浏览器端发起 chat（command/subscribe）、直通 history/settings/skills/memory/cron 等请求，并订阅 `chat_event` 与同步广播。 |
| WebUI -> Gateway | HTTP `/api/*` | 状态检查、文件上传、公网分享页、图片代理、静态资源。 |

## 入口与服务启动

| 文件 | 作用 |
|---|---|
| `cmd/gateway/main.go` | 读取 config，创建 `session.Manager`，启动 HTTP server，处理 shutdown。 |
| `internal/config/config.go` | 地址、token、TLS、静态资源、请求大小、超时等配置。 |
| `internal/observability/` | slog 初始化与 v2 协议使用计数（`/api/status` 的 `protocol_usage`）。 |
| `internal/transport/wscore/` | WebSocket 连接运行时：控制优先双队列写泵、拥塞掉帧、有限重试、心跳与空闲驱逐。 |
| `internal/protocol/pbws/` | **v2 协议层**：三链路握手/编解码、直通白名单（`guard.go`）、关联 id 命名空间化、事件扇出与快照回放。 |
| `internal/protocol/shared/` | 协议无关的域逻辑：Origin 校验、终端权限门控与响应后处理、终端兴趣跟踪。 |
| `internal/chatcmd/` | chat 命令编排（归一化、探活、投递、启动看门狗）。 |
| `internal/auth/` | HTTP/WS token 校验。 |
| `internal/server/http.go` | HTTP mux、v2 WebSocket 路由、API、静态 WebUI 与 public share route（proto→JSON 塑形见 `proto_json.go`）。 |
| `internal/session/manager.go` | `session.Manager` façade 和核心公开类型（transport 无关）。 |
| `internal/session/manager_state.go` | session registry、sync hub、chat run store 的内部状态定义。 |
| `internal/session/manager_registry.go` | 当前 Agent session、认证快照、per-request stream 注册。 |
| `internal/session/manager_*_sync.go`、`manager_terminal.go`、`conversation_stream.go`、`conversation_ingress.go` | history/settings/terminal sync、进程内 Chat 事件窗口、实时 fan-out、replay 与 command dedupe。 |

## HTTP 路由

| 路由 | 认证 | 说明 |
|---|---|---|
| `GET /ws/v2` | hello token | **v2** WebUI 主链路（Protobuf 帧，子协议 `liveagent.v2.pb`）。 |
| `GET /ws/v2/agent` | hello token | **v2** 桌面端信封流。 |
| `GET /ws/v2/terminal` | hello token | **v2** 终端数据面（两端共用，角色在 hello）。 |
| `GET /api/status` | token | Agent 在线状态 + `protocol_usage` 协议使用计数。 |
| `POST /api/files/import` | token | WebUI 上传可读文件，Gateway 转发给桌面端写入 `~/.liveagent/uploads` 暂存区。 |
| `GET /api/public/history-shares/{token}` | public token | 公开只读历史分享数据。 |
| `GET /image-proxy` | 视配置/实现而定 | 图片代理，带 URL 安全校验。 |
| `/` | 无或按静态资源策略 | 嵌入/构建后的 WebUI 静态资源与 SPA fallback。 |

Chat 走 `/ws/v2` 且是严格新协议：`chat_prepare` 用关联 Ping/Pong 探测并唤醒桌面 Chat Runtime；`chat_command` 携带 proto `ChatCommandRequest`，`chat_subscribe` 按 `conversation_id` 订阅。旧 HTTP SSE 路由 `GET /api/chat/events` 已下线。

## Proto 定义与代码生成

`proto/v2/gateway.proto` 是三端共享的权威业务消息定义，`proto/v2/gateway_ws.proto` 定义 WebSocket 帧壳；Go 统一生成于 `internal/proto/v2/*`。代码生成统一由 `buf` 驱动（`make proto`），CI 有生成物漂移与 breaking 检查门禁。

## Session Manager

`session.Manager` 是 Gateway 状态 façade，对外维持原有 API；内部按职责拆成 session registry、sync hub 和 chat run store，避免一个锁覆盖所有状态。

| 状态 | 说明 |
|---|---|
| session registry | 当前桌面 Agent session、认证快照、session epoch、per-request stream。 |
| sync hub | history/settings/terminal 订阅者、settings 快照、terminal session snapshot。 |
| conversation stream store | 当前进程内按 conversation 维护单调 `seq`、`stream_epoch`、活动 run、最近事件窗口与 subscriber；负责实时 fan-out 和短时 replay。 |
| chat command dedupe | 当前进程内原子维护 `client_request_id -> canonical run`，保留 24 小时，并保存最新 `bound`/`queued_in_gui`/`failed` update 供 ACK 丢失后的重试连接 replay。 |

## Chat 事件窗口与恢复

| 机制 | 当前含义 |
|---|---|
| 有界内存窗口 | 每个 conversation 默认保留最近 10 分钟事件，硬上限 4096 条或约 8 MiB；活动 run 在未触及硬上限时不会因时间淘汰，空闲 conversation 约 30 分钟后回收。 |
| `Seq` / `stream_epoch` | 同一 Gateway 进程内，`seq` 按 conversation 单调递增并跨 run；WebUI 用 `after_seq` 补收窗口内事件。epoch 不同、游标超前或事件已淘汰时返回 `reset`，客户端改用桌面历史 snapshot 重建。 |
| command 幂等 | `StartChatCommand` 在同一 store mutex 下原子分配 canonical run；同一 `client_request_id` 的并发或重试提交返回同一 `run_id`，不会重复 seed 或 dispatch。记录保留 24 小时。 |
| command update replay | Gateway 保存 canonical run 最新的 `bound`、`queued_in_gui` 或 `failed` update；WebUI ACK 丢失后重连并以同 ID 重试时，不会错过 pre-stream 结果。 |
| 进程重启边界 | Chat 事件窗口与 command dedupe 都不跨 Gateway 进程持久化。Gateway 重启后由 WebUI history snapshot 与桌面端 run ledger/status republish 重新对账；跨重启不承诺 exactly-once。 |

## WebSocket 协议角色

| 类型 | 说明 |
|---|---|
| request/response | WebUI 发带 id 的 request，Gateway 返回同 id response 或 error。 |
| broadcast | Gateway 主动推送 `status`、`history.event`、`settings.event`、`terminal`、`sftp` 等非 Chat 同步事件。 |
| chat prepare | `chat.prepare` 向当前 `AgentConnect` stream 发送带 `chat-runtime-wake-` request id 的 Ping；桌面 Rust emit WebView wake 并可靠返回关联 Pong，Gateway 收到真实往返后才响应，并记录绑定当前 session epoch 的短时新鲜度。 |
| chat command | 提交/编辑/取消走 WS `chat.command`；新 command 在 accepted 前必须有原生往返 probe，紧随成功 prepare 的 command 可复用同一 session 2 秒内的新鲜结果，旧客户端或过期结果仍现场探测。accepted ACK 走控制优先队列，避免被 token 数据积压阻塞。流式事件走按 conversation 持久订阅 `chat.subscribe`， 订阅与退订均按 `(agent_id, conversation_id)` 作用域并要求非空 `agent_id`，经 `chat.event` 推送（订阅缓冲溢出时发 `chat.subscription_reset` 提示客户端按游标重订阅）。 |
| terminal stream | 不走主链路 request；attach/input/resize/detach 走 `/ws/v2/terminal` proto frame，页面侧 `BrowserGatewayTerminalStreamClient` 为同一 token 复用一条 terminal stream 并按 session fan-out。 |

WebSocket server 的实现分层：`internal/transport/wscore` 管写泵/背压/心跳；协议层在 `internal/protocol/pbws`（帧编解码、直通白名单、事件扇出）。域逻辑（终端门控/响应后处理、chat 编排）在 `internal/protocol/shared` 与 `internal/chatcmd`。

Terminal metadata 事件通过 `/ws/v2` 广播臂（`terminal_event`）同步 `created`、`exit`、`closed`、`renamed`、SSH prompt 和 SSH tab 状态；terminal output 不进入 React session state，也不附带完整 session。输出 bytes 只通过 `/ws/v2/terminal` 推送，慢客户端只阻塞自己的 terminal stream。

## 安全模型

| 领域 | 设计 |
|---|---|
| 认证 | HTTP API 通过 Bearer token；WebSocket 通过 hello token（辅以 Origin 校验）。 |
| Chat command 防护 | Chat 命令仅经认证后的 WebSocket `chat.command` 提交（连接级 token + Origin 校验，2 MiB payload 上限）；accepted 前必须完成当前原生 stream 的关联 Ping/Pong。 |
| Chat 订阅防护 | `chat.subscribe` 仅在认证后的 `/ws/v2` 连接上可用；每个 conversation 的 replay 受 4096 条与约 8 MiB 事件窗口硬上限保护。 |
| Provider API key | 普通 settings sync 不应携带真实 key；WebUI 只接收 presence/redacted 字段。 |
| 文件访问 | WebUI 上传只把 bytes 交给桌面端导入，Gateway 不直接落地为任意本地路径。 |
| 工具执行 | Gateway 不运行 Shell、FS、MCP、Memory mutation 等高权限工具，只转发请求到桌面端。 |
| Public share | 分享数据走 token 定位，支持只读 transcript，并可按设置 redaction tool content。 |
| Public share error | 桌面端通过 `ErrorResponse.code` 返回 `history_share_resolve` 错误语义，Gateway HTTP 根据 code 映射 400/404/502 等状态，不再依赖错误文案判断。 |

## Gateway 失败模式

| 失败 | 表现 | 设计处理 |
|---|---|---|
| Desktop offline | WebUI 请求返回 agent offline 或状态 offline | `session.Manager` 检测当前 session，WebUI 展示离线/不可用状态。 |
| WebSocket 断开 | WebUI 自动重连；Chat 订阅按 `after_seq` 游标恢复 | `GatewayWebSocketClient` 统一管理重连并在重连后重发 `chat.subscribe`，Gateway 从当前进程的有界事件窗口补发；窗口不足时返回 reset，由桌面历史 snapshot 重建。 |
| 桌面端信封流断开 | Agent session close，pending stream 结束 | 桌面端 remote auto reconnect 可重新建立 session；重连后桌面端 republish chat run 台账（active `started` + 未确认终态控制事件），网关幂等收养。 |
| 长时间空闲后首发 | socket、信封流或 WebView runtime 可能半开/休眠 | `chat.prepare` 在默认 2 秒内完成关联原生 Ping/Pong，紧随 command 复用 session-bound 新鲜结果；没有新鲜结果时 command 自行 probe。失败立即返回而不把命令错误标记为 accepted。 |
| Chat run 终态信号丢失 | run 已在桌面端结束但网关 activity 未清除 | 桌面端 `ChatRunLedger` 先记账再发送，5s sweeper 重发未送达终态；心跳 `RuntimeStatusEvent.active_runs/finished_runs` 驱动网关对账：finished 报告按真实终态收养，active 报告逐 run 续命，缺席且无事件/续命超过 `runReportLostTimeout`（15s）判 `failed/desktop_run_lost`。 |
| Chat run 卡死兜底 | 桌面端不再上报某 run | 在线走 `staleRunTimeout`（10min，逐 run 续命，单会话忙碌不屏蔽他会话）；离线走 `offlineRunTimeout`（30min）判 `failed/agent_offline`。 |
| Chat run 重复提交 | 同一 Gateway 进程内，同一 `client_request_id` 重复 | 24 小时进程级原子去重返回 canonical run；用于覆盖 WebSocket ACK 丢失的一次同 ID 重试。 |
| Chat command 未进入运行态 | 事件流只到 accepted/delivered 后不继续 | command path 使用默认 5 秒 `LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT` 加 10 秒 `LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT` watchdog 写入 `run.failed`，避免 WebUI 无限等待。 |
| 服务退出 | Ctrl+C 后 HTTP graceful shutdown | `cmd/gateway/main.go` 控制退出与超时。 |
