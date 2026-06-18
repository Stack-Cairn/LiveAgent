# Go Gateway 架构

## 职责边界

Gateway 是远程访问中继，不是 Agent 执行环境。它同时面对桌面 Agent 和浏览器 WebUI：

| 方向 | 协议 | 作用 |
|---|---|---|
| Desktop Agent -> Gateway | gRPC `AgentGateway.AgentConnect` 双向流 | 桌面端注册在线 session，接收 WebUI 请求，返回 chat/history/settings/memory/skills 等响应与事件。 |
| WebUI -> Gateway | WebSocket `/ws` | 浏览器端发起 history、settings、skills、memory、cron 等非 Chat request，并订阅同步广播。 |
| WebUI -> Gateway | HTTP `/api/*` | Chat command/SSE、状态检查、文件上传、公网分享页、图片代理、静态资源。 |

## 入口与服务启动

| 文件 | 作用 |
|---|---|
| `cmd/gateway/main.go` | 读取 config，创建 `session.Manager`，启动 gRPC server 与 HTTP server，处理 shutdown。 |
| `cmd/gateway/shutdown.go` | gRPC graceful stop 超时后强制 stop。 |
| `internal/config/config.go` | 地址、token、TLS、静态资源、请求大小、超时等配置。 |
| `internal/auth/grpc_interceptor.go` | gRPC token 校验。 |
| `internal/auth/http_middleware.go` | HTTP API token 校验。 |
| `internal/server/grpc.go` | `AgentGateway` gRPC 服务实现。 |
| `internal/server/http.go` | HTTP mux、WebSocket、API、静态 WebUI 与 public share route。 |
| `internal/server/http_chat.go`、`chat_commands.go`、`chat_payloads.go` | Chat Command HTTP 入口、SSE replay、Gateway -> Desktop `ChatCommandRequest` 下发与事件 payload 映射。 |
| `internal/server/websocket.go` | WebUI WebSocket 连接生命周期、鉴权、订阅 forwarder。 |
| `internal/server/websocket_routes.go` | WebSocket request type 到 domain handler 的路由表。 |
| `internal/server/websocket_*_handlers.go` | fs/history/settings/terminal/git/skills/memory/cron/provider 等非 Chat domain handler。 |
| `internal/server/websocket_payloads.go` | WebSocket 响应 payload 组装与 JSON helper。 |
| `internal/server/websocket_roundtrip.go` | payload 严格解码、Agent unary round-trip 和错误文案归一。 |
| `internal/server/websocket_writer.go` | WebSocket 并发写锁、write deadline 与 envelope 发送。 |
| `internal/server/websocket_connection_state.go` | 单条 WebSocket 连接内的 terminal interest 状态。 |
| `internal/session/manager.go` | `session.Manager` façade 和核心公开类型。 |
| `internal/session/manager_state.go` | session registry、sync hub、chat run store 的内部状态定义。 |
| `internal/session/manager_registry.go` | 当前 Agent session、认证快照、per-request stream 注册。 |
| `internal/session/manager_*_sync.go`、`manager_terminal.go`、`manager_chat_runs.go`、`sqlite_chat_event_store.go` | history/settings/terminal sync、Chat Event Store、实时 fan-out、replay 与 command dedupe。 |

## HTTP 路由

| 路由 | 认证 | 说明 |
|---|---|---|
| `GET /ws` | token | WebUI 主 WebSocket 协议。 |
| `POST /api/chat/commands` | token + CSRF + Origin | WebUI 提交 `chat.submit`、`chat.edit_resend`、`chat.cancel`。 |
| `GET /api/chat/events` | token + Origin | WebUI 使用 fetch SSE 订阅/恢复 Chat 事件。 |
| `GET /api/status` | token | Gateway 当前 Agent 在线状态。 |
| `POST /api/files/import` | token | WebUI 上传可读文件，Gateway 转发给桌面端导入 workspace uploads。 |
| `GET /api/public/history-shares/{token}` | public token | 公开只读历史分享数据。 |
| `GET /image-proxy` | 视配置/实现而定 | 图片代理，带 URL 安全校验。 |
| `/` | 无或按静态资源策略 | 嵌入/构建后的 WebUI 静态资源与 SPA fallback。 |

Chat HTTP API 是严格新协议：command 必须是 `{ type, payload }` envelope，事件订阅使用 `run_id` 或 `conversation_id`，不接受旧 `command` 字段、顶层裸 payload 或 `request_id` 查询别名。

## gRPC 服务

| RPC | 类型 | 用途 |
|---|---|---|
| `Authenticate(AuthRequest) -> AuthResponse` | unary | 桌面端认证探活，返回 session 信息。 |
| `AgentConnect(stream AgentEnvelope) -> stream GatewayEnvelope` | bidirectional stream | 桌面端常驻连接，WebUI request 下发为 `GatewayEnvelope`，桌面端 response/event 回传为 `AgentEnvelope`。 |

`proto/v1/gateway.proto` 是 Desktop 与 Gateway 的权威协议定义；Go 侧生成文件位于 `internal/proto/v1/*`。

## Session Manager

`session.Manager` 是 Gateway 状态 façade，对外维持原有 API；内部按职责拆成 session registry、sync hub 和 chat run store，避免一个锁覆盖所有状态。

