# 协议：JSON over HTTP + WS

自 v2 起，线上协议只有一种：**JSON**。protobuf、buf 工具链、`proto/v2` 全部删除
（决策 6）。契约不再需要代码生成，也就不再有生成物漂移门禁。

权威定义就是代码本身：`crates/backend/src/routes.rs`（响应形状）、
`routes_gen.rs`（命令路由，由 `scripts/generate-routes.mjs` 生成）、
`ws.rs`（事件帧）、`engine_proxy.rs`（引擎代理与事件回流）。

## 端点总览

| 端点 | 方法 | 认证 | 用途 |
|---|---|---|---|
| `/healthz` | GET | **无** | 探活。只回 `ok`，不泄露任何信息 |
| `/api/<command>` | POST | Bearer | 176 条命令路由，1:1 对应 `#[tauri::command]` |
| `/api/events` | GET（WS） | `?token=` | 事件流，单向下行 |
| `/api/chat_send` | POST | Bearer | 反代到 Node 引擎 |
| `/api/chat_abort` | POST | Bearer | 反代到 Node 引擎 |
| `/api/conversation_live` | GET | Bearer | 反代到 Node 引擎，取内存快照 |
| `/api/tool_approval_request` | POST | Bearer | Node 发起审批，长挂起 |
| `/api/tool_approval_respond` | POST | Bearer | 前端应答审批 |
| `/api/engine_emit_event` | POST | **仅**内部 token | 引擎事件回流到 EventBus |

`/healthz` 故意放在认证之外——探活要密码的话容器编排拿不到健康状态。

## 认证

密码**直接**当 Bearer token（决策 7）。没有 JWT、没有 session，整个系统一把钥匙。

```http
POST /api/git_status HTTP/1.1
Authorization: Bearer <password>
Content-Type: application/json

{"workdir": "/path/to/repo"}
```

| 事项 | 约定 |
|---|---|
| 比较方式 | 常量时间（`subtle::ConstantTimeEq`）；长度不等时跟自己比，耗时只取决于存储值长度 |
| 失败响应 | 缺 header、格式错、密码错**都是同一个 401**，不区分 |
| scheme | `Bearer` 大小写不敏感 |
| 两把钥匙 | 用户密码 → `CallerIdentity::User`；内部 token → `CallerIdentity::Internal`。后者只发给 Node 引擎，`engine_emit_event` 只认它，别的身份一律 403 |
| WebSocket | 浏览器 WebSocket API 设不了 header，所以 `/api/events` 用 `?token=` 做等价校验 |
| CORS | permissive。认证是 Bearer 而非 cookie/同源，放开不引入新攻击面 |

## 命令路由：命令式，不做 REST 化

```text
invoke("git_status", { workdir })   →   POST /api/git_status   { "workdir": "..." }
```

| 规则 | 说明 |
|---|---|
| 路径 | `/api/` + command 名，逐字一致 |
| body | 参数对象，key **就是** `#[tauri::command]` 的参数名 |
| 无参命令 | 发 `{}`，后端按无字段结构体反序列化 |
| 成功 | `200 {"ok": <返回值>}` |
| 业务失败 | `400 {"error": <原样序列化的错误值>}` |
| 服务端故障 | 500 留给 panic 和序列化失败 |

**为什么包一层 `ok`**：一部分命令返回 `()`，裸放会得到 `null`，与「真的返回了
null」分不开。包一层让 200 永远是一个对象。

**为什么错误不 stringify**：多数命令的错误是 `String`，但 `fs_*` 返回结构化的
`FsCommandError`（`code` / `path` / `didYouMean`），前端在读这些字段。转成字符串
等于把它们扔掉。

**为什么只有 200/400 两档**：与 Tauri IPC 语义一致——命令返回 `Err` 就是「这次做
不到」（路径不存在、参数不合法、不是 git 仓库），不是服务端崩了。补细 404/403
需要逐个命令审计错误来源，收益不抵成本。

**为什么不 REST 化**：前端现在就在用这些命令名和参数对象。1:1 映射让迁移是机械
替换；REST 化等于做 176 次独立设计决策，每次都是一个破坏前端的机会。这是消除
特殊情况，不是制造 176 个。

`rename_all` **逐命令**沿用 Tauri 现状，不统一：写了 `snake_case` 的用
snake_case，没写的用 camelCase（Tauri 默认）。已知不一致的有
`git_clone_repository_tasks`、`chat_history_replace_from_message`。统一它们就是
破坏前端。

参数提取不用 `axum::Json`：它的提取失败是 422/415 纯文本，违反「所有失败都是
400 + `{error}`」的契约。`crate::json::Json` 把这些折进同一形状。

### 路由生成与漂移门禁

| 命令 | 作用 |
|---|---|
| `make update-routes` | 从 `crates/frontend/src-tauri/src/tauri_commands/*.rs` 重新生成 `routes_gen.rs` |
| `make check-routes` | 校验一致性，漂移即失败（CI 用） |

