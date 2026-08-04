# 阶段 2 · Rust 后端网络化

**状态:🟡 进行中(约 80%)**
提交:`3cf93685` `231faefb` `a2e22a93` `1336a48f` `1363c2c1` `8a5afca0` `b627ca2e`
`ed7fc88a` `58a73280` `5212db5b`

## 目标

把 195 个后端 command 从「只能被 Tauri webview 调用」变成「可被任何网络客户端调用」。

产物是两个新 crate:

- **`crates/agent-core`** —— 后端核心。`Cargo.toml` **禁 tauri 依赖**(编译期防线)。
  装 `runtime/` + `services/`(除 gateway/tray/bridge)+ `commands/` 的实现。
- **`crates/agent-backend`** —— axum HTTP/WS 服务。密码认证、TLS、事件流。

`src-tauri` 退化为薄壳:`lib.rs`、托盘/窗口/更新、`gateway/*`(阶段 4 删)、
以及 195 个 `#[tauri::command]` 薄包装。

## 要求

| # | 要求 | 为什么 |
|---|---|---|
| 1 | 每个 command **同时**挂 `#[tauri::command]` 和 HTTP 路由 | 双挂让前端能逐个迁移,任何时刻桌面端都可用 |
| 2 | `cargo tree -p agent-core` 零 tauri | 编译期防线,不靠自觉 |
| 3 | 交付物必须含 API 契约测试 | 决策 18 |
| 4 | 每次提交都编译绿 + 全量测试绿 | 不做长期分支 |
| 5 | 桌面端行为零变化 | 阶段 2 是纯重构,不改产品语义 |

## 路由约定:命令式,不做 REST 化

```
invoke("git_status", { workdir })   →   POST /api/git_status   { "workdir": "..." }
```

流式端点是唯一例外,走 WS。

理由:前端**现在**就在用这些命令名和参数对象(`#[tauri::command]` 的参数名就是
JSON key)。1:1 映射让阶段 4 是机械替换;REST 化等于做 195 次独立设计决策,每次都是
一个破坏前端的机会。这是消除特殊情况,而不是制造 195 个。

**`rename_all` 必须逐命令沿用现状,不能统一** —— 部分命令写了
`rename_all = "snake_case"`,部分没写(默认 camelCase)。已知不一致:
`git_clone_repository_tasks`、`chat_history_replace_from_message`。

## 已完成

### 事件总线(核心设计)

后端代码此前把两个消费者**硬编码**在发事件的地方:`AppHandle::emit` 和
`GatewayController`。这让「谁在监听」成为后端的编译期依赖。

现在后端只认识 `agent_core::events::EventSink`:

| Sink | 位置 | 命运 |
|---|---|---|
| `TauriEventSink` | `src-tauri/tauri_sink.rs` | 桌面壳独有,永不进 agent-core |
| `GatewayEventSink` | `src-tauri/gateway_sink.rs` | **过渡设施**,阶段 4 随 Gateway 删除 |
| WS sink | 待建(P2-11) | agent-backend 用 |

payload 统一 `serde_json::Value` —— 这些类型本来就要过 JSON IPC,且线上协议就是 JSON。
sink 多为「重读当前状态再发布」,避免给 11 个 payload 类型逐个加 `Deserialize`。

关键洞察:`terminal`/`sftp`/`workspace_watch` 的 broadcast **早就是双路的**
(emit + subscribers 通道,Gateway 靠后者中继)。所以正确做法不是引入新抽象,
而是**把硬编码的 webview 消费者降级成总线上的一个普通订阅者**。

### 已解耦模块(零 `tauri::` / 零 `GatewayController`)

`runtime/managed_process.rs`、`runtime/terminal/*`、`runtime/sftp.rs`、
`services/automation/store.rs`、`services/workspace_watch/`、
`commands/history/chat_history/*`