| 状态 | 说明 |
|---|---|
| session registry | 当前桌面 Agent session、认证快照、session epoch、per-request stream。 |
| sync hub | history/settings/terminal 订阅者、settings 快照、terminal session snapshot。 |
| chat event store | SQLite `chat_runs`、`chat_command_dedup`、`chat_events`；负责 command 幂等、seq replay、Gateway 重启后的终态恢复。 |
| chat run memory cache | 当前进程内的 subscriber、requestId/conversationId/clientRequestId 索引和最近事件窗口；只服务实时 fan-out，不是唯一真相源。 |

## Chat Event Store 与恢复

| 机制 | 当前含义 |
|---|---|
| SQLite WAL | Gateway 启动时打开 `LIVEAGENT_GATEWAY_CHAT_EVENT_STORE` 指定的 SQLite 文件，启用 WAL、`busy_timeout` 和小事务追加；事件先提交到内存 fan-out，再用不可变快照持久化，避免 SQLite I/O 占用 chat 内存锁。 |
| `chat_runs` | 保存 run 元数据、最新 seq、state、error_code、done、workdir、conversation/client request 索引字段。 |
| `chat_command_dedup` | 以 `client_request_id` 为主键，重复 command 返回原 run，不重复追加用户消息。 |
| `chat_events` | append-only 事件日志，按 `(run_id, seq)` 唯一；同一 `conversation_id` 内的 `seq` 单调递增，SSE replay 优先读它。`chat.edit_resend` 的 `conversation.rebased` 与新 `user.message.appended` 使用同一批 SQLite 事务写入。 |
| `maxBufferedChatRunEvents` | 单次 replay / 进程内最近事件窗口最多 50000 条，避免无界内存和超大 replay。 |
| 重启恢复 | Gateway 启动时把未完成 run 标为 `failed/gateway_restarted` 并追加终态事件，避免客户端永久等待失联运行。 |
| `Seq` | WebUI 可用 `afterSeq`/`Last-Event-ID` 从 SQLite 事件日志补收漏掉的事件；新 run 会从同 conversation 已有最大 seq 后继续，避免编辑重发/二次提交时恢复游标撞序。 |

## WebSocket 协议角色

| 类型 | 说明 |
|---|---|
| request/response | WebUI 发带 id 的 request，Gateway 返回同 id response 或 error。 |
| broadcast | Gateway 主动推送 `status`、`history.event`、`settings.event`、`terminal`、`sftp` 等非 Chat 同步事件。 |
| chat | 不再走 WebSocket request；提交/编辑/取消走 HTTP command，流式事件走 fetch SSE。 |

WebSocket server 的实现按三层组织：`websocket.go` 管连接生命周期和订阅 forwarder；`websocket_routes.go` 管 request 路由；`websocket_*_handlers.go` 管 domain handler。handler 只做 payload 校验、调用 Gateway/Desktop service、组装 WebUI 响应。连接内的可变状态不再直接铺在 `websocketConnection` 上，而是通过 terminal tracker 管理。

Terminal event 的转发规则保持与 WebUI SharedWorker 一致：metadata 类事件用于同步 session/project 状态，可广播到已认证连接；`output` 事件必须先通过 `terminal.attach` 记录 session interest 后才转发，`terminal.detach` 会移除该 session interest。

## 安全模型

| 领域 | 设计 |
|---|---|
| 认证 | HTTP API 与 WebSocket 通过 token；gRPC 通过 interceptor 校验 token。 |
| Chat command 防护 | `POST /api/chat/commands` 要求 token、Origin 校验、`X-LiveAgent-CSRF`、2 MiB payload 上限和固定窗口 rate limit。 |
| Chat SSE 防护 | `GET /api/chat/events` 要求 token、Origin 校验、固定窗口 rate limit；replay 单次最多返回 `maxBufferedChatRunEvents` 条。 |
| Provider API key | 普通 settings sync 不应携带真实 key；WebUI 只接收 presence/redacted 字段。 |
| 文件访问 | WebUI 上传只把 bytes 交给桌面端导入，Gateway 不直接落地为任意本地路径。 |
| 工具执行 | Gateway 不运行 Shell、FS、MCP、Memory mutation 等高权限工具，只转发请求到桌面端。 |
| Public share | 分享数据走 token 定位，支持只读 transcript，并可按设置 redaction tool content。 |
| Public share error | 桌面端通过 `ErrorResponse.code` 返回 `history_share_resolve` 错误语义，Gateway HTTP 根据 code 映射 400/404/502 等状态，不再依赖错误文案判断。 |

## Gateway 失败模式

| 失败 | 表现 | 设计处理 |
|---|---|---|
| Desktop offline | WebUI 请求返回 agent offline 或状态 offline | `session.Manager` 检测当前 session，WebUI 展示离线/不可用状态。 |
| WebSocket 断开 | WebUI 自动重连非 Chat 同步；Chat SSE 可按 seq 恢复 | `GatewayWebSocketClient`、SharedWorker 与 fetch SSE client 分别管理重连，Gateway 从 SQLite `chat_events` 补发 seq event。 |
| gRPC stream 断开 | Agent session close，pending stream 结束 | 桌面端 remote auto reconnect 可重新建立 session。 |
| Chat run 重复提交 | 同一 clientRequestId 重复 | SQLite `chat_command_dedup` 去重，内存索引只是热缓存。 |
| Chat command 未进入运行态 | 事件流只到 accepted/delivered 后不继续 | HTTP command path 使用 `LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT` 与 `LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT` watchdog 写入 `run.failed`，避免 WebUI 无限等待。 |
| 服务退出 | Ctrl+C 后 HTTP/gRPC shutdown | `cmd/gateway/main.go` 和 `shutdown.go` 控制 graceful/force stop。 |