另有契约测试拿 `routes::routed_commands()` 与 backend 导出的命令清单比对：
**新增 command 未加路由必须导致测试失败**。

> 「路由可达」≠「命令可用」。契约测试把 400 也算通过（空 body 反序列化失败是正常
> 的），于是「路由挂上了但底层没初始化」能骗过它——实测抓到过漏
> `initialize_history_db()`、漏 `TunnelStore::initialize()` 两例。所以另有一组
> 带**真实参数**、必须 200 且带 `ok` 的用例。

## 事件流（`/api/events`）

单向下行，客户端发来的消息一律忽略。帧格式：

```json
{"event": "terminal:event", "payload": { ... }}
```

| 事项 | 约定 |
|---|---|
| 传输 | 文本帧，一帧一条 JSON |
| 队列 | 服务端 `broadcast` channel，容量 256（约 2–3 秒缓冲） |
| 背压 | **队列满丢最旧帧**，不阻塞业务线程。慢客户端不能拖住 agent 逻辑 |
| Lagged | 客户端错过被挤掉的帧时**继续**，不断连 |
| 多客户端 | 一个后端支持多前端同时连（决策 9），每连接一个订阅者 |
| 重连 | **不补发**（决策 19）。客户端自己拉快照再订阅增量 |

**没有 `seq`、没有 `after_seq`、没有 replay buffer。** 这是有意的：旧 Go 中继里
约 3,800 行代码专门在给「引擎跑在一个会睡着的浏览器标签页里」擦屁股，引擎搬到
后端之后这些机制失去存在理由。前端重连后重新拉一次快照，比维护一套跨进程的
事件窗口简单得多。

前端侧：`src/lib/backend/transport.ts` 全局只维护**一条** WS，按事件名分发给
订阅者；断线以 500ms 起指数退避重连、上限 10s，且全局只允许一个待触发定时器
（订阅者有十几个，不去重的话退避链会成倍增长）。

### 事件来源分流

桌面壳内嵌的 `backend` 是**另一个** EventBus 实例，所以「壳发的」和
「后端发的」两组事件名**互不相交**，按名字分流是确定的：

| 来源 | 事件 | 通道 |
|---|---|---|
| Tauri 壳 | `app:action`、`app:action-feedback`、`terminal:exit-requested`、`global-shortcut:*`、`tauri://*` | IPC |
| 后端 | `terminal:event`、`terminal:stream`、`sftp:event`、`tunnel:state`、`workspace:activity`、`token_delta`、`run_ended`、`tool-approval:request`、`engine:crashed` … | WS |

判定在 `src/lib/backend/commandRouting.ts::isShellEvent()`。

## Chat 协议

Chat 是唯一不落在 `backend` 上的能力——它在 Node 引擎里。Rust 反向代理三条
路由，剥掉 `/api` 前缀转发到 `http://127.0.0.1:<node_port>`，并补上内部 token。

| 步骤 | 请求 | 响应 |
|---|---|---|
| 提交 | `POST /api/chat_send` `{conversationId, text, clientRequestId?, mode?, sessionId?, workdir?, skillsEnabled?, selectedModel?, selectedSkillNames?}` | `202 {"ok": {accepted: true, duplicate?: true}}` |
| 取消 | `POST /api/chat_abort` `{conversationId}` | `200 {"ok": {aborted: bool}}` |
| 快照 | `GET /api/conversation_live?conversationId=…` | `200 {"ok": {conversationId, isRunning, live, messageCount}}` / `404` |
| 引擎未起 | 任一条 | `503 {"error": "引擎未启动"}` |

**受理即回 202**：增量与终态全走事件广播，不在 HTTP 响应里。`clientRequestId`
在引擎进程内按会话去重，重复提交返回 `duplicate: true` 而不是跑第二遍。

`conversation_live` 返回 404 表示**引擎内存里没有**，不等于会话不存在——可能只是
本进程还没跑过它的 turn。前端应把 404 当作「无 live 增量」，基线走历史接口。
快照源必须是引擎内存态：`runAgentConversationTurn` 只在函数末尾落一次库，
turn 中读库读不到正在生成的半条消息。

### Chat 事件

引擎经 `POST /api/engine_emit_event {event, payload}` 把事件打回 Rust，Rust
直接广播到 EventBus，前端从 `/api/events` 收到。载荷里的会话标识是
`conversation_id`（下划线）。

| 事件 | payload | 前端处置 |
|---|---|---|
| `token_delta` | `{conversation_id, delta}` | 追加到草稿助手文本 |
| `tool_status_change` | `{conversation_id, status, isCompaction, retryAttempts}` | 更新工具状态行 |
| `chat:run-event` | `{conversation_id, ...event}` | 其余 wire 事件原样打包（工具调用/结果/思考/检查点等） |
| `chat:compaction-status` | `{conversation_id, status}` | 压缩进度 |
| `chat:hook-warning` | `{conversation_id, warning}` | hook 告警 |
| `run_ended` | `{conversation_id, state, errorMessage?}` | 落定 transcript。`state` ∈ `completed` / `failed` / `cancelled` |
| `engine:crashed` | `{timestamp_ms, reason}` | Node 进程退出，Rust 守护发出 |

