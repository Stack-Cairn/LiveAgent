# 阶段 2 · Rust 后端网络化

**状态:✅ 完成**
提交:`3cf93685` `231faefb` `a2e22a93` `1336a48f` `1363c2c1` `8a5afca0` `b627ca2e`
`ed7fc88a` `58a73280` `5212db5b`

## 目标

把 195 个后端 command 从「只能被 Tauri webview 调用」变成「可被任何网络客户端调用」。

产物是两个新 crate:

- **`crates/backend`** —— 后端核心。`Cargo.toml` **禁 tauri 依赖**(编译期防线)。
  装 `runtime/` + `services/`(除 gateway/tray/bridge)+ `commands/` 的实现。
- **`crates/backend`** —— axum HTTP/WS 服务。密码认证、TLS、事件流。

`src-tauri` 退化为薄壳:`lib.rs`、托盘/窗口/更新、`gateway/*`(阶段 4 删)、
以及 195 个 `#[tauri::command]` 薄包装。

## 要求

| # | 要求 | 为什么 |
|---|---|---|
| 1 | 每个 command **同时**挂 `#[tauri::command]` 和 HTTP 路由 | 双挂让前端能逐个迁移,任何时刻桌面端都可用 |
| 2 | `cargo tree -p backend` 零 tauri | 编译期防线,不靠自觉 |
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

现在后端只认识 `backend::events::EventSink`:

| Sink | 位置 | 命运 |
|---|---|---|
| `TauriEventSink` | `src-tauri/tauri_sink.rs` | 桌面壳独有,永不进 backend |
| `GatewayEventSink` | `src-tauri/gateway_sink.rs` | **过渡设施**,阶段 4 随 Gateway 删除 |
| `WsEventSink` | `backend/src/ws.rs` | backend 用,`/api/events` |

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

### backend crate 建立

已接通,`events.rs` 迁入,`cargo tree -p backend` 零 tauri。

## 进度指标

| 指标 | 起点 | 现在 | 目标 |
|---|---|---|---|
| 后端代码里 `GatewayController` 引用 | 65 | **0** | 0 |
| 后端代码里结构性 tauri 触点 | 13 | **0** | 0 |
| 已迁入 backend 的行数 | 0 | **69,440** | 76,122 |
| HTTP 路由 | 0 | **175** | 175 |

`backend` 依赖树零 tauri,编译期防线生效。`src-tauri` 从 92k 行降到 22,480 行。

行数比原估的 76,122 少,因为 `services/proxy.rs`(阶段 2 末由 backend 取代)
没搬——搬它会把 axum 拖进 backend。`services/tunnel/` 不是「没搬」而是**重写**:
旧的 2,126 行删除,新实现拆成 backend 的状态层(1,193 行)与 backend 的
数据面(816 行),见下方「隧道重写」。

## ⚠️ 推翻:P2-16/17/18 的顺序假设是错的

原计划「runtime → services → commands,runtime 依赖最少先做」。**runtime 不是叶子**:

```
runtime/terminal/{state,ssh_connect,ssh_session,ssh_auth}.rs → crate::commands::settings
runtime/{task_runner,shell_runner}.rs                        → crate::services::system_proxy
runtime/managed_process_journal.rs                           → crate::services::automation::db
```

三者互相引用,不存在无环的拆分顺序。分步搬只能靠临时垫片,下一步再删掉。

**一次搬完反而更简单**:所有 `crate::runtime::` / `crate::services::` / `crate::commands::`
内部路径在 backend 里原样有效,133 个文件零路径改写。代价只有 18 个编译错误。

真正的成本在壳侧:**61 个** `pub(crate)` 需要提升为 `pub`(文档原估 29)。全部由编译器
`E0603` 点名后提升,没有全局提升——`pub(crate)` 在 crate 内依然有效,只有真正跨界的才该动。

## 剩余工作

