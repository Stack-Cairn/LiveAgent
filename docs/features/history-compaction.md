# History 与 Context Compaction

## 历史持久化

| 数据 | 表/结构 | 说明 |
|---|---|---|
| Conversation header | `chatHistory` | id、title、created/updated、provider/model、session/cwd、message count、active segment、pin/share 状态。 |
| Segment | `chatHistorySegment` | conversation_id + segment_index 主键，保存 messages_json、summary_json、message window 元数据。 |
| Share | `chatHistoryShare` | public share token、enabled、redact tool content、timestamps。 |
| Segment FTS | `chatHistorySegmentFts` | 聚合 segment 文本检索。 |
| Message FTS | `chatHistoryMessageFts` | message 级检索。 |
| FTS index metadata | `chatHistoryFtsSegmentIndex` | 判断 FTS 是否需要刷新/回填。 |

Rust 实现位于 `src-tauri/src/commands/history/chat_history/*`，数据库建表与兼容迁移位于 `src-tauri/src/commands/history/history_db.rs`。

## V3 Segment 模型

| 概念 | 说明 |
|---|---|
| active segment | 当前继续追加消息的最新 segment。 |
| total segment count | 当前 conversation 的 segment 总数。 |
| summary checkpoint | 一个 segment 可带 `summary_json`，表示前序上下文压缩结果。 |
| append segment | 压缩后追加新 segment，旧 segment 保留，后续请求经 checkpoint bridge 引用 summary。 |
| active segment upsert | 普通流式更新中更新当前 segment。 |
| truncate | 编辑重发或历史修剪时，从目标位置截断 segment/message window。 |

## 上下文压缩

压缩就是又一个流式请求：复用上一次主请求**逐字节相同的前缀**、末尾追加一条指令（缓存共享 fork），失败时逐档降级，最终产出一个 checkpoint 并开启新 segment。

| 位置 | 职责 |
|---|---|
| `lib/chat/compaction/controller.ts` | 每会话状态机 `CompactionController`：唯一入口 `compact()`、`compactManually()`、回滚、终态、observer、token 账本门面、主请求配方 `noteRequest`。 |
| `policy.ts` | 限额公式、`decideCompaction`、保留原话预算、首事件预算、`isFatalProviderError`。 |
| `summarize.ts` / `prompt.ts` / `transcript.ts` | 降级梯与流驱动、计时器、进度；指令与 `parseSummaryOutput`；对话转标签纯文本。 |
| `checkpoint.ts` / `bridge.ts` | checkpoint 标记消息、保留原话选择、deterministic 摘要；请求期 bridge 渲染。 |
| `tokenLedger.ts` / `fileLedger.ts` | 上下文用量账本；文件操作账本。 |
| `lib/providers/runtime/{modelRequest,streamRetry,overflow,abortLink}.ts` | 请求配方与装配、流看门狗与唯一重试层、溢出判定、信号链接。 |
| `pages/chat/runtime/compactionBinding.ts` | 发送链路与手动压缩共用的 sinks 装配和轨迹订阅。 |

### 触发

| 触发 | 调用点 | 说明 |
|---|---|---|
| `pre-send` | agent / text 轮次发送前；子代理 resume | 待发送消息不进摘要与保留池，压缩后原样落在新 segment。 |
| `post-tool` | runner `onBeforeNextTurn`（agent 与子代理） | 仅当 `willContinue`（本批工具结果没有全部 terminate，例如 ExitPlanMode 结束的批次不压）。fork 原样重放 runner 下一轮要发的 `runtimeContext.messages`。 |
| `overflow` | agent / text 轮次的错误路径 | 反应式：`isOverflowError(原始 assistant)` 且本轮尚未恢复过 → 按原 catch 顺序清理（溢出的 assistant 不落地）→ `compact` → 重新冻结任务列表 / 消息总线 / roster → 重试一次。结果不是 `compacted` 就原样抛出原错误；任一请求成功后复位。 |
| `manual` | 用量环确认、WebUI `compact_now` | 仅限空闲（已绑定轮次或压缩在飞返回 busy）；使用率 ≥ 50%（`canManualCompact`）才执行，被拒的探针不在共享账本上留痕；永不走 deterministic。 |