### 工具审批：唯一的反向往返

引擎搬到后端后，后端要**主动**向前端发起请求并等回答，而前端可能没连着。
这是全系统唯一一处后端等前端的地方：

```text
Node 引擎                Rust 后端                    前端
   │                        │                           │
   │ POST /api/tool_approval_request                    │
   │  {conversation_id, tool_call_id, tool_name,        │
   │   summary, recommended?, timeout_ms?}              │
   ├───────────────────────►│                           │
   │                        │ emit "tool-approval:request"
   │                        │  {approval_id, ..., timeout_ms}
   │                        ├──────── WS ──────────────►│
   │                        │                           │ 用户点击
   │                        │  POST /api/tool_approval_respond
   │                        │◄──────────────────────────┤
   │                        │   {approval_id, decision}  │
   │◄───────────────────────┤                           │
   │  200 {"ok": {decision}} │                          │
```

| 事项 | 约定 |
|---|---|
| `decision` | `approve` / `deny` / `approve_session` |
| 挂起时长 | Node 传 `timeout_ms`，缺省兜底 60s。**超时权威在后端** |
| 倒计时 | `timeout_ms` 一并广播给前端，前端用它算倒计时，不自设窗口 |
| 前端不在场 | 按决策 10，超时即按 `recommended` 或默认决策走，不阻塞主流程 |
| 重复应答 | `409 {"error": "AlreadyAnswered"}`——这是 200/400 之外唯一的例外状态码 |
| 无效 decision | 400 |

## Rust ⇄ Node

Node 只监听 `127.0.0.1`，端口由 Rust 在启动时 `bind :0` 选定并经环境变量注入。

| 变量 | 含义 |
|---|---|
| `LIVEAGENT_NODE_PORT` | Node 自己监听的端口 |
| `LIVEAGENT_BACKEND_PORT` | Rust 后端端口，Node 回调用 |
| `LIVEAGENT_INTERNAL_TOKEN` | 双向认证的内部 token |

Node 打回 Rust 走的是**同一套** `/api/<command>`（决策 13），只是 Bearer 换成内部
token（`src/backendClient.ts`）。所以引擎执行 `fs_read_text` 和前端点开文件树
执行 `fs_read_text` 是同一个函数、同一套参数、同一种错误。

进程守护（`engine_process.rs`）：spawn → `GET /healthz` 就绪探测（30s 上限）→
通过后才写 `node_port` 状态。Node 退出时广播 `engine:crashed`，指数退避重启
（1s 起，上限 30s，连续健康 60s 后重置），**重启后端口会变**。按决策 5 不自动
重跑对话，只标记失败和广播终态。

## TLS 与部署形态

| 形态 | 配置 |
|---|---|
| 内建 TLS | `--tls-cert <pem> --tls-key <pem>`，走 `axum_server::bind_rustls` |
| 反代 | 不给证书参数，明文监听，由 nginx/Caddy/平台终结 TLS |
| 桌面壳内嵌 | 明文，只监听 `127.0.0.1` |

两种都支持（决策 14）。浏览器端 `secure` 标志决定用 `https`/`wss` 还是
`http`/`ws`，默认跟随页面协议。

## 协议改造注意点

| 场景 | 必查点 |
|---|---|
| 新增后端 command | 在 `src-tauri/src/tauri_commands/*.rs` 加 `#[tauri::command]` → `make update-routes` → 提交生成的 `routes_gen.rs`。**前端分流表不用改**（反向白名单） |
| 新增壳专属 command | 加进 `commandRouting.ts::SHELL_ONLY_COMMANDS` 和 `docs/architecture/command-classes/frontend.txt`，否则会被当成后端命令打到网络上 |
| 新增事件 | 发布方 emit → 前端订阅。若发布方是壳，还要加进 `isShellEvent()` |
| 新增 chat 事件 | 引擎 `emitEvent()` → 前端 `useBackendEventSubscription` 加分支。payload 必须带 `conversation_id`，否则前端路由不到会话 |
| 改命令参数名 | 参数名**就是** JSON key，改名即破坏前端。`rename_all` 也一样 |
| 涉及 secret | 密钥现在只在后端。前端不再持有 provider key，也就不需要脱敏快照那一套 |
| 新增出网调用 | 过 `ssrf.rs` 的校验，别绕开 |

## 相关文档

- [overview.md](overview.md) —— 三层结构与进程边界
- [frontend.md](frontend.md) —— 前端如何消费这些协议
- [migration/phase-2-backend.md](migration/phase-2-backend.md) —— 路由层怎么造出来的
- [migration/phase-4-frontend.md](migration/phase-4-frontend.md) —— 前端网络化与遗留事项
