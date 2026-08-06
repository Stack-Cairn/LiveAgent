# ADR 0001：保留 segment 线性会话模型，不迁 pi-agent-core Session 树

- 状态：已接受（2026-08-06）
- 范围：`crates/core/src/chat/compaction/`、`crates/core/src/chat/conversation/conversationState.ts`
- 结案：`docs/core-arch-debt.md` 第 2 项

## 背景

`crates/core/src/chat/compaction/`（13 文件 2456 行）实现了一整条上下文压缩流水线：
阈值决策、切点选择、payload 序列化、摘要生成与校验、文件账本、非 LLM 降级裁剪。

`@earendil-works/pi-agent-core`（core 侧 0.80.10，前端侧 0.80.6）的
`dist/harness/compaction/` 里有一条**做同一件事**的流水线：

```
shouldCompact / estimateContextTokens / findCutPoint / prepareCompaction
generateSummary / compact / serializeConversation / SUMMARIZATION_SYSTEM_PROMPT
```

两条流水线并行存在，看上去就是典型的重复造轮子。问题因此提出：把 core 迁到库的
Session 树上，删掉这 2456 行？

结论是不迁。理由不是"改起来麻烦"，而是数据结构层面的：两边**寻址会话消息的键不同**，
而 core 这个键已经不是内部实现细节了。

## 决策

1. **core 的 segment 线性会话模型是本仓库唯一的会话真相源**，不迁到库的 Session 树。
2. **`pi-agent-core` 的用途收窄为 Agent 循环 + 工具协议**，即 `Agent` 与 `AgentTool`。
   库的 compaction / session 子系统本仓库不使用。
3. 这条分叉是**有意的设计决定**，不是待还的债。

## 理由

### 一、寻址键已穿透三个硬边界

库用 **entry id** 寻址：`SessionTreeEntry[]`，切点返回 `firstKeptEntryId`（见
`dist/harness/compaction/compaction.d.ts`）。core 用 **`(segmentIndex, messageIndex)`
二元组**寻址。要迁库，就得换键——而这个键穿透了三层：

**1. SQLite schema 主键。**
`crates/backend/src/commands/history/history_db.rs:179` 起的 `chatHistorySegment` 表以
`PRIMARY KEY (conversation_id, segment_index)` 定义；`chatHistory` 表带
`active_segment_index` / `total_segment_count` 列（同文件 :169）。
FTS 侧同样：`chatHistorySegmentFts` 与 `chatHistoryMessageFts` 两张 fts5 虚表都带
`segment_index UNINDEXED` 列，元数据表 `chatHistoryFtsIndex` 也是
`PRIMARY KEY (conversation_id, segment_index)`（:461-513）。
换键 = schema 迁移 + 全量 FTS 重建。

**2. Gateway wire 协议的 rebase 锚点。**
`crates/core/src/chat/conversation/conversationState.ts:90`：

```ts
export type HistoryMessageRef = {
  segmentIndex: number;
  messageIndex: number;
  segmentId: string;
  messageId: string;
  role: string;
};
```

它经 `gatewayBridgeEvents.ts:26` 的 `buildGatewayMessageRefPayload` 转成 snake_case
广播出去。用途是 edit-resend：用户改写某条历史消息后，gateway 广播 `rebased` 事件，
**所有已连接客户端据此在同一点截断自己的 transcript**。换键是破坏性协议变更，
且会打断正在连接的客户端。

**3. 前端渲染定位。**
`crates/frontend/src` 有 71 处引用 `segmentIndex`，跨 conversationState、chatHistory、
bridge readiness、history actions 等模块。

一句话：`segmentIndex` 是写进数据库主键、广播上线的公开契约，不是可以内部重构掉的变量名。

### 二、成本收益不成立

| 项 | 数字 |
|---|---|
| 涉及的 core TS | 10 文件 4823 行（引用 `segmentIndex` / `StoredContextSegment` / `activeSegment`） |
| 涉及的 backend Rust | 7104 行（`chat_history/` 6278 行含 2629 行测试 + `history_db.rs` 826 行） |
| 涉及的前端 | 71 处引用 |
| 净删上限 | 400-450 行 |