旧的 mid-stream 中止已删除：每次请求前都已检查 ≤ soft，输出又不超过 O，中途中止只会浪费已生成的输出。

### 限额与决策

W = 模型目录 `contextWindow`（含输出），O = `maxOutputToken`（主请求 `max_tokens = O`）：

```
inputCap = W − O
reserve  = clamp(⌊0.05W⌋, 4k, 20k)        两次 usage 锚点之间的估算漂移
hard     = inputCap − reserve             达到即 mustProgress
soft     = hard − clamp(⌊0.05W⌋, 4k, 16k) 唯一的自动触发线
forkFits = total + 2k ≤ inputCap
```

例：200k / 64k → soft 116k、hard 126k；1M / 128k → 836k / 852k。

`decideCompaction` 按序判断：`disabled`（窗口或 O 缺失）→ `no-active-messages` → `in-flight` → manual 门槛 → `overflow`（mustProgress，从 transcript 起步）→ `below-threshold`（< soft）→ `prefix-too-large`（fixed + min(20k, ⌊soft/4⌋) ≥ soft 时只拦 `[soft, hard)`；≥ hard 照样压缩，除非 fixed 本身已 ≥ hard，此时让错误自然暴露）→ `circuit-open` → 压缩（`mustProgress = total ≥ hard`，`startAt = forkFits ? fork : transcript`）。

熔断（自动压缩连续失败 ≥ 2）与防抖动（压缩后不足 2 次调用又满，连续 3 次）只拦 `[soft, hard)`；≥ hard 不受它们拦截，never hard-reject。旧的压力阶梯、冷却与 prune 降级已删除，兜底职责由 deterministic 档承担。

### 摘要降级梯

| 档 | 请求 | 失败处理 | `promptVersion` |
|---|---|---|---|
| fork | 会话最后一次主请求的 `RequestRecipe` 原样重放 + 末尾一条 `buildCompactionInstruction()` 指令：system、tools、`tool_choice`（强制工具放开为 auto）、reasoning、`max_tokens`、缓存键 / sessionId、metadata、wireTail 都与主请求一致；传输经 `prepareTransport` 每次现取（轮换的 key、新 baseUrl / 自定义头即时生效）。锁定缓存热的目标，不 failover。配方 provider / model / 协议 / 服务目标（`targetKey`，同轮 failover 到同 vendor 同模型的 fallback 后只有它不同）与当前主目标不符（重启、换模型、failover）、溢出触发或 `!forkFits` 时跳过。 | 首事件超时不在本层重试（`retryOnStall:false`），直接换档；模型在闭合 `</summary>` 之前发起工具调用即作废本档，工具永不执行。 | `summary-v4` |
| transcript | `TRANSCRIPT_SYSTEM` + 单条 user：`<conversation>{serializeTranscript}</conversation>` + 同一指令；`cacheRetention:"none"`，推理开着降到 low，`maxTokens = min(O, 32k)`，可 failover。距总时限不足 45s 时不进入。 | 停滞可在本层重试（`retryOnStall:true`）。 | `summary-v4-transcript` |
| deterministic | 无 LLM：上一份摘要（超过 8k token 时截掉中段，防止连续兜底单调膨胀）+ `## Unsummarized activity` + 4k 预算的转录（工具结果截到 300 字符），注明自动摘要不可用的原因。仅自动触发、`mustProgress`、且最后一次失败不是 fatal（鉴权 / 配额）时运行。 | — | `summary-v4-deterministic` |

deterministic 兜底的结果是 `completed{degraded}`：轨迹记 `complete`，GUI 弹出降级提示（`chat.compactionDegraded`）。