| 项 | 状态 |
|---|---|
| `tauri::async_runtime` → tokio | ✅ 225 处已换(gateway 除外,阶段 4 删) |
| `#[tauri::command]` 拆成 impl + wrapper | ✅ 177 个,脚本生成 |
| `tauri::State<'_, Arc<T>>` → 显式参数 | ✅ 41 处 → `&Arc<T>`,体内 `x.inner()` → `x` |
| 代码迁入 backend | ✅ 69,440 行 |
| `pub(crate)` 跨界提升 | ✅ 61 个符号 |
| **补完 175 条路由(P2-28)** | ✅ 脚本生成,`check-routes` 门禁 |
| **会话隔离(P2-24)/状态码语义(P2-25)** | ✅ 已决:id 即隔离边界 / 200·400 两档 |
| **契约测试(P2-29)** | ✅ 175 路由全部可达 + 清单一致性 + 认证语义 + 代表性命令真成功,变异验证通过 |
| **事件接线缺口** | ✅ WS sink 注册 + 3 registry `set_event_bus` + automation 启动 + managed-process monitor |
| **tunnel 重写(P2-30)** | ✅ 一隧道一端口,路径 1:1,重写代码 0 行 |
| **阶段验收(P2-31)** | ✅ 757 测试绿,backend 零 tauri,curl/WS 实测通过 |

包装与实现的拆分是**脚本生成**的,不是手写:177 次同样的机械变换,手写只会引入
手写才有的错误。生成后用机器验了前端契约——234 个命令名、`rename_all`、JSON key
与阶段起点 `8c90a424` 逐字一致。

## 路由生成(P2-28)

175 条 HTTP 路由由 `scripts/generate-routes.mjs` 从 `tauri_commands/*.rs` 包装层
**自动生成**(`crates/backend/src/routes_gen.rs`):

- 每个命令一个私有模块,复制其源 wrapper 文件的 `backend::` use 行——参数类型
  与 wrapper 同一来源,跨文件同名符号互不干扰(E0252 不跨模块)
- 参数结构体 `#[serde(rename_all = ...)]` 逐命令镜像 tauri 属性(约 67 条 camelCase、
  103 条 snake_case),不能统一
- State 参数按 `Arc<T>` 类型映射到 `AppState` 字段,与 body 参数**保持 wrapper 原始
  顺序**——backend 函数签名就是 wrapper 参数顺序,乱序会静默交换参数
- 3 个非 Result 返回(`terminal_shell_options`/`terminal_list`/`runtime_cancel`)包
  `Ok::<_, String>`
- `ROUTED_COMMANDS` const 与 `.route()` 调用同源生成,注册与名字清单永不漂移
- 契约测试用 `backend.txt` − 17 无 wrapper − 3 WS 流式 = 175 双向比对,
  「新增 command 未加路由」立即失败

排除的 20 条:3 条 WS 流式(`terminal_stream_*`,走 `/api/events`)、17 条无 wrapper
(`system_*`/`provider_usage_*`/`workspace_watch_set`,属 gateway 脱离的范围)。
隧道 5 条已随 P2-30 补齐(名字改为 `tunnel_*`)。另有 4 条 wrapper 不在 backend.txt 且是
前端专属/删除清单(`proxy_get_server_info`/`open_chat_file_link`/
`fs_open_workspace_path`/`git_open_system_file_location`),不做路由——路由它们会
破坏「后端唯一网络入口」的边界。

## 隧道重写(P2-30)

隧道的用途:agent 在工作机上起了个 dev server(如 `:5173`),用户想从浏览器看效果。

### 定案:一隧道一端口,路径 1:1

文档原先把这条留作「阶段 2 设计时决定」:*路径前缀重写是否仍然必要,取决于隧道
路由是否挂在子路径下*。这个问法本身是陷阱——**挂子路径就等于把那 1000 行重写
逻辑用 Rust 再写一遍**:

```
挂 /t/<id>/            一隧道一端口
──────────────────     ──────────────────
dev server 发          dev server 发
  <script src="/assets/main.js">   ← 两边都发这个

浏览器请求             浏览器请求
  /assets/main.js      →  打到后端根路径,404
                          必须重写成 /t/<id>/assets/main.js
                          + 注入 shim 拦 fetch/XHR/WebSocket
                          + 改 CSP 放行 shim
                          ≈ tunnel_rewrite.go 424 行
                             + tunnel_proxy.go 781 行
                       →  直接就是对的,不需要碰
```

所以选独立端口。**重写代码不是「写得更好」,是 0 行**——这是「重新设计让特殊
情况消失」,不是「把特殊情况处理得更漂亮」。

| 旧(经 Gateway 中继) | 新(后端本机反代) |
|---|---|
| slug 注册协议 | 没有。id 本地生成,不跟谁协商 |
| 跨中继 protobuf 分帧 | 没有。后端直接连 `localhost:5173` |
| 子路径 + 1000 行重写 | 一隧道一端口,路径 1:1,重写 0 行 |
| 公开无认证入口 | 首访 token → cookie |

### 认证:首访 token → cookie

后端密码在这里用不上——浏览器标签页发不了 `Authorization` 头。所以:

```
首访 http://host:port/?t=<32 字节 token>
  → 常量时间校验 → Set-Cookie(HttpOnly; SameSite=Lax) → 302 到剥掉 token 的路径
后续 → 带 cookie 直接放行
```

与旧架构靠「不可猜的 slug」做能力凭证同强度,但更好一点:**端口可以被扫到,
token 不能**。cookie 名带隧道 id,所以一条隧道的凭证不能用于另一条(同源策略对
cookie 只看域名不看端口,不带 id 会互相覆盖)。

### 端口由数据面分配,不是 store

`TunnelDataPlane::start` 内部 `TcpListener::bind(port 0)` 拿到 listener 后**全程
持有**并直接交给 axum。若改成 store 先探测端口再让数据面重绑,中间那个释放窗口
就是 TOCTOU。现在这个窗口不存在。

代价是 backend 要定义 `TunnelDataPlane` trait 而实现留在 backend——
backend 不能依赖 axum(编译期防线只挡 tauri,但把 HTTP 服务器塞进核心库同样
是错的)。桌面壳直接复用同一份实现,两边行为不可能不一致。

### 落库的是意图,不是运行态

`StoredTunnelSpec` 只存「用户想暴露 5173」,不存「上次暴露在 19273 上」。端口和
token 每次进程启动重新分配:上次的端口这次可能已被占用,而进程重启后旧链接失效
本来就是想要的语义。重启后隧道自动重建、链接会变——与旧架构 slug 由 Gateway
重新分配一致。

### ⚠️ 顺带删掉旧 gateway 隧道路径

不删会有**两个 `TunnelStore` 抢同一张 `tunnel_settings` 表**,这是真 bug 不是
风格问题。一并删除:`services/tunnel/`(2,126 行)、`GatewayController` 的
`tunnel_store`/`tunnel_proxy` 字段与 5 个 `gateway_tunnel_*` 命令。中继来的
`TunnelState`/`TunnelMutation`/`TunnelFrame` 三类帧改为忽略(阶段 6 连协议一起删)。

命令名 `gateway_tunnel_*` → `tunnel_*`,事件 `gateway:tunnel-state` → `tunnel:state`。
这是阶段 2 里**唯一故意改动前端契约**的地方:旧名字指向一个即将不存在的组件。
前端 5 处调用、类型定义、agent 工具、i18n 与两份镜像副本已同步更新。

顺带修掉一处前端将就:`tunnel_check` 现在**同步等探活跑完**才返回,旧实现是异步
的,前端只能 `sleep 2.5s` 再拉快照碰运气。那个 sleep 已删除。



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
唯一例外 `services/proxy.rs:83` 会被 backend 取代而消失。

> 并行分析给出「语义等价已验证」但**漏掉了 runtime 前提**这一条。

#### ⚠️ 上面这段逐站点核查是**不完整**的 —— `make dev` 起不来

