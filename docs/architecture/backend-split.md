# agent-core 拆分与 agent-backend API 设计

配套文档:`backend-boundary.md`(234 个 command 的三分类)。
本文件记录**怎么拆**和**HTTP/WS 长什么样**。

## crate 布局

```
crates/
  agent-core/          新增 · 后端核心 · Cargo.toml 禁 tauri（编译期防线）
  agent-backend/       待建 · axum HTTP/WS 服务 · 依赖 agent-core
  agent-gui/src-tauri/ 桌面壳 · 依赖 agent-core · 只剩 #[tauri::command] 薄包装 + 托盘/窗口/更新
```

`agent-core` 已建立并接通,`cargo tree -p agent-core` 零 tauri 依赖。

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
Tauri `.setup()` 调用。但该文件正好被 agent-backend 取代
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
(在 agent-core 内部依然有效)。

## 待解决

| 问题 | 说明 |
|---|---|
| `tauri::State` 注入的 9 个命令 | `git_clone_repository_{start,tasks,cancel,dismiss}`、`shell_run`、`runtime_cancel`、`hook_run_{script,http_requests}`、`hook_cancel_scope` 持有 registry 句柄。HTTP 侧需要会话隔离方案(header 名、生命周期、校验),尚未定 |
| 返回 `Result<(), String>` 的命令 | 约 9 处(`workspace_watch_set`、`hook_cancel_scope`、多个 `tunnel_*`)。HTTP 无法区分「成功」「不存在」「无权限」,需补状态码语义 |
| EventBus 背压 | `events.rs` 的 `emit_json` 同步遍历所有 sink,一个慢客户端会阻塞发事件的业务线程。WS sink 必须自己排队 + 丢帧,不能阻塞 |
| `GatewayEventSink` 无测试 | 事件总线把编译期错误变成了运行时静默失败——迁移 history sync 时就真实发生过一次(移除 gateway 调用后忘了在 sink 里接上,编译全绿但同步已断)。需补覆盖 |
| 3 个 settings 命令未设计路由 | `settings_list_ccswitch_providers`、`settings_list_cherry_studio_providers`、`settings_list_cherry_studio_providers_from_path` |
| axum 0.8 TLS 集成 | `axum-server` 的 `RustlsConfig::from_pem_file` 签名未经验证,实现前必须查证 |