`serializeTranscript` 输出 `[User]` / `[Assistant]` / `[Tool call] name(args≤500 字符)` / `[Tool result name]` / `[Tool error name]`，工具结果 `clipMiddle` 到 2,000 字符（头 70% + 尾 30%），思考丢弃，图片 / 附件只留占位（不带 base64）；上一份 bridge 原样包进 `<previous_checkpoint>`；预算 `min(64k, ⌊0.5·inputCap⌋)`，从新到旧装入，装不下的标注省略条数。

**计时器**只中止当前档（或当前尝试），绝不中止压缩 scope：

| 计时 | 值 |
|---|---|
| 首事件 | `60s + 30s × ⌈输入 token / 100k⌉`，high 及以上推理再加 60s，上限 300s；首个 committing 事件（text / thinking / toolcall_start）到达即解除。按冷缓存保守估算。fork 档另以 `总时限 − 45s − 5s` 封顶，保证 fork 首事件超时后 transcript 档仍有机会运行（手动压缩 270s 时限下即 220s）。 |
| 空闲 | 有内容之后两个事件间最长 180s。 |
| 总时限 | manual 270s（低于 WebUI 5 分钟的 pending 超时），自动 600s。超时算失败而不是用户中止。 |

**唯一重试层**是 `withStreamRetry`：每次尝试一个链接到上层的子 signal；`firstEventTimeoutMs` / `idleTimeoutMs` / `retryOnStall` 为可选项，不设时行为与原来逐字节一致（主循环目前不启用）。看门狗触发时只中止本次尝试，并把推送的终止事件与 `result()` 都改写成 `stall` 错误；父 signal 中止仍是 `aborted`。摘要每档 `maxAttempts = min(用户重试策略, 3)`，策略 disabled 时尊重。上下文溢出永不重试。旧 summarizer 的自有重试、shrink、repair 与正则错误分类全部删除。

**结果判定**（按序）：用户停止或 scope 中止 → `AbortError`；本档被总时限 / tool-call 结束 → 已有闭合 `<summary>` 就收下，否则记 `deadline` / `tool-call`；无因的 `aborted` → `stall`；溢出 → `overflow`；其他错误 → 能收下就收下，否则 `fatal` / `stall` / `transient`；正常结束交给 `parseSummaryOutput`：只剥 `<summary>` 之前的 `<analysis>` 草稿，取首个 `<summary>` 到**最后一个** `</summary>`，fork 必须闭合（`pause_turn` 会映射成 stop），transcript 在 stop 时可收全文；拒绝空结果、未闭合的非 stop 结束、估算超过 `max(8k, 0.3·tokensBefore)` 的结果。没有 schema、信号校验与 repair 往返。

**进度**：文本与语言无关，例如 `0:41`、`12.3k · 0:41`、`… · 0:41`（思考中）、`↻2/3 · 0:52`、`→ transcript · 1:10`；本地每 2s 刷新一次（时钟与 token 数）；经 `tool_status{isCompaction:true}` 上线的只在阶段变化、重试、换档时发出，外加距上次上线满 20s 的心跳（刷新 `lastEventAt`，又不挤占 gateway 事件环）。进度回调绑定在 `(operationId, 档)` 上，`closed` 在清空状态之前同步置位，迟到的回调不会在压缩结束后重新点亮状态。共享组件 `CompactingText` 把它显示成弱化后缀，只认以 `m:ss` 结尾的文本（旧桌面端发的整句中文状态不显示）。

### 传输层兜底

| 项 | 说明 |
|---|---|
| `isOverflowError`（`overflow.ts`） | 溢出判定单一真源：pi-ai `isContextOverflow` + `exceeds context limit`，剔除 pi-ai 的无 body 4xx 模式与限流；文本带鉴权 / 配额 / 服务端状态（401–403、5xx、quota、billing 等）时不认 pi-ai 的宽泛兜底模式（`too many tokens` / `token limit exceeded` / `exceeds the limit of N`）。`withStreamRetry` 里用户自定义的重试子串优先于溢出守卫。输入是原始 `AssistantMessage`（runner 用 `AssistantResponseError` 带出），复用于 `withStreamRetry` 的不重试守卫、failover 的不可切换判定与反应式压缩。 |
| Rust `with_transport_defaults` | 全部 async 出网 client（含 LLM 代理 `cached_client()` 与本地反代上游）：`connect_timeout` 20s、TCP keepalive 30s / 间隔 10s / 3 次、`read_timeout` 30 分钟（单次读的空闲超时，作为死流兜底，须长于 pro 档模型经缓冲中转的整段静默）。keepalive 只探测第一跳，走系统代理时探测的是本地回环。 |