「所有 spawn 都只从 async 上下文可达」漏了 **`.setup()`**:它由 tauri 在**主线程
同步**调用,不在任何 runtime 里。于是 `gc_upload_staging_on_startup()`
(`commands/app/system.rs:698` 的 `spawn_blocking`)一进 setup 就 panic:

```
thread 'main' panicked at commands/app/system.rs:698:
there is no reactor running, must be called from the context of a Tokio 1.x runtime
→ panic in a function that cannot unwind → abort
```

而且它发生在 objc 的 `did_finish_launching` 回调里 —— 那是 `extern "C"` 边界,
panic 不能跨越,于是直接 abort,**桌面端根本起不来**。这是 `1363c2c1`(P2-15)
引入的,一直没被发现:全量测试不启动 Tauri,`cargo build` 更看不出来。

**修法是在入口建 runtime 并让 tauri 复用它**(`lib.rs` 的 `run()`),不是逐个给
setup 里的 spawn 加保护——后者是把特殊情况从 1 个变成 N 个:

```rust
let runtime = tokio::runtime::Runtime::new().expect("failed to build tokio runtime");
tauri::async_runtime::set(runtime.handle().clone());  // 必须在 tauri 首次碰 RUNTIME 前
let _guard = runtime.enter();
```

`set()` 让 tauri 用同一个 runtime 而不是自己再建一个:两个 runtime 意味着两个线程池,
且 `async_runtime::block_on` 与 `tokio::spawn` 会落在不同执行器上。此后**任何**代码
路径都在 runtime 上下文里,两种 spawn 行为一致。

**教训:「编译绿 + 测试绿」不覆盖「进程能不能起来」。** 与 P2-31 那两个缺口
(漏 `initialize_history_db` / 漏 `TunnelStore::initialize`)是同一类问题——
凡是只在真实启动路径上跑的代码,都得真的启动一次才知道。

### `include!()` 不是 blocker

50 处 `include!()` 把子文件摊平进同一模块。实验验证(嵌套 include + 独立 crate +
跨 crate 引用):

- ✅ 路径相对于**宏调用所在的物理文件**,与 crate 边界无关。整目录搬迁保持相对布局即可。
  现有代码自证:`settings/mod.rs` 里 `include!("ssh/mod.rs")`,`ssh/mod.rs` 里
  `include!("load.rs")` 正确解析到 `ssh/` 目录
- ⚠️ 真问题是 **`pub(crate)` 跨 crate 变私有**(`E0603`),`include!` 把文件摊平放大了这个面

580 处 `pub(crate)`,但壳侧只引用 **29 个符号路径**。只提升跨界的那些,
其余保持 `pub(crate)`(在 backend 内部依然有效)。

> 并行分析把 `include!()` 列为**头号 blocker**,这是错的。

## 待决问题

| 问题 | 说明 |
|---|---|
| ~~`tauri::State` 注入的命令会话隔离~~ | ✅ 已决(P2-24):**id 即隔离边界,不做 owner 命名空间**。registry 都按调用方 id keyed,桌面壳本就共享;决策 7 下没有客户端身份 |
| ~~返回 `Result<(), String>` 的状态码语义~~ | ✅ 已决(P2-25):**保持 200/400 两档**,与 Tauri IPC 一致,错误体已带字符串 |
| ~~EventBus 背压~~ | ✅ WS sink 自排队 + 丢帧(容量 256) |
| ~~3 个 settings 命令路由~~ | ✅ 已随 170 条路由生成 |
| ~~P2-30 隧道是否挂子路径~~ | ✅ 已决:**一隧道一端口,路径 1:1**。挂子路径等于把 1000 行重写逻辑用 Rust 重写一遍;独立端口下这类问题不存在 |

## 已知风险

**事件总线把编译期错误变成了运行时静默失败。** 这在迁移 history sync 时**真实发生过**:
移除 gateway 发布调用后忘了在 sink 里接上,`cargo check` 全绿但 history 同步已断,
下一步才补上。

