# LiveAgent 总体架构

## 一句话

一个 **Rust 后端** 持有全部本地能力和唯一的网络入口，一个 **Node 引擎** 跑对话循环，
一份 **前端代码** 通过 HTTP + WebSocket 连上去——不管它跑在 Tauri 桌面壳里还是浏览器里。

「本地」和「远程」不再是两条代码路径，只是端点地址不同。

## 三层结构

| 层 | 路径 | 技术栈 | 职责 |
|---|---|---|---|
| 前端 | `crates/frontend/src` | React、TypeScript、Vite、Tailwind | Chat、Settings、Skills/MCP Hub、Memory、终端、Git、历史。**只经网络与后端通信。** |
| 桌面壳（可选） | `crates/frontend/src-tauri` | Tauri 2、Rust | 托盘、窗口、自更新、原生对话框、剪贴板；并在进程内启动后端。19 个壳专属 command。 |
| Rust 后端 | `crates/backend` | axum、tokio、rusqlite | 唯一对外网络入口（HTTP + WS）、认证、TLS；fs/shell/git/terminal PTY/sftp/sqlite/cron/mcp/memory/tunnel 的实现。 |
| chat 引擎 | `pi` CLI（外部程序） | `pi --mode rpc` | 对话循环：上下文构造、模型流式、工具执行、压缩。后端按会话把它作为**子进程**拉起，走 stdin/stdout 的 JSONL RPC，不监听任何端口。翻译层在 `crates/backend/src/pi/`。 |

浏览器形态下「桌面壳」这一层不存在，其余三层不变——这正是决策 16 要的效果。

## 进程与连接

```text
┌─ 前端（一份代码，两种宿主）────────────────────┐
│  Tauri WebView          或        浏览器标签页   │
│  lib/backend/transport.ts:  fetch + WebSocket    │
└───────────────┬──────────────────────────────────┘
                │  HTTP  POST /api/<command>   Bearer <password>
                │  WS    GET  /api/events?token=<password>
                ▼
┌─ Rust 后端（backend，唯一对外入口）───────┐
│  routes_gen.rs  176 条命令路由 → backend      │
│  ws.rs          EventBus → broadcast → WS        │
│  engine_proxy.rs  chat_* 反代 → Node             │
│  auth.rs / tls.rs / ssrf.rs                      │
└───────────────┬──────────────────────────────────┘
                │  loopback，内部 token
                │  Rust→Node: POST /chat_send /chat_abort, GET /conversation_live
                │  Node→Rust: POST /api/<command>, POST /api/engine_emit_event
                ▼
┌─ Node 引擎（core，127.0.0.1:<随机端口>）┐
│  engine.ts  runOneTurn：模型流式 + 工具循环      │
│  工具落到 callBackend() → 打回 Rust 的同一批命令 │
└──────────────────────────────────────────────────┘
```

**一套 API，两类客户端。** 前端和 Node 引擎打的是同一批路由、调的是 `backend`
里同一批函数，所以工具行为不可能两边不一致——这是取消 Go 中继的直接收益。

## 两种运行形态

| | 桌面壳内嵌 | 独立后端 |
|---|---|---|
| 后端从哪来 | Tauri `.setup()` 里 `start_backend_server()` 起在同进程（`src-tauri/src/backend_server.rs`） | `backend --port 8443` |
| 监听地址 | `127.0.0.1:<系统分配的空闲端口>` | `0.0.0.0:<--port>` |
| 密码 | 每次启动随机生成，前端经 `get_backend_endpoint` 拿到 | `--password`，不给则随机生成并打到 stderr |
| 登录页 | 跳过（壳注入端点） | 浏览器输入 host/port/密码，或用 `?backendHost=&backendPort=&token=` 链接 |
| 退出 | 壳退出即带走后端与全部 pi 子进程（决策 11） | SIGTERM/SIGINT → 收掉全部 pi 会话进程 |

两者**不能同机并跑**：它们共用同一个 `~/.liveagent` 数据目录。

## 前端如何区分宿主

前端只有一份代码，靠**运行时探测**降级，不靠构建分叉：

| 判定 | 位置 | 用途 |
|---|---|---|
| `isDesktopShell()` | `src/lib/backend/endpoint.ts` | 真 Tauri internals 在场且不是我们自己装的网络 shim |
| `hasTray/hasUpdater/hasWindowControls/…` | `src/lib/shell/capabilities.ts` | 七个语义化包装，当前全部等价于 `isDesktopShell()` |
| `isShellCommand(cmd)` | `src/lib/backend/commandRouting.ts` | **反向白名单**：只有 19 个壳专属 command 走 IPC，其余一律走网络 |
| `isShellEvent(event)` | 同上 | 壳自己 emit 的事件（`app:action`、`tauri://*`…）走 IPC，其余走 WS |

业务代码继续写 `invoke("git_status", …)` / `listen("terminal:event", …)`——
`lib/backend/tauriCore.ts` 与 `tauriEvent.ts` 经 vite alias 顶替真插件，
在这一层完成分流。新增后端 command 不需要改任何名单。

浏览器里缺的能力：托盘/更新/全局快捷键/窗口置顶**隐藏入口**；剪贴板降级到
`navigator.clipboard`、外链降级到 `window.open`、上传降级到 `<input type=file>`；
**原生"浏览…"对话框故意不降级**——它选的是后端机器上的路径，浏览器对话框选的是
用户本机路径，语义不同，改成隐藏按钮 + 手输路径。