### Checkpoint v4

| 项 | 契约 |
|---|---|
| 标记消息 | `api:"liveagent-compaction"`、零 usage、`compactionStats{conversationTokens, summarizer{inputTokens, outputTokens, cacheReadTokens}}`；`cacheReadTokens` 是 fork 缓存命中遥测。`summaryMeta.generatedBy.providerId/model` 记**实际服务**了摘要的目标（transcript 档可能已 failover）。 |
| 正文 | `content` 为 Markdown，`format:"plain-text-v1"` 不变；`promptVersion` 标明产出档。 |
| `contextTokensAfter` | `deriveContextTokens(buildContext(checkpointState))`，即新前缀的 fixed + bridge，在组合待发送消息**之前**计算并写入 `stats.contextTokensAfter`，作为用量环锚点。账本 rebase 时以 `after − estimate(bridge)` 作为 fixed 下界（旧 checkpoint 的值不含 bridge，扣完仍约等于 fixed）。 |
| `INTERNAL_RESUME_MESSAGE_TEXT` | 不再生成；常量与 message-0 过滤保留，兼容旧数据。 |

### Checkpoint bridge 与保留原话

| 项 | 契约 |
|---|---|
| bridge | 摘要只经 `<context_checkpoint>` bridge 进入请求（system prompt 不再含摘要，前缀缓存跨压缩稳定）。`buildRequestContext(state, { includeCheckpointBridge: true })` 每次请求现算：segment 首条是 user 时作为前置文本块合入（全局避免连续两条 user，严格交替的转换器 / 中转会拒收），否则（运行中压缩后）单独成一条 user 消息，之后追加的 wire-only user 消息（plan 补提交提醒）经 `appendWireUserMessage` 并进这条 bridge，沿用其 id、照样不落地；按 summary 对象身份记忆化，整个 segment 期间字节与对象身份稳定。插值内容中的 `</summary`、`</user_message`、`</context_checkpoint`、`</files` 一律中和。摘要、保留原话、账本全空时不接；旧 checkpoint 用同一渲染器（没有 `<user_messages>`），升级后首次请求一次缓存未命中，无需迁移。 |
| 只在请求里 | bridge 永不持久化、永不 emit：runner 的 emitted 切片与 `appendMessagesToConversation` 入口都过 `stripCheckpointBridges`，持久化顺序仍是 assistant → checkpoint → assistant。主请求、账本、用量环、压缩估值、子代理开 bridge；标题、记忆抽取、App 级 context 不开。 |
| `retainedUserMessages` | summary **顶层**可选字段（不放 `summaryMeta`）。候选池 = 上一份保留集 + 被压缩 segment 的真实用户消息，按 id（或时间戳 + 文本）去重；排除 bridge、内部续跑消息与调用方判定不可保留的消息。按时间正序，上传元数据剥离（附件只留名字、粘贴引用只留标签，图片 → `[image]`）。预算 `clamp(⌊0.5·soft⌋ − fixed − summary, 0, 20k)`，thrashing 时为 0；从新到旧整条装入，第一条放不下的在剩余 ≥ 256 token 时截断并标记 `truncated`。读取时逐项校验，坏数据丢弃。对 Rust 不透明，旧 checkpoint 缺失即视为无。 |
| 子代理标签 | 委派 / 续跑消息带 `liveAgentSubagentTask`（保留时只取任务原文），bus 刷新带 `liveAgentSynthetic`（整条排除）；无标签旧数据按首行兜底排除。随 `messages_json` 持久化，provider 转换忽略。 |

