# 统一网络通信迁移 · 总览

把 LiveAgent 从「TS + Rust + Go 三语言、本地走 Tauri IPC / 远程走 Go 中继」
改成「TS + Rust 两语言、本地远程都走同一套网络 API」。

## 为什么

当前本地和远程走两条**完全不同**的路,而本地那条根本不是网络:

| 能力 | 本地 | 远程 |
|---|---|---|
| fs/git/settings/history/… | `invoke()` **Tauri IPC**(57 个文件) | WS protobuf → Go gateway → WS protobuf → `gateway_bridge.rs` → 同一批 command |
| **chat** | `await chatRuntimeHost.runTurn()` —— **同一 JS 上下文的函数调用**(`useSendChatTurn.ts:1402`) | 跨两进程 + 公网**模拟**这次函数调用 |

Go gateway 13,914 行手写代码里,约 **3,800 行专门在给「chat 引擎跑在一个会睡着的
浏览器标签页里」擦屁股**:`chat.prepare` wake ping、`ChatRunLedger` + 5s sweeper、
`runReportLost`(15s)/`stale`(10min)/`offline`(30min)三层超时、seq window +
`after_seq` replay、24h 幂等去重、`queued_in_gui`。

**只把 Go 翻成 Rust,这 3,800 行会原样搬过去。目标是让它们不必存在。**

Go 的选型没有任何文档依据:它出现在 root commit `487af778`(2026-05-24,squash 导入),
`git log --all --grep=` 扫过 gateway/golang/relay/performance 等,`--grep=performance`
**零命中**。没有 ADR、没有 RFC、没有一行 commit message 解释。唯一写下来的是**职责**
(`gateway.md:5`「Gateway 是远程访问中继」)而非选型。

## 目标形态

```
后端（独立部署单元）
  ├─ Rust: agent-core + agent-backend
  │        fs/shell/git/terminal PTY/sftp/sqlite/cron/mcp/memory（195 个 command）
  │        ← 唯一对外网络入口：HTTP + WS (JSON)
  └─ Node: agent-core-js
           agentRunner + 对话循环 + 工具层（约 35k 行 TS，pi-agent-core）
           ← 只监听 loopback，打同一套 JSON API

前端（以 GUI 为基线，一套代码）
  ├─ Tauri 壳：托盘/窗口/更新/通知（18 个前端专属 command）
  └─ 网络客户端 → http://127.0.0.1:xxxx   本地
                → https://your-box:8443   远程
```

**一套 API,两类客户端(前端 / Node 引擎)。工具行为不可能两边不一致。**

## 19 项已定决策

| # | 决定 |
|---|---|
| 1 | 范围:阶段 1–6 全做完,不停在中间态 |
| 2 | 后端是独立 crate + 独立二进制,**Cargo.toml 禁 tauri 依赖**(编译期防线) |
| 3 | 打包 Node runtime 随产物分发;不用 Bun(pi-agent-core 未在 Bun 验证) |
| 4 | 后端 = Rust core + Node 引擎两进程 |
| 5 | **Rust 唯一网络入口**,认证/TLS/SQLite 都在它;Node 只监听 loopback |
| 6 | **JSON over HTTP + WS**。`proto/v2` + buf 工具链全删 |
| 7 | 密码直接当 Bearer token |
| 8 | 本地密码初始化动态生成、可改;Tauri 壳注入并跳过登录页 |
| 9 | 一个后端支持多前端同时连 |
| 10 | **前端只是渲染,不在场不阻塞主流程**;该超时超时,有推荐项自动选 |
| 11 | 本地模式 Tauri 壳退出时一并关后端 |
| 12 | 一个前端只连一个后端(Gateway 多 agent 管理消失) |
| 13 | Node↔Rust 走**同一套 JSON API**(loopback + 内部 token) |
| 14 | 内建 TLS(`--tls-cert`/`--tls-key`)+ 反代都支持 |
| 15 | 大版本切换,旧 gateway 镜像 tag 冻结保留 |
| 16 | 前端**以 GUI 为基线**,`agent-gateway/web` 删除 |
| 17 | 阶段 3 **一次切断,不留 feature flag** |
| 18 | 只加 **API 契约测试**,不做 e2e |
| 19 | 重连**不补发**,拉快照 + 订阅增量(`seq`/`stream_epoch`/`after_seq` 全消失) |

## 阶段与文档

| 阶段 | 文档 | 状态 |
|---|---|---|
| 1 · 划清后端边界 | [phase-1-boundary.md](phase-1-boundary.md) | ✅ 完成 |
| 2 · Rust 后端网络化 | [phase-2-backend.md](phase-2-backend.md) | ✅ 完成 |
| 3 · 抽 Node 引擎 | [phase-3-engine.md](phase-3-engine.md) | ⬜ 未开始 |
| 4 · 前端网络化 | [phase-4-frontend.md](phase-4-frontend.md) | ⬜ 未开始 |
| 5 · 前端合并 | [phase-5-merge.md](phase-5-merge.md) | ⬜ 未开始 |
| 6 · 删除 Go 与切换发布 | [phase-6-cutover.md](phase-6-cutover.md) | ⬜ 未开始 |

