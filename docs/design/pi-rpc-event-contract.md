# pi RPC 迁移 · 前端事件契约表

> 目的：Node core 将被 `pi --mode rpc` 替代，Rust 需要一个翻译层把 pi 事件映射回现有前端契约。
> 本文档记录**现状实测契约**（2026-08 摸底，逐行读码确认），作为翻译层的规格。
> 铁律：前端零改动。前端实际消费什么，翻译层就保什么；发出即丢弃的事件不迁移。

## 1. 传输链路现状

```
Node core --POST /api/engine_emit_event {event, payload}--> Rust EventBus --WS 信封 {event, payload}--> 前端
```

- Rust 侧完全透传（`engine_proxy.rs:74` → `events.rs emit_json` → `ws.rs` 包 `{event, payload}` 信封），payload 不透明。
- WS：`GET /api/events?token=<password>`，broadcast 容量 256，慢客户端丢最旧帧，**无 seq、无重连补发**。
- 迁移后此链路变为：pi stdout JSONL → Rust 翻译层 → EventBus（`engine_emit_event` HTTP 路由整体删除）。

## 2. 前端实际消费的事件（翻译层必保 ✅）

唯一消费者：`crates/frontend/src/pages/chat/hooks/useBackendEventSubscription.ts`。
所有事件先按 `payload.conversation_id`（回退 `conversationId`）路由到会话的 `LiveTranscriptStore`，缺失则丢弃。

### 2.1 `token_delta` ✅

```ts
{ conversation_id: string; delta: string }
```

- 前端行为：`appendDraftAssistantText(delta)`。
- pi 映射：`message_update` 事件中 `assistantMessageEvent.type === "text_delta"` → `delta`。
- 注意（2026-08 落地时实测更正）：pi 的 `message_update` **带全量累积消息**，
  而且 `assistantMessageEvent.partial` 是同一条消息的第二个副本——长回复下
  单行体积随对话增长，整条流是 O(n²) 带宽。翻译层只取 `delta`：解析分两趟，
  第一趟只读 `type`，第二趟落到**不声明 `message`/`partial` 字段**的窄结构体，
  让 serde 用 `IgnoredAny` 扫过去而不建对象（见 `crates/backend/src/pi/protocol.rs`）。
- 增量按 `contentIndex` 区分内容块；thinking 块是另一个事件类型（`thinking_delta`），
  **不**映射到 token_delta。
- 2026-08 补充：payload 增加 `round`（当前轮下标），前端据此把正文同时落进
  liveRounds（渲染优先 liveRounds，草稿正文只作落史回退源）。

### 2.1b `thinking_delta` / `tool_call` / `tool_result` ✅（2026-08 新增）

思维链与工具调用链的前端可视化事件，形状对齐前端 `LiveRound` 的块结构：

```ts
{ conversation_id, delta: string, round: number }                    // thinking_delta
{ conversation_id, round, toolCall: {type,id,name,arguments} }       // tool_call
{ conversation_id, round, toolResult: {role,toolCallId,toolName,content,details,isError,timestamp} }  // tool_result
```

- 前端在 `useBackendEventSubscription` 里按 `round` 落进对应会话的 liveRounds
  （轮次缺失时惰性补齐，与后端 LiveState 的第一轮惰性创建对齐）。
- `run_ended` 时发送方 waiter 带走 liveRounds 快照落史（思考/工具链随之持久化），
  快照为空时回退纯 `draftAssistantText`。


### 2.2 `tool_status_change` ✅（部分字段）

```ts
{ conversation_id: string; status: string | null; isCompaction: boolean;
  retryAttempts?: { attempt: number; maxAttempts: number; errorMessage: string }[] }
```

- 前端只消费 `status`（`isCompaction`、`retryAttempts` 被忽略 → 翻译层可只发 `status`，其余字段留空兼容）。
- pi 映射：
  - `tool_execution_start/end` → 生成/清除状态行文本（Rust 侧用 toolName 拼状态文案，对齐现有 `summarizeToolCall` 风格）。
  - `auto_retry_start/end` → `retryAttempts`（前端目前不消费，但 `conversation_live` 快照里有此字段，保持结构）。
  - `compaction_start/end` → `isCompaction: true` 的状态行。