实现：`lib/chat/compaction/bridge.ts`、`lib/chat/compaction/checkpoint.ts`（`selectRetainedUserMessages`）、`lib/subagents/prompts.ts`（`resolveSubagentRetainedUserText`）。

### 编排与持久化

`CompactionController.compact()` 时序：

1. 用户已停止 → `AbortError`。
2. base 在调用时现推：pre-send 为当前状态去掉待发送消息，其余触发即当前状态（edit-resend 替换后的状态不会被旧快照写回库）。
3. 计算 total：manual 用临时账本或用量环快照；自动触发 rebase 共享账本。`decideCompaction` 不通过返回 `skipped`。
4. 同步置 `inFlight` → `onProceed` → `publishRunning`（新 operationId、observer `onStart`、`running` 状态、`tool_status` "0:00"）。
5. 回滚快照：非 pre-send 为调用时状态；pre-send 且本次发送清空了输入框时为 base 并还原输入框（同时撤销首次持久化已入库的待发送消息，防止孤儿消息与重发重复）；其余 pre-send（队列、WebUI、edit-resend 等）不建快照，消息随普通中止提交保留。输入框期间又有了新内容（草稿或附件放不回去）时同样不撤销，`restoreComposer` 返回 false，消息随普通中止提交保留。
6. 降级梯 → 选取保留原话 → `applyCompactionCheckpoint` → 写入 `contextTokensAfter` → pre-send 把待发送消息追加进新 segment。
7. persist 之前再查一次 Stop 与 operation 是否过期，任一命中走 `AbortError` + 回滚。
8. `sinks.persist(composed)` 是**提交点**：返回 `false` / `null` → `failed`，什么都不落地；成功后立即作废回滚快照，此后忽略 Stop 与过期、绝不抛错，依次 apply（pre-send `applyState`，其余 `applyStateMidRun` 并清空 live transcript）→ `completed{degraded?}` → `queueCheckpoint` → `onCompacted`（记忆注入失效）→ 账本 rebase → 熔断 / 防抖动计数。pre-send 一次 IPC 原子地封存旧 segment 并插入含待发送消息的新 segment；persist 返回盖好 revision 的状态时落地那一份。
9. 其余异常一律 `failed`（轨迹记 error，不误记 aborted）；`finally` 关闭进度、释放 scope、清 `inFlight` 与 `tool_status`。

用户停止（`isAbortOutcome` 只认 userStop、压缩 scope 与过期 operation，不认 `isAbortLikeError`）由 `handleTurnAbort` 统一回滚：恢复状态与输入框并补持久化。

### 保留的契约

| 契约 | 如何保留 |
|---|---|
| `StoredSummaryMessage` / `summary_json` | 只增加可选字段，`format` / `strategy` 字面量不变；Rust 仍视为不透明。 |
| checkpoint 标记 | `api:"liveagent-compaction"`、零 usage、`compactionStats`。 |
| 持久化顺序 | assistant → checkpoint → assistant；bridge 只在请求里。首轮反应式压缩形成 user → checkpoint → assistant，拼接器可处理。 |
| `contextTokensAfter` | 持久化前写入、作为用量环锚点。 |
| revision CAS | 先组合再持久化，落地盖好 revision 的结果。 |
| 线上事件 | `tool_status{isCompaction}`、checkpoint token 事件、`manual_compaction_result`、`compact_now`（探针通过才 accepted，拒绝无痕）、`finishGatewayRunMirror` 的发射点不变，只有状态文本内容变化。Gateway 与 WebUI 无需改动。 |
| 轨迹 | `compaction_start` / `compaction_end` 同一个 observer，每个 operationId 恰好一个终态，降级算 `complete`。 |
| `CompactionStatus` | union 不变，`completed` 只增加可选 `degraded`。 |
| 其他 | segment 模型、`withConversationWriteLock`、`deriveScope` 与 Stop 回滚、TokenLedger 语义不变。 |