顺带纠正一处所有权倒置:`WorkspaceWatchService` 原先由 `GatewayController` **创建**,
现改为后端创建、controller 接收,`attach_gateway` 删除。

### agent-core crate 建立

已接通,`events.rs` 迁入,`cargo tree -p agent-core` 零 tauri。

## 进度指标

| 指标 | 起点 | 现在 | 目标 |
|---|---|---|---|
| 后端代码里 `GatewayController` 引用 | 65 | **0** | 0 |
| 后端代码里结构性 tauri 触点 | 13 | **0** | 0 |
| 已迁入 agent-core 的行数 | 0 | **69,440** | 76,122 |
| HTTP 路由 | 0 | **4** | 176 |

`agent-core` 依赖树零 tauri,编译期防线生效。`src-tauri` 从 92k 行降到 22,480 行。

行数比原估的 76,122 少,因为 `services/tunnel/`(需重写)和 `services/proxy.rs`
(阶段 2 末由 agent-backend 取代)没搬——搬 proxy.rs 会把 axum 拖进 agent-core。

## ⚠️ 推翻:P2-16/17/18 的顺序假设是错的

原计划「runtime → services → commands,runtime 依赖最少先做」。**runtime 不是叶子**:

```
runtime/terminal/{state,ssh_connect,ssh_session,ssh_auth}.rs → crate::commands::settings
runtime/{task_runner,shell_runner}.rs                        → crate::services::system_proxy
runtime/managed_process_journal.rs                           → crate::services::automation::db
```

三者互相引用,不存在无环的拆分顺序。分步搬只能靠临时垫片,下一步再删掉。

**一次搬完反而更简单**:所有 `crate::runtime::` / `crate::services::` / `crate::commands::`
内部路径在 agent-core 里原样有效,133 个文件零路径改写。代价只有 18 个编译错误。

真正的成本在壳侧:**61 个** `pub(crate)` 需要提升为 `pub`(文档原估 29)。全部由编译器
`E0603` 点名后提升,没有全局提升——`pub(crate)` 在 crate 内依然有效,只有真正跨界的才该动。

## 剩余工作

| 项 | 状态 |
|---|---|
| `tauri::async_runtime` → tokio | ✅ 225 处已换(gateway 除外,阶段 4 删) |
| `#[tauri::command]` 拆成 impl + wrapper | ✅ 177 个,脚本生成 |
| `tauri::State<'_, Arc<T>>` → 显式参数 | ✅ 41 处 → `&Arc<T>`,体内 `x.inner()` → `x` |
| 代码迁入 agent-core | ✅ 69,440 行 |
| `pub(crate)` 跨界提升 | ✅ 61 个符号 |
| **补完 172 条路由(P2-28)** | ⬜ 当前 4/176 |
| **会话隔离(P2-24)/状态码语义(P2-25)** | ⬜ |
| **契约测试(P2-29)/tunnel 重写(P2-30)/验收(P2-31)** | ⬜ |

包装与实现的拆分是**脚本生成**的,不是手写:177 次同样的机械变换,手写只会引入
手写才有的错误。生成后用机器验了前端契约——234 个命令名、`rename_all`、JSON key
与阶段起点 `8c90a424` 逐字一致。

## 已核验的事实(实验/读源码,非推断)

### `tauri::async_runtime` → `tokio` 可以机械替换,但有前提

读 `tauri-2.11.5/src/async_runtime.rs`:

- 底层纯 tokio,`JoinHandle` 是单变体枚举包 `TokioJoinHandle`(`:139`)
- `impl Future` 的 `Output = Result<T, tauri::Error>`,经 `map_err(Into::into)` 从
  `JoinError` 转来(`:164-169`);而 `tauri::Error::JoinError(#[from] tokio::task::JoinError)`
  (`error.rs:73`),所以现有 `.map_err(|e| format!("...{e}"))` 照常编译