### 2.3 `run_ended` ✅（仅事件本身）

```ts
{ conversation_id: string; state: "completed" | "failed" | "cancelled"; errorMessage?: string }
```

- 前端只用它触发 `settleLiveTranscript`，`state`/`errorMessage` 被忽略（已知 UI 缺陷：失败与取消不可区分，迁移时保持现状，不顺手修）。
- pi 映射：`agent_settled`（注意不是 `agent_end`——`agent_end` 后可能还有自动重试/压缩续跑，`agent_settled` 才等价于现有 `runOneTurn` 的 finally 语义）。
- **错误路径**（2026-08 逐行读 pi 源码后补全）：pi **没有顶层 error 事件**。
  LLM 失败表现为 assistant 消息的 `stopReason: "error"` + `errorMessage`，
  用户取消是 `stopReason: "aborted"`，两种情况 `agent_end`/`agent_settled` 照常发。
  而 `assistantMessageEvent` 的 `done`/`error` 变体**不会**经 `message_update` 发出
  （`agent-loop.js` 在这两种情况下直接转 `message_end`）。所以 `state` 只能这样定：
  跟踪 `message_end` 里 assistant 消息的 `stopReason`，`agent_settled` 时回看最后一条
  —— `error` → `failed`，`aborted` → `cancelled`，其余 → `completed`。
  `agent_start` 要清掉上一段的结论，否则压缩续跑/自动重试会继承前一段的失败。
- **另一条终态来源**：`prompt` 的 preflight 失败（没配 key、模型不存在）只回一条
  `{"type":"response","command":"prompt","success":false,"error":...}` 且**不带 `id`**，
  此时 agent 根本没启动，不会有 `agent_settled`。翻译层必须为它补一条
  `run_ended{state:"failed"}`，否则前端永远转圈。

### 2.4 `tool-approval:request` ✅（Rust 自产，与迁移无关）

由 `approval.rs:117-128` 直接发，不经 Node。迁移后改为由 pi 的 `extension_ui_request` 触发，事件形状不变：

```ts
{ approval_id, conversation_id, tool_name, summary, recommended?, tool_call_id, timeout_ms }
```

（前端只取前 5 个字段。）

## 3. 发出即丢弃的事件（翻译层不迁移 ❌）

全仓确认 `crates/frontend/src` 零命中，当前只是白白发送：

| 事件 | 内容 | 处置 |
|---|---|---|
| `chat:run-event` | user_message / error / thinking / tool_call / tool_call_delta / tool_result / hosted_search 全量流 | ❌ 不迁移。若未来前端要做工具调用可视化，直接透传 pi 原生事件另立新契约 |
| `chat:compaction-status` | 压缩四阶段状态机 | ❌ 不迁移 |
| `chat:hook-warning` | automation hook 告警 | ❌ 不迁移（hook 能力本身去留见能力清单文档） |

**含义：翻译层实际只需要维护 2.1–2.3 三个事件 + 审批流。**

## 4. HTTP 接口契约（Rust 接管后对前端保持不变）

### 4.1 `POST /api/chat_send` ✅

请求（`ChatSendRequest`）：

```ts
{ conversationId: string; clientRequestId?: string; mode?: "agent" | "text";
  text: string; workdir?: string; skillsEnabled?: boolean;
  selectedModel?: SelectedModel; selectedSkillNames?: string[] }
```

响应：**HTTP 202** + `{"ok": {"accepted": true, "duplicate"?: true}}`（前端忽略 body，但 `parseResponse` 要求有 `ok` 字段）。

- pi 映射：会话进程存在且流式中 → `follow_up`（对齐现有串行排队语义）；否则 `prompt`。
- `clientRequestId` 幂等去重逻辑移到 Rust。
- `mode: "text"`、`selectedModel`、`skillsEnabled`/`selectedSkillNames` 的映射依赖能力清单的去留决策（pi 的 skills 机制不同）。

### 4.2 `POST /api/chat_abort` ⚠️