库能替掉的只有 `tokenLedger` / `fileLedger` / `summaryPrompt` / `payload` 的一部分。
为了 400 行的收益去动一万多行、外加一次 schema 迁移和一次协议破坏——不成立。

### 三、core 是库的功能超集，迁库等于丢功能

| 能力 | core | pi-agent-core |
|---|---|---|
| 阈值决策 | 双阈值 + 冷却 + 压力阶梯（`policy.ts`）：optimization 1.5× / protection 1.2×；60s 冷却窗；level 0-2 压力阶梯，连续低效压缩推高 level 并加大 prune 力度，但永不硬性拒绝 | `shouldCompact(contextTokens, contextWindow, settings)` 单阈值布尔，无 intent / 冷却 / 压力 |
| 触发点 | `pre-send` / `mid-stream` / `post-tool` 三处（`types.ts:3`，`controller.ts:266,306,367` 分支处理） | 仅发送前一个决策点 |
| 摘要失败降级 | `prune.ts` 非 LLM 裁剪：从旧到新裁工具输出正文，保留最近 N 个用户轮次与保护额度 | 无 |
| token 估算 | CJK 加权（`tokenLedger.ts:9`，`CJK_TOKENS_PER_CHAR = 0.7`），可加性成立 | `estimateTokens` 纯字符启发式 |
| 摘要产物契约 | 10 标签 XML，4 个必填，artifact 行格式校验，CJK 感知的过短下限（`validate.ts`）；校验失败把无效输出回喂做一次 self-repair（`summarizer.ts:227-248` + `summaryPrompt.ts` 的 `buildRepairPromptText`） | 只有一个 `SUMMARIZATION_SYSTEM_PROMPT`，不校验产物 |
| 摘要请求恢复 | 溢出 → 收缩 payload 重试；瞬态错误 → 退避重试；全程 abort 检查（`summarizer.ts:163-249`） | 无 |
| 文件账本 | 跨 checkpoint 继承；路径逐字注入 system prompt 前清洗控制字符防伪造指令（`fileLedger.ts:6,13,41`） | `compact()` 产出 `readFiles`/`modifiedFiles` 数组，不清洗 |
| 摘要语言 | 按 payload 检测输出语言（`summaryLanguage.ts`）；codex 降 `reasoning: "medium"` 避免长思考挤占摘要预算（`summarizer.ts:84-88`） | 无 |

## 后果

**1. 停止追赶库的 compaction API。**
`dist/harness/compaction/` 与 session 树相关 API 的变更、新增能力，对本仓库无效。
不再有"库更新了、我们得跟上"这类待办。

**2. 升级检查面锁定为三项**——只有这些变了才需要动 core：

- `Agent` / `AgentTool`：唯一 import 点是 `crates/core/src/chat/runner/agentRunner.ts:1`
- `@earendil-works/pi-ai` 的消息类型：`Message` / `AssistantMessage` / `ToolResultMessage` / `Context` / `Usage`
- pi-ai 导出的两个工具函数：`getOverflowPatterns` / `isRetryableAssistantError`（`summarizer.ts:4-5`）

前两项升级后跑 `tsc` 即可覆盖；第三项需查 changelog。

**3. `controller.ts` + `policy.ts` + `prune.ts` 共 809 行予以保留。**
（533 + 188 + 88；此前口径的"约 950 行"偏高。）这三个文件是库完全不覆盖的真实业务，
不做"简化成库调用"的重构。

**4. 与 `docs/core-arch-debt.md` 第 1 项的关系。**
本 ADR 只封 compaction 与库的分叉。`crates/frontend/src/lib/chat/compaction/` 那份
**前端副本**仍是真实的债——同一份代码复制两份、两边各自维护——属于债清单第 1 项，
与本决定无关，不受本 ADR 豁免。

**5. 反向约束。**
segment 是本仓库的会话寻址真相源。新功能不得引入第二套会话寻址（entry id、session
tree 或其他）。需要在会话中定位一条消息时，用 `HistoryMessageRef`。