- ⚠️ **`default_runtime()` 会 `TokioRuntime::new().unwrap()` 自建 runtime**(`:222-229`)。
  故 tauri 版在任何上下文可调,而 `tokio::spawn` 在 runtime 之外**会 panic**

逐站点核查:后端所有 spawn 都只从 async 上下文可达(`scheduler.rs` 的 5 个同步 fn
调用方都在 `async fn fire`/`execute_fire` 内;`spawn_ssh_reconnect_runner` 3 个调用点
都在 async fn 内)。`registry.rs` 的 2 个裸 `thread::spawn`(PTY 读线程)不碰 async runtime。
唯一例外 `services/proxy.rs:83` 会被 agent-backend 取代而消失。

> 并行分析给出「语义等价已验证」但**漏掉了 runtime 前提**这一条。

### `include!()` 不是 blocker

50 处 `include!()` 把子文件摊平进同一模块。实验验证(嵌套 include + 独立 crate +
跨 crate 引用):

- ✅ 路径相对于**宏调用所在的物理文件**,与 crate 边界无关。整目录搬迁保持相对布局即可。
  现有代码自证:`settings/mod.rs` 里 `include!("ssh/mod.rs")`,`ssh/mod.rs` 里
  `include!("load.rs")` 正确解析到 `ssh/` 目录
- ⚠️ 真问题是 **`pub(crate)` 跨 crate 变私有**(`E0603`),`include!` 把文件摊平放大了这个面

580 处 `pub(crate)`,但壳侧只引用 **29 个符号路径**。只提升跨界的那些,
其余保持 `pub(crate)`(在 agent-core 内部依然有效)。

> 并行分析把 `include!()` 列为**头号 blocker**,这是错的。

## 待决问题

| 问题 | 说明 |
|---|---|
| `tauri::State` 注入的 9 个命令怎么做会话隔离 | `git_clone_repository_{start,tasks,cancel,dismiss}`、`shell_run`、`runtime_cancel`、`hook_run_{script,http_requests}`、`hook_cancel_scope` 持有 registry 句柄。需定 header 名、生命周期、校验方式 |
| 返回 `Result<(), String>` 的约 9 个命令 | HTTP 无法区分「成功」「不存在」「无权限」,需补状态码语义 |
| EventBus 背压 | `emit_json` 同步遍历所有 sink,慢客户端会阻塞业务线程。WS sink 必须自排队 + 丢帧 |
| 3 个 settings 命令未设计路由 | `settings_list_ccswitch_providers`、`settings_list_cherry_studio_providers`、`settings_list_cherry_studio_providers_from_path` |

## 已知风险

**事件总线把编译期错误变成了运行时静默失败。** 这在迁移 history sync 时**真实发生过**:
移除 gateway 发布调用后忘了在 sink 里接上,`cargo check` 全绿但 history 同步已断,
下一步才补上。

已补防线(P2-14):`GatewayController` 持有 `tauri::AppHandle`,单测造不出来,所以把
**路由决策**(`action_for`,纯函数)和**执行**(`emit_json`,只剩转发)分开——踩过的那次
回归本质就是路由错误。断言用 agent-core 导出的事件常量本身而非字面量:后端改名测试
跟着变,后端新增事件却忘了接就掉进 `Ignore` 被抓住。已用变异验证:删掉
`HISTORY_UPSERT_EVENT` 分支,测试立即失败。

`settings_save_remote` 是最后一处 `GatewayController` 耦合,已按同款模式切断:
发 `settings:remote-saved`,sink 接住去调 `apply_config`。

## 验证

```bash
cargo test --workspace && cargo clippy --workspace -- -D warnings
cargo tree -p agent-core | grep -q tauri && echo "防线破了" || echo "防线完好"
```

阶段结束时还要:

- 用 curl / websocat 直接打后端 API(**不经前端**),验证 fs/git/terminal/history/settings 全部可用
- 契约测试覆盖 195 个 command,且「新增 command 未加路由」会导致测试失败
- 桌面端行为零变化
