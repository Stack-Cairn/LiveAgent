# 阶段 4 · 前端网络化

**状态:🟨 进行中**(前端网络化与删除清单已落地,验收未跑)

## 目标

让前端**只通过网络**和后端说话。Tauri IPC 这条隐藏的第二路径彻底消失。

做完这步,「本地」和「远程」的区别退化成一个字符串:

```ts
const backend = createBackendClient({ baseUrl, password });
//                                    ↑ 唯一的本地/远程差异
```

## 要求

| # | 要求 | 为什么 |
|---|---|---|
| 1 | 只留 18 个前端专属 `invoke` | 托盘/窗口/更新是壳能力,不该走网络 |
| 2 | 事件订阅从 `listen()` 换成 WS | 同上,统一传输 |
| 3 | 本地模式由 Tauri 壳注入密码并跳过登录页 | 决策 8。桌面版开箱体验不能退化 |
| 4 | 删除 `services/gateway/*` 与 `gateway_bridge.rs` | 它们在这一步失去全部用户 |
| 5 | 前端行为零变化 | 用户不该感知到这次重构 |

## 改动面(实测基线)

| 项 | 数量 |
|---|---|
| import `@tauri-apps/api/core`(`invoke`)的文件 | **57** |
| import `@tauri-apps/api/event`(`listen`)的文件 | **17** |
| `@tauri-apps/plugin-opener` | 7 |
| `api/window` / `api/webview` / `api/path` | 各 1 |

替换后真正剩下的 Tauri 专属只有约 **10 个文件**。

## 删除清单

| 目标 | 行数 |
|---|---|
| `services/gateway/*.rs` | 10,228 |
| `services/gateway_bridge.rs` | ~1,400 |
| `src-tauri/gateway_sink.rs` | ~150 |
| 21 个 `deleted.txt` 里的 command | — |
| `commands/integration/gateway.rs` 的 20 个中继命令 | — |
| Go gateway 的 chat 可靠性补丁(阶段 3 已验证为死代码) | ~3,800 |

## 必须一起处理:`settings_save_remote` 拆两半

阶段 1 分类的已知缺陷(见 `backend-boundary.md`「已知分类缺陷」)。
`RemoteSettingsPayload`(`commands/config/settings/types.rs:23`)混了两类字段:

| 字段 | 处置 |
|---|---|
| `gateway_url`、`gateway_port`、`token`、`agent_id`、`auto_reconnect`、`heartbeat_interval` | **删除** —— 「连到哪个 Gateway」这个概念不存在了 |
| `enable_web_terminal`、`enable_web_ssh_terminal`、`enable_web_git` 等 | **保留** —— 并入后端的访问控制设置,门控远程前端能干什么 |

## 破坏性变更(无法避免)

**旧模型是桌面端 outbound 拨向 gateway,新模型是前端 outbound 拨向后端 ——
两边都在等对方来连,技术上对不上。** 现有部署了
`ghcr.io/stack-cairn/liveagent-gateway` 的用户一定会断。

按决策 15:

- 发**大版本**(v2.0)
- 旧 gateway 镜像 tag **冻结保留可拉**,旧桌面端配旧网关继续可用
- 新桌面端检测到旧网关地址时给**明确提示**,不静默失败
- README 写迁移指南

## 验收标准

- 同一份前端二进制,**只改 base URL** 就能在「本机后端」和「远程后端」之间切换,
  行为一致
- 桌面版双击即用:壳注入密码、跳过登录页、无感
- 浏览器访问远程后端:走登录页、输密码
- `rg '@tauri-apps/api/core' crates/frontend/src` 只剩前端专属命令的文件
- 旧 gateway 镜像仍可拉、旧桌面端仍可连

---

## 实施记录

### 前端网络化:vite alias + shim,58 个调用点零改动

原计划是逐文件替换 `invoke`。实际做法更省事也更难写错:

1. **`vite.config.ts` 把裸 specifier 重定向到自己的实现** ——
   `@tauri-apps/api/core` → `src/lib/backend/tauriCore.ts`,
   `@tauri-apps/api/event` → `src/lib/backend/tauriEvent.ts`。
   直接 import 这两个包的业务文件**一行不改**就从 Tauri IPC 换到了 HTTP/WS。
   所以「57 个 invoke 文件 + 17 个 listen 文件」这个基线数字没有变小,
   它们只是**换了实现**。

2. **`src/lib/backend/tauriShim.ts`(96 行)补 alias 管不到的洞** ——
   `@tauri-apps/plugin-opener`、`@tauri-apps/api/window|webview|path` 走包内部的
   相对 import,alias 匹配不到,它们直接读 `window.__TAURI_INTERNALS__`。
   shim 在纯浏览器里装一个假的 internals(转发 invoke 到后端、把
   `plugin:event|listen` 翻成 WS 订阅),真 Tauri 壳在场时**什么都不做**。
   必须是 `main.tsx` 的第一个 import。