## Rust 后端内部

| 模块 | 文件 | 说明 |
|---|---|---|
| 路由装配 | `backend/src/lib.rs` | `build_router()` 挂 `/healthz`（免认证）+ `/api/*`（Bearer）+ permissive CORS |
| 命令路由 | `routes.rs` + `routes_gen.rs` | 176 条由 `scripts/generate-routes.mjs` 从 `src-tauri/src/tauri_commands/*.rs` 生成；`make check-routes` 防漂移 |
| 状态装配 | `lib.rs::build_state()` | 建库、装 registry、把 EventBus 接到 WS sink 与各子系统 |
| 事件流 | `ws.rs` | EventBus → `broadcast`(256) → 每连接一个 pump；队列满丢最旧帧，不阻塞业务线程 |
| 认证 | `auth.rs` | 密码即 Bearer token（决策 7）；另有内部 token 区分 Node 调用方 |
| 引擎代理 | `engine_proxy.rs` | `chat_send`/`chat_abort`/`conversation_live` 反代到 Node；`engine_emit_event` 收事件回流 |
| 引擎守护 | `engine_process.rs` | spawn Node、`/healthz` 就绪探测、崩溃后指数退避重启（上限 30s） |
| 工具审批 | `approval.rs` | Node 发起、前端应答的反向往返（见 protocols.md） |
| 出网防护 | `ssrf.rs` | IP 黑名单，含 NAT64/6to4 内嵌 IPv4 递归检查 |
| TLS | `tls.rs` | `--tls-cert` / `--tls-key`，内建与反代都支持（决策 14） |

能力实现在 `crates/backend`：`commands/`（automation / config / history /
integration / runtime / workspace）、`services/`（automation / memory / skills /
tunnel / workspace_watch / provider_models / provider_usage / system_proxy /
power_activity）、`runtime/`（terminal / sftp / shell_runner /
managed_process / process / task_runner / project_path / platform）。

**`backend` 的 `Cargo.toml` 禁止依赖 tauri**（决策 2）。这是编译期防线：
后端要能在没有窗口系统的容器里跑，靠人自觉守不住。

## Node 引擎内部

`src/index.ts` 只做认证、路由、JSON 编解码，业务全在 `engine.ts`：

- `acceptChatSend()` **同步**去重 + 入队后立即返回 202，turn 在队列里异步跑。
  增量与终态全走事件广播，不在 HTTP 响应里。
- 并发模型：多会话 async 并发，**同会话内一条 Promise 链串行**。
- `getConversationLiveSnapshot()` 的快照源是**引擎内存态**，不是 SQLite——
  `runAgentConversationTurn` 只在函数末尾落一次库，turn 中读库读不到半条消息。
- 工具执行、设置读取、历史落库全部经 `backendClient.ts` 的 `callBackend()`
  打回 Rust，走的是前端用的同一批路由。

## 持久化

| 数据 | 位置 | 所有者 |
|---|---|---|
| 应用设置 | `~/.liveagent/config.sqlite` | Rust 后端 |
| Chat 历史 | `~/.liveagent/chat-history.sqlite3` | Rust 后端（`initialize_history_db()` 在 `build_state` 第一步） |
| Memory 事实 | `~/.liveagent/memory/**/*.md` | Rust 后端；Markdown 是事实源 |
| Memory 索引 | `~/.liveagent/memory/memory-index.sqlite3` | Rust 后端 |
| Skills | `~/.liveagent/skills` | Rust 后端 |
| 上传暂存 | `~/.liveagent/uploads/<batch>/` | Rust 后端 |
| 端点与 UI 偏好 | 浏览器 localStorage | 前端（壳内不用，端点由壳注入） |

**这些全在后端所在的机器上。** 桌面壳形态下后端就在本机，与旧版一致；
独立部署时它们在服务器上——密钥也在那里。定位从「本地优先」改成
「后端由你自己部署」。

## 设计原则

| 原则 | 体现 |
|---|---|
| 唯一网络入口 | 认证、TLS、SQLite 全在 Rust；Node 只监听 loopback，前端够不着（决策 5） |
| 一套 API 两类客户端 | 前端与 Node 引擎共用 `/api/<command>`，行为不可能分叉 |
| 一份前端代码 | 壳能力运行时探测降级，不做构建分叉（决策 16） |
| 前端不在场不阻塞 | 引擎跑在后端，前端只是渲染；该超时超时，有推荐项自动选（决策 10） |
| 重连不补发 | 拉快照 + 订阅增量；没有 `seq`/`after_seq`/replay buffer（决策 19） |
| 编译期防线优于约定 | `backend` 禁 tauri 依赖，CI 另有 `cargo tree` 门禁 |

## 相关文档

- [protocols.md](protocols.md) —— HTTP/WS 协议的具体端点与消息
- [frontend.md](frontend.md) —— 前端模块地图、宿主差异、状态与安全边界
- [backend-boundary.md](backend-boundary.md) / [backend-split.md](backend-split.md) —— 后端边界的划分依据
- [migration/README.md](migration/README.md) —— 从三语言收敛到两语言的迁移全过程与 19 项决策
