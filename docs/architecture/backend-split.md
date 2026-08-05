# backend 拆分与 backend API 设计

配套文档:`backend-boundary.md`(234 个 command 的三分类)。
本文件记录**怎么拆**和**HTTP/WS 长什么样**。

## crate 布局

```
crates/
  backend/          后端核心 · Cargo.toml 禁 tauri（编译期防线）
  backend/       axum HTTP/WS 服务 · 依赖 backend · 175 条路由 + /api/events
  frontend/src-tauri/ 桌面壳 · 依赖 backend + backend（隧道数据面）
                       · 只剩 #[tauri::command] 薄包装 + 托盘/窗口/更新
```

两个 crate 均已建立并接通,`cargo tree` 对 backend / backend 都零 tauri。

桌面壳依赖 backend 只为复用隧道数据面(`TunnelDataPlane`)——两边跑同一份
实现,行为不可能不一致。这不构成环:backend 不依赖 src-tauri。

## 路由约定:命令式,不做 REST 化

**决定:`POST /api/<command_name>`,body 是原样的参数 JSON。** 流式端点是唯一例外,走 WS。

```
invoke("git_status", { workdir })   →   POST /api/git_status   { "workdir": "..." }
```

理由 —— 前端**现在**就在用这些命令名和这些参数对象(`#[tauri::command]` 的参数名
就是 JSON key)。1:1 映射让阶段 4 的前端迁移是机械替换;REST 化等于做 195 次独立
设计决策,每次都是一个破坏前端的机会。这是「消除特殊情况」而不是「制造 195 个」。

> 三份并行设计各自给出了不同约定(命令式 `/api/git_status`、kebab 资源式
> `/api/terminal/{id}/ssh-local-forward`、REST 式 `/api/conversations`)。
> 采纳命令式,理由如上。

**`rename_all` 的坑**:部分命令写了 `#[tauri::command(rename_all = "snake_case")]`,
部分没写(默认 camelCase)。HTTP 层必须**逐命令**沿用各自现有的约定,不能统一,
否则前端字段名对不上。已知不一致:`git_clone_repository_tasks`、
`chat_history_replace_from_message`。迁移时逐个核对,不要想当然。

## 已核验的事实(实验或读源码确认,非推断)

### `tauri::async_runtime` → `tokio` 的替换是安全的,但有前提

读 `tauri-2.11.5/src/async_runtime.rs` 确认:

| 项 | 结论 |
|---|---|
| 底层实现 | 纯 tokio。`JoinHandle` 是单变体枚举包 `TokioJoinHandle`(`:139`) |
| 错误类型 | **不完全相同**。`impl Future for JoinHandle` 的 `Output = crate::Result<T>`,即 `Result<T, tauri::Error>`,经 `map_err(Into::into)` 从 `JoinError` 转来(`:164-169`)。但 `tauri::Error::JoinError(#[from] tokio::task::JoinError)`(`error.rs:73`),所以现有的 `.map_err(\|e\| format!("...{e}"))` 照常编译,只是 Display 文案略变 |
| **runtime 前提** | **有实质差异**。`default_runtime()` 会 `TokioRuntime::new().unwrap()` **自建 runtime**(`:222-229`),所以 tauri 版在任何上下文可调;`tokio::spawn` 在 runtime 之外**会 panic** |

逐站点核查结果:后端所有 `async_runtime::spawn*` 都只从 async 上下文可达
(`scheduler.rs` 的 5 个同步 fn —— `start`/`report_task_error`/`start_fire`/
`disable_task_detached`/`record_run_detached` —— 调用方都在 `async fn fire`/
`execute_fire` 内;`spawn_ssh_reconnect_runner` 的 3 个调用点都在 async fn 内)。
`registry.rs` 的 2 个裸 `thread::spawn`(PTY 读线程)**不碰** async runtime。

唯一例外:`services/proxy.rs:83` `pub fn start_proxy_server()` 是同步 fn 且从
Tauri `.setup()` 调用。但该文件正好被 backend 取代
(`proxy_get_server_info` 已在删除清单),自然消失。

**结论:可以机械替换。**

### `include!()` 不是 blocker

代码里有 50 处 `include!()`(`chat_history/`、`settings/`、`memory/` 三处把子文件
摊平进同一模块)。实验验证(嵌套 `include!` + 独立 crate + 跨 crate 引用):

- ✅ `include!` 路径相对于**宏调用所在的物理文件**,与 crate 边界无关。整目录搬迁保持
  相对布局即可,编译通过。现有代码本身就是证据:`settings/mod.rs` 里
  `include!("ssh/mod.rs")`,而 `ssh/mod.rs` 里 `include!("load.rs")` 解析到 `ssh/` 目录。
- ⚠️ 真正的问题是 **`pub(crate)` 跨 crate 变私有**(`E0603`),而 `include!` 把所有文件
  摊平进一个模块,放大了这个面。

待迁移代码有 580 处 `pub(crate)`,但**留在壳里的代码只引用 29 个不同符号路径**。
所以不要批量提升为 `pub`,只提升真正跨界的那些——其余保持 `pub(crate)`
(在 backend 内部依然有效)。

## 已决的设计决策

| 问题 | 决策 | 理由 |
|---|---|---|
| `tauri::State` 注入的命令会话隔离（P2-24） | **不做 owner 命名空间，id 即隔离边界** | 三个 registry（`GitCloneTaskRegistry`/`ShellRunRegistry`/`HookScopeRegistry`）都按调用方提供的字符串 id keyed（`task_id`/`run_id`/`scope_id`），且 task id 是服务端 UUID 天然不可猜。桌面壳本就允许 Gateway 与 GUI 共享同一批 registry。决策 7 下所有客户端共享同一密码、没有客户端身份，owner 维度无从谈起。HTTP 侧与桌面现状一致 |
| 返回 `Result<(), String>` 的命令状态码（P2-25） | **保持 200/400 两档** | 与 Tauri IPC 语义一致（Err 就是失败），错误体已带字符串，前端在读。补 404/403 需要逐命令审计错误来源，收益有限 |
| 隧道数据面挂在哪（P2-30） | **一隧道一端口，路径 1:1**，不挂子路径 | 挂 `/t/<id>/` 时 dev server 发的绝对路径会打到隧道外，必须重写 HTML/CSS/fetch/WS 并改 CSP（Go 版 1,205 行）。独立端口下这类问题不存在，重写代码 0 行 |
| 隧道端口怎么保护（P2-30） | **首访 `?t=<token>` → HttpOnly cookie → 302 到干净路径** | 浏览器标签页发不了 `Authorization` 头，后端密码在这里用不上。与旧架构的「不可猜 slug」同强度，但端口可被扫到而 token 不能 |

## 待解决

阶段 2 的待解决项已全部闭合。

> 已闭合：`GatewayEventSink` 测试 → `action_for` 纯函数 + 变异验证（P2-14）；
> EventBus 背压 → WS sink 自排队 + 丢帧（容量 256，非阻塞 `tx.send`）；
> 3 个 settings 命令 → 已随 175 条路由生成；
> axum 0.8 TLS → `RustlsConfig::from_pem_file` 已查证并实现（P2-22）；
> 隧道重写 → P2-30；不经前端实测 → P2-31。