每份文档配一个同名 `.csv` 作为 todo-list(见下方「CSV 约定」)。

## 贯穿全程的硬门槛

每个阶段结束时:

```bash
cargo test --workspace && cargo clippy --workspace -- -D warnings
node --test 'crates/agent-gui/test/**/*.test.mjs'
cargo tree -p agent-core | grep -q tauri && echo "防线破了" || echo "防线完好"
make dev    # ← 必须真的起来，见下
```

**且桌面端必须完整可用。** 不做长期分支。

⚠️ **`make dev` 不是可选项。** 阶段 2 出现过一次「757 个测试全绿、`cargo build`
干净,但 `make dev` 直接 abort」——`.setup()` 里的 `tokio::spawn` 在没有 runtime
的上下文 panic,而那个 panic 发生在 objc `extern "C"` 回调里不能 unwind。
凡是只在真实启动路径上跑的代码(setup 接线、DB 建表、后台任务),测试套件一律看不到。

## 代码规模基线(2026-08-04 实测)

| 目标 | 行数 |
|---|---|
| 待迁入 agent-core:`runtime/` | 11,837 |
| 待迁入 agent-core:`services/`(除 gateway/tray/bridge) | 26,847 |
| 待迁入 agent-core:`commands/` | 37,438 |
| **小计** | **76,122** |
| 待迁入 Node 引擎:`lib/chat` + `lib/tools` + `lib/providers` + `pages/chat/turns` | 35,182 |
| 将删除:手写 Go | 13,914(另有 17,357 生成 + 10,827 测试) |
| 将删除:`services/gateway/` | 10,228 |
| 将合并:GUI 前端 / WebUI | 151,713 / 126,934 |

## CSV 约定

每阶段一个 CSV,列固定:

```
id,task,status,blocker,verify,notes
```

- `id` —— `P<阶段>-<序号>`,稳定不复用
- `status` —— `done` / `in_progress` / `todo` / `blocked`
- `blocker` —— 依赖的 task id,或阻塞原因;无则留空
- `verify` —— **这条怎么算做完**(可执行的命令或可观察的现象),不写"测试通过"这种空话
- `notes` —— 踩过的坑、被推翻的假设、需要人拍板的地方

## 已知风险(全局)

| 风险 | 说明 | 对策 |
|---|---|---|
| 事件总线把编译期错误变成运行时静默失败 | 迁移 history sync 时**真实发生过**:移除 gateway 调用后忘了在 sink 里接上,编译全绿但同步已断 | ✅ 已补:路由决策拆成纯函数 `action_for` 并测试(P2-14) |
| 工具审批反向往返 | 引擎搬到后端后,后端要主动向前端发起请求并等回答,而前端可能没连着 | 按决策 10,先写测试再写实现(P3-06) |
| 快照源不能是 SQLite | `runAgentConversationTurn.ts:1217` 落库只在函数末尾一次,turn 中不写库 | 快照来自引擎内存态(P3-07) |
| SSRF 防护需重写 | Go 的黑名单 + safeurl 在 Rust 无对应物;`proxy.rs:227` 的校验**没有 IP 黑名单**,够用只因绑 loopback | ✅ 已重写:`agent-backend/src/ssrf.rs`,含 NAT64/6to4 内嵌 IPv4 递归检查(P2-27) |
| **「路由可达」≠「命令可用」** | 契约测试把 400 也算通过(空 body 反序列化失败是正常的),于是「路由挂上了但底层没初始化」的命令能骗过它。P2-31 用 curl 实测抓到两例:漏 `initialize_history_db()`、漏 `TunnelStore::initialize()` | ✅ 已补 Test D:6 条代表性命令带**真实参数**必须 200 且带 `ok`(P2-31) |
| **「编译绿 + 测试绿」不覆盖「进程能不能起来」** | P2-15 把 `async_runtime::spawn` 换成 `tokio::spawn` 后,`.setup()`(主线程同步调用,不在 runtime 里)里的 spawn 直接 panic,且在 objc `extern "C"` 边界上不能 unwind → abort,桌面端起不来。757 个测试全绿也测不到 | ✅ `run()` 入口建 runtime + `async_runtime::set` 统一;**每阶段结束必须真的跑一次 `make dev`** |
| 20 个脆测试会误报 | `readFileSync` + 正则断言源码文本,不验证行为 | 阶段 5 改写或删(P5-05) |