3. **`commandRouting.ts` 给已删命令留明确错误** —— 调到 `REMOVED_GATEWAY_COMMANDS`
   里的命令时抛 `LEGACY_GATEWAY_MESSAGE`,不静默失败(对应破坏性变更那一节的要求)。

### 删除清单落实情况

| 目标 | 状态 |
|---|---|
| `services/gateway/*.rs` | ✅ 已删(`crates/backend/src/services/` 下不再有 `gateway/`) |
| `services/gateway_bridge.rs` | ✅ 已删 |
| `src-tauri/gateway_sink.rs` | ✅ 已删 |
| `commands/integration/gateway.rs` 的 20 个中继命令 | ✅ 已删 |
| `settings_save_remote` 拆两半 | ✅ 已做 |
| Go gateway 的 chat 可靠性补丁 | ✅ 已删,详见下节 |

### Go gateway:删掉 CHAT_INGRESS_V1 与三层推断超时

判断依据:这套机制的**生产者**是桌面端 `services/gateway`,该目录本阶段已整个删除,
Go 侧只剩一个没有发送方的接收端。

**整文件删除**

| 文件 | 行数 |
|---|---|
| `internal/session/conversation_reliable_ingress.go` | 917 |
| `internal/session/conversation_reliable_ingress_test.go` | 672 |
| `internal/session/conversation_stream_reconcile_test.go` | 415 |
| `internal/proto/v2/chat_ingress_test.go` | 71 |
| `internal/proto/v2/capabilities.go` | 5 |
| `internal/session/manager_capabilities_test.go` | 50 |
| `internal/protocol/pbws/handshake_test.go` | 15 |

**协议裁剪**(`proto/v2/gateway.proto`,已重新生成 Go 与 TS 代码)

删除 `ChatIngressBatch / Record / Delta / Heartbeat / Checkpoint / Terminal /
Resume / RunResume / Fragment / Ack` 十个 message。退役的字段号写进 `reserved`
(`GatewayEnvelope` 加 75,`AgentEnvelope` 加 95/96/97),防止将来复用撞车。
`ClientHello.capabilities` 字段保留,但不再协商任何能力。

**三层推断超时**(`conversation_stream.go`)

`runReportLostTimeout`(15s)、`staleRunTimeout`(10min)、`offlineRunTimeout`(30min)
及其常量、`onRuntimeStatus` 的 run ledger 对账、reaper 里的强制收尾全部删除。
随之消失的是整套「终态可证伪」机器:`isInferredRunLossCode`、`chatRunRecord.lostInferred`、
`chatRunRecord.revived`、`resurrectRunLocked`。它们存在的唯一理由是「推断出来的终态可能是错的」——
不再产生推断终态,三处调用点各自塌缩成一句 `if runFinishedRecently { return }`。
`conversationStreamStore.isOnline` 回调也因此失去用户,一并删除。

**能力门控**

`ChatIngressV1Ready` 及其全部调用点(`manager_registry.go` 的 `Status` /
`runtimeReadyLocked`、`browser_local.go` 的 `handleChatPrepare`、
`chatcmd.go` 的 `ProbeRuntime`)删除。`status.runtime_state` 不再有
`"protocol_incompatible"` 取值,`session.ErrChatProtocolIncompatible` 随之删除。

**观测**`/api/status` 的 `protocol_usage` 去掉 6 个 `chat_ingress_*` 计数器。

合计净减约 **4,200 行**(删 4,642 / 增 413,含生成代码)。`go build ./...`、
`go vet ./...`、`go test ./internal/... ./test/...` 全绿。

### 遗留事项

- **验收标准一条都没实跑。** 「同一份二进制只改 base URL 切本地/远程」「桌面版双击
  即用」「浏览器走登录页」都还是纸面结论,`make dev` 未跑。
- **`chat.prepare` 的 wake ping 保留了。** `chatcmd.ProbeRuntime` 仍然发 Ping 探活。
  它现在只是一次普通的连通性检查,不再有能力门控,但整个 `chat.prepare` 往返在新
  架构下也没有调用方 —— 属于「gateway 整体退役」的范围,不在本次删除里。
- **`web/src/lib/chat/runtimeCompatibility.ts` 未删。** 网关已不再发出
  `protocol_incompatible`,这个前端判断永远为 false(不报错,只是死分支)。
  删它要动 `GatewayApp.tsx` 的两处调用点和 i18n 文案,收益不抵风险。
- **浏览器侧的 seq window / `stream_epoch` / `after_seq` replay 保留了。**
  阶段 3 文档把它列进死代码,但它服务的是**浏览器订阅方的断线重连**
  (`SubscribeConversationStream`),不是桌面生产者的可靠性补丁。删了会直接废掉
  gateway 自带 WebUI 的续播,且没有补偿方案。判断为**存疑,不删**。
- **Go gateway 整体的去留没有定论。** 桌面端不再拨向它之后,它的 chat 中继已无
  生产者。本次只删了可靠性补丁层,relay 骨架(`ingestChatEvent` /
  `ingestChatControl` / `ingestRuntimeSnapshot`)原样保留。