## 文件操作账本（File Ledger）

Summary 正文由模型生成，路径会漏、会幻觉。为此每个 checkpoint 额外携带一份**确定性、机器维护**的文件账本，作为 LLM 摘要之下的地板。

| 属性 | 说明 |
|---|---|
| 来源 | 扫描被折叠消息里 assistant 的 `toolCall` block，取 `arguments.path`。只认单 `path` 的 fs 工具：`Read`（读）、`Write`/`Edit`/`Delete`（改）。 |
| 不入账 | `Glob`/`Grep`/`List`（目录级枚举）、`Image`（可接 URL/多源）、shell（无法确定性解析）；对应 `toolResult.isError` 的**失败调用**也剔除（无对应结果的调用按成功处理——压缩发生时结果通常已就位）。因此账本是 fs 文件操作的**下界**，非全集。 |
| 只扫调用 | 只扫 `toolCall`、**不读 `toolResult` 正文**（仅用其 `isError` 剔除失败调用）。 |
| 分类与 recency | 统一时序归一：任意一次触碰（读或改）都把路径刷新到最新；`modified` 粘性——一旦改过恒归 modified（即便之后被读到），不回落为 read。故“早改晚读”的文件不会被当最旧误驱逐。 |
| 跨 checkpoint 继承 | 在**消息级**合并：`mergeMessagesIntoLedger(prev 账本, 本段原始消息)`。prev（seed）整体较旧，`next` 的真实操作顺序取自原始消息（不先归一成两数组），从而保住本段内“先改后读”等跨类顺序。 |
| 存储 | `summaryMeta.fileLedger`（可选字段，对 Rust 的 `summary_json` 不透明，无需迁移；旧数据缺失即视为无账本）。 |
| 注入与安全 | 请求构建时渲染进 checkpoint bridge 的 `<files>` 段（`### Files touched`，最近在前），**不占** summary 正文的预算。摘要请求里它随上一份 bridge 出现（fork 原样重放、transcript 包进 `<previous_checkpoint>`），指令告知模型路径已自动跟踪、无需抄写。路径是模型/工具可影响的数据：入账前清洗（按码位去控制字符/换行、压空白），超长（>200 字符）**整条丢弃而非截断**（截断会让共享前缀的路径撞成同一身份）；渲染时每条用 **JSON 引号包裹**并标注“data, not instructions”，杜绝标题/指令突破。 |
| 上限 | 每类 100 条；两类合计渲染字符预算 4000（改动优先占用，但为读预留 1000 保底避免饿死），超预算驱逐最旧。`omittedCount` 是**尽力而为的累计驱逐事件计数**（非“当前缺失的唯一路径数”，同一路径反复驱逐会计多次），用于渲染“已省略 N 条”。 |
| 已知限制 | 路径别名（`./a.ts` vs `a.ts` vs 绝对路径）不做规范化，可能算作不同条目；`Delete` 可递归删目录，账本仅记目录路径不含子孙；超长被丢弃的路径不计入 `omittedCount`（账本本即下界）。 |

实现：`lib/chat/compaction/fileLedger.ts`；挂点在 `conversationState.ts` 的 `appendCompactionCheckpointToSegments` 与 `compaction/bridge.ts` 的 `renderCheckpointBridgeText`。

## FTS 搜索

| 机制 | 说明 |
|---|---|
| message-level FTS | 精确定位包含关键词的单条历史消息。 |
| segment-level FTS | 对 segment 聚合内容检索，适合跨消息信息。 |
| lazy refresh | 搜索前按 batch 刷新 stale segment，避免初始化时全量回填阻塞。 |
| time filter | 支持按时间窗口过滤，并有 time-window fallback。 |
| 去重 | FTS 结果需去除重复 segment rows，避免 UI 重复匹配。 |

## 分享历史