`{ conversationId }` → `{"ok": {"aborted": boolean}}`。
**前端从不调用**。准确说法（读码更正）：前端"停止"调的是
`invoke("gateway_chat_cancel_request")`，而该命令在 `commandRouting.ts` 的
`REMOVED_GATEWAY_COMMANDS` 名单里，被 `tauriCore.ts` / `tauriShim.ts` **在前端本地
直接 throw**，根本发不出网络请求；调用点又都挂了 `.catch(console.warn)`，
于是失败被静默吞掉。所以现状是"停止按钮不工作"，不是"走了另一条路由"。
迁移时路由保留、内部改发 pi `abort` 命令；把前端停止链路接到这条路由是
迁移后的独立修复项，不混入本次。

### 4.3 `GET /api/conversation_live?conversationId=` ⚠️

响应快照：

```ts
{ conversationId, isRunning: boolean,
  live: { draftAssistantText, toolStatus, liveRounds, retryAttempts, isSettled },
  messageCount: number | null }
```

404 = 内存无 live 会话（≠ 会话不存在）。
**前端拉了但没应用**（只 console.debug，重连恢复是空实现）。Rust 从翻译层的
组装状态生成同形快照，保持 404 语义；前端闭环留作后续修复项。

`liveRounds` 已按前端 `LiveRound`（`src/lib/chat/messages/uiMessages.ts`）逐字段组装：
正文/思考增量按 `contentIndex` 切成 `text`/`thinking` 块，
`tool_execution_start/end` 配成 `tool` 块（含 `toolCall` 与 `toolResult`），
`turn_start` 划分轮次，`message_end` 填 `meta`（provider/model/api/stopReason/usage）。

**pi 侧拿不到、因而结构在但值缺省的字段**：

| 字段 | 情况 |
|---|---|
| `UiRoundContentBlock` 的 `hostedSearch` 变体 | provider 原生搜索块不在 pi 的事件流里单独出现，永不产出该 kind |
| `ToolCall.thoughtSignature` | provider 内部字段，`tool_execution_start` 不带 |
| `ToolResultMessage.usage` / `addedToolNames` | `tool_execution_end` 不带 |
| `ToolResultMessage.timestamp` | pi 不给，用收到事件的时刻填（是「结果何时到达」而非「工具何时执行完」，差一个 IPC 量级） |

另注：pi 的 agent loop **不为第一轮发 `turn_start`**（只在非首轮发），所以第一轮
由第一个内容事件惰性创建。

## 5. 已知缺陷备案（迁移时保持现状，不顺手修，防止 scope 蔓延）

1. `token` wire 事件的 title / usage / checkpoint / provider / model 在 engine.ts:238 被压平丢弃 → 标题生成、用量展示走的是别的通道（待能力清单确认）。
2. 压缩摘要正文当普通 token 流入 `draftAssistantText`。
3. `run_ended.state` 前端不消费，失败/取消 UI 不可区分。
4. WS 无 seq 无补发 + 快照恢复空实现，重连必丢事件。
5. `engine_emit_event` 返回裸 200 空 body，Node `callBackend` 因缺 `ok` 字段每次 emit 都 unhandled rejection（迁移后此路由删除，缺陷自然消亡）。
6. 停止按钮实际不工作：命令被前端本地拦截并 throw，异常又被 `.catch(console.warn)` 吞掉（见 §4.2）。

## 6. 翻译层规格小结

| pi 事件 | 前端事件 |
|---|---|
| `message_update` (text_delta) | `token_delta`（带 `round`） |
| `message_update` (thinking_delta) | `thinking_delta` |
| `tool_execution_start` | `tool_status_change` + `tool_call` |
| `tool_execution_end` | `tool_status_change` + `tool_result` |
| `compaction_start/end` | `tool_status_change` (isCompaction) |
| `auto_retry_start/end` | `tool_status_change` (retryAttempts) |
| `agent_settled` | `run_ended` |
| `extension_ui_request` (审批类) | `tool-approval:request`（经 approval.rs；由 `pi-extension/approval.ts` 的 `tool_call` 钩子发起）。裁决回写为拦截理由：审批超时与用户拒绝给模型的措辞不同 |
| `response` 且 `success:false` 且无 `id` | `run_ended{failed}`（preflight 失败兜底） |
| 其余全部事件 | 不转发（内部用于组装 conversation_live 快照） |