已补防线(P2-14):`GatewayController` 持有 `tauri::AppHandle`,单测造不出来,所以把
**路由决策**(`action_for`,纯函数)和**执行**(`emit_json`,只剩转发)分开——踩过的那次
回归本质就是路由错误。断言用 backend 导出的事件常量本身而非字面量:后端改名测试
跟着变,后端新增事件却忘了接就掉进 `Ignore` 被抓住。已用变异验证:删掉
`HISTORY_UPSERT_EVENT` 分支,测试立即失败。

`settings_save_remote` 是最后一处 `GatewayController` 耦合,已按同款模式切断:
发 `settings:remote-saved`,sink 接住去调 `apply_config`。

**桌面壳与 backend 不能同机并跑。** 两者打开同一个 `~/.liveagent` 库:
cron 任务会被两个进程各触发一次,同一条隧道 spec 会被两个数据面各绑一个端口。
managed-process journal 有 owner_pid 互斥,automation 和 tunnel 没有等价机制——
当前架构假设同机只跑一个后端实例(桌面壳**或** backend)。阶段 3 桌面壳
改为连接 backend 时,这个假设变成结构性保证;在那之前它只是运行约定。

## 验证

```bash
cargo test --workspace                    # 757 绿
cargo tree -p backend | grep -q tauri && echo "防线破了" || echo "防线完好"
make check-routes                         # routes_gen.rs 与 wrapper 层一致
node scripts/check-mirror.mjs             # GUI/WebUI 镜像副本一致
node --test 'crates/frontend/test/**/*.test.mjs'   # 1435 绿
```

> `cargo clippy --workspace -- -D warnings` 当前报 93 个 error,**全部是既有代码**
> (`result_large_err` 29、`too_many_arguments` 25、`needless_borrow` 14 等),与本
> 阶段改动无关——在阶段起点的工作树上跑同样是 93 个。仓库没有 `rust-toolchain.toml`,
> 本机 clippy 1.97 比写这些代码时更严。要么钉工具链版本,要么单独清一轮,不该混进
> 本阶段。

### P2-31 实测(不经前端)

用 curl 直接打 `--port 18443` 的后端进程(`HOME` 指向临时目录,不碰真实数据):

| 项 | 结果 |
|---|---|
| `/healthz` 免认证 | 200 `ok` |
| 无 token / 错密码 | 401 / 401 |
| `git_status` | 返回本仓库真实 dirty 状态 |
| `fs_write_text` → `fs_read_text` | 往返一致,**磁盘上确认落盘** |
| `settings_load_all` / `automation_snapshot` / `terminal_list` / `memory_index_overview` / `shell_run` | 全部 200 |
| `chat_history_list` | 200(修完下述缺口后) |
| 隧道全生命周期 | create → 浏览器拿到首页与 `/assets/main.js` → check → close → 端口停止服务 |
| WS `/api/events` | 收到 `tunnel:state`;无 token 连接被拒 |

**实测抓到两个「测试全绿但功能是坏的」缺口**,这正是要求「不经前端实测」的原因:

1. **`build_state` 漏了 `initialize_history_db()`** —— 桌面壳在 `.setup()` 第一行做
   这件事,纯后端模式没做。结果 `chat_history_*` 全部报
   `no such table: chatHistory`。
2. **`main.rs` 从没调过 `TunnelStore::initialize()`** —— 规格好好躺在库里,监听却
   没起,隧道重启后全部消失。

两者都已修复,并各补了一条会失败的守卫测试
(`representative_commands_actually_succeed` / `tunnels_are_restored_after_a_restart_with_fresh_ports`),
均用变异验证过:删掉修复,测试立即失败。

**教训:「路由可达」不等于「命令可用」。** 契约测试的 Test B 把 400 也算通过
(空 body 反序列化失败是正常的),于是一条「路由挂上了但底层压根没初始化」的命令
能骗过它。新增的 Test D 用**真实参数**打 6 条代表性命令,必须 200 且带 `ok`。