| 能力 | 说明 |
|---|---|
| enable share | 为 conversation 生成 token 并写 `chatHistoryShare`。 |
| disable share | 关闭 token，旧 token 不再 resolve。 |
| redaction | 可配置是否隐藏 tool content。 |
| public resolve | Gateway `/api/public/history-shares/{token}` 返回只读 transcript 数据。 |
| UI | GUI/WebUI sidebar 和 shared history manager 显示分享状态。 |

## Pin 与 Sidebar 排序

| 字段 | 说明 |
|---|---|
| `is_pinned` | 是否置顶。 |
| `pinned_at` | 置顶时间，用于置顶分组排序。 |
| `updated_at` | 非置顶或同组内 fallback 排序。 |

GUI/WebUI 的 sidebar 都依赖 summary 中的 pin/share 字段，因此新增历史字段时必须同步 Rust summary、proto、Gateway payload 和两端 UI。

### 工作空间会话树

Desktop 与 WebUI 共用工作空间侧栏。置顶内容与普通工作空间分成两个独立折叠的区域；置顶会话只在置顶区域出现，置顶工作空间可继续展开其会话。点击工作空间标题即可展开或收起，每次默认显示 10 条会话，通过“继续加载会话”追加。全局搜索命中的会话会自动展开并定位，即使它超出当前会话页或工作空间折叠数量上限。

鼠标拖动工作空间可以调整同组内顺序；置顶会话与置顶工作空间支持混合排序。拖动时显示蓝色插入线和标题预览，按 Escape 可取消，按住 Alt 拖动保留工作台拖拽行为。顺序保存在 `system.workspaceProjectOrder` 与 `system.sidebarPinnedOrder`，重启后继续使用；排序不改变置顶状态或分组归属。

会话行悬停时提供置顶和更多菜单；删除、转移到其他工作空间等操作位于更多菜单中，移动端长按会话标题打开同一菜单。工作空间行悬停时提供新建会话与更多菜单。“选择多个”按钮再次点击即可退出多选。

Desktop 支持将外部文件夹或文件树中的目录拖入工作空间区域，将其添加为工作空间。工作空间排序不会触发文件夹导入提示。新建工作空间弹框保留直接打开文件夹与完整 Git 克隆表单，Desktop 与 WebUI 使用同一实现。

## WebUI 大历史优化

| 优化 | 说明 |
|---|---|
| `max_messages` | WebUI `history.get` 可只请求 tail window。 |
| `has_more` | 响应中标记是否还有更早消息。 |
| `total_message_count` / `returned_message_count` | 让 UI 明确当前窗口范围。 |
| worker parser | 大 `messages_json` 在 WebUI 可交给 worker 解析，减少主线程卡顿。 |

## 改造注意事项

| 改动 | 必查 |
|---|---|
| 修改 history schema | 迁移兼容、测试、Gateway proto、WebUI type。 |
| 修改 compaction 格式 | `summary_json` 读写、checkpoint UI、checkpoint bridge 渲染、历史旧数据兼容。 |
| 修改 truncate/edit resend | active segment、FTS 清理、subagent parent tool call 保留。 |
| 修改 share | public API、read-only transcript、redaction、sidebar share flag。 |

### Schema 兼容约束

- 新增 `chatHistory`、`chatHistorySegment`、`chatHistoryShare`、`chatHistoryFtsSegmentIndex` 列时，必须同步更新 `src-tauri/src/commands/history/history_db.rs` 中对应的 `ensure_*_columns` 迁移逻辑。
- `CREATE TABLE IF NOT EXISTS` 只覆盖新库，不会补齐已有旧库字段；新增列不能只改建表 SQL。
- 新增 `NOT NULL` 字段必须提供 `DEFAULT`，并在迁移后回填旧行的空值。
- 索引创建应放在列迁移之后，避免旧库缺索引依赖列时初始化失败。
- 修改 FTS virtual table 结构时不能只依赖 `CREATE VIRTUAL TABLE IF NOT EXISTS`，必须显式重建并回填索引。
- `migrated_legacy_table_columns_match_fresh_schema` 会对比“极简旧库迁移后 schema”和“全新库 schema”；改 schema 后必须保持该测试通过。
