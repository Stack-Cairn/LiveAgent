# 阶段 3 · 抽 Node 引擎,一次切断

**状态:⬜ 未开始**(依赖阶段 2)

## 目标

把 chat 引擎从桌面端 **WebView** 搬到后端的 Node 进程。

这是整个迁移的**核心一步** —— Go gateway 里那 ~3,800 行可靠性补丁在这一步之后
全部变成死代码。

## 为什么这步最关键

现在的真实拓扑:

```
远程前端 → Go gateway → Rust → app.emit("gateway:chat-request-ready") → 桌面端 WebView（引擎在这）
                                                                          ↑
                                                              一个会睡着、会被关掉、会刷新的浏览器标签页
```

`services/gateway/chat.rs:150` 干的事就是**捅醒桌面端自己的前端**替远程前端跑对话。
Gateway 里所有让人恶心的东西都是这个拓扑的补丁:

| Gateway 机制 | 存在的唯一原因 |
|---|---|
| `chat.prepare` 关联 Ping/Pong 唤醒 | WebView 会休眠,得先把它捅醒 |
| `ChatRunLedger` + 5s sweeper 重发终态 | 前端跑的任务不可信,会丢终态 |
| `runReportLostTimeout`(15s)/`stale`(10min)/`offline`(30min) | 同上,三层超时兜底 |
| seq window / `stream_epoch` / `after_seq` replay | 事件生产者是个浏览器标签页 |
| `queued_in_gui` 状态 | 字面意思:给 GUI 排队 |
| `client_request_id` 24h 幂等去重 | ACK 可能丢 |

**引擎搬到后端后,断线的只是渲染层,后端一直在跑、状态权威。** 于是这些全部不需要。

## 引擎已经是 headless 的(已验证)

```
lib/chat/runner + pages/chat/turns 里 window./document./localStorage/navigator. :  1 处
lib/tools（11,126 行）里                                                        :  2 处
引擎对 React 的依赖                                                             :  0
pi-agent-core 使用点                                                  agentRunner.ts 单文件
```

而且**引擎能在 Node 里跑已被每日验证**:`crates/agent-gui/test/` 148 个测试文件中
**131 个**走 `helpers/load-ts-module.mjs` —— 用 `vm` 转译执行真实 TS,并直接 import
pi-ai 的 `json-parse`/`validation`/`event-stream` 内部实现(注释原文:
"so ... code paths behave exactly like runtime")。

**这一步不是往未知里跳。** 32k 行引擎住在 WebView 里是历史巧合,不是技术约束。

## 要求

| # | 要求 | 为什么 |
|---|---|---|
| 1 | **一次切断,不留 feature flag** | 决策 17。双宿主兼容层本身就是新的 bug 源 |
| 2 | 工具层的 `invoke()` 换成打后端同一套 JSON API | 决策 13。工具行为不可能两边不一致 |
| 3 | 消灭那 3 处浏览器 API 引用 | 否则 Node 里跑不起来 |
| 4 | 打包 Node runtime 随产物分发 | 决策 3。不用 Bun —— pi-agent-core 未在 Bun 验证 |
| 5 | Node 只监听 loopback | 决策 5。Rust 是唯一对外入口 |
| 6 | 快照接口返回**引擎内存态** | 见风险 2 |

## 迁移范围

| 源 | 行数 |
|---|---|
| `src/lib/chat/`(含 `runner/`、`history/chatHistory.ts`) | 13,732 |
| `src/lib/tools/` | 11,126 |
| `src/lib/providers/` | 8,524 |
| `src/pages/chat/turns/run*.ts` | 1,800 |
| **合计** | **35,182** |

目标位置:`crates/agent-core-js/`(Node 包,esbuild 打单文件)。

## 风险 1 · 工具审批反向往返(最大设计风险)

现在 `lib/tools/toolApproval.ts` 与引擎在**同一 JS 上下文**,审批就是个 Promise。
引擎搬到后端后,**后端要主动向前端发起请求并等回答**,而前端可能根本没连着。

按决策 10,规则:

1. 先跑 `toolPolicy.ts` 的 `resolveToolPolicy`,已配策略的直接裁决,不惊动人
2. 需要人判断的推给**所有**已连前端,**先到先得**(原子 CAS,后到的收「已被应答」)
3. 超时按现有 `TOOL_APPROVAL_TIMEOUT_MS`;**有推荐项的自动选推荐项**,没有的按拒绝
4. 无前端连着**不阻塞主流程**,走同一套超时逻辑

现有机制可复用:`toolApproval.ts` 已有 `TOOL_APPROVAL_TIMEOUT_MS` 和
`approve | deny | approve_session` 三态;`toolPolicy.ts` 已有按工具/组/server 的策略解析。

**这块必须先写测试再写实现。**

## 风险 2 · 快照源不能是 SQLite

`runAgentConversationTurn.ts:1217` —— 落库只有一次,在 1231 行函数的**末尾**。
turn 进行中不写库。

所以决策 19 的「重连拉快照」,快照必须来自 **Node 引擎的内存态**(含正在生成的
半条消息),不能只查 SQLite,否则断线重连会看到会话**回退到上一轮结束**。

SQLite 是持久层,不是快照源。后端需要一个 `GET /api/conversation_live` 之类的接口。

## 验收标准(硬门槛)

**服务器模式下关掉所有前端,chat 仍在后端跑完。** 这是整个方案的验收标准。

> 本地模式不适用此项 —— 按决策 11,Tauri 壳退出时一并关后端。

另外:

- 无前端连接时,已配策略的工具自动裁决,需人工的按超时 + 推荐项自动选
- 长任务跑到一半重启前端,重连后拉到的快照**包含正在生成的半条消息**
- 多前端同时连,审批先到先得,后到的收到「已被应答」
- 冷启动首发、长时间挂起后发消息、发送中断网重连、同一 `client_request_id` 重复提交
  —— 全部正常

做完这步后,Gateway 里的 `chat.prepare` wake ping、`ChatRunLedger`、三层超时、
seq window 应当已是死代码 —— 阶段 4 一并删除。
