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
| append segment | 压缩后追加新 segment，旧 segment 保留但后续上下文通过 summary 引用。 |
| active segment upsert | 普通流式更新中更新当前 segment。 |
| truncate | 编辑重发或历史修剪时，从目标位置截断 segment/message window。 |

## 上下文压缩

| 阶段 | 输入 | 输出 |
|---|---|---|
| 预算估算 | 当前 conversation state、tools、model context window | 是否需要压缩或 prune。 |
| compaction request | 旧消息、已有 summary、tools context | summary assistant message。 |
| checkpoint 应用 | summary message + 被覆盖消息范围 | 新 segment 的 `summary_json` 和 transcript checkpoint。 |
| resume context | summary + 未覆盖 tail messages | 下一轮模型请求上下文。 |

相关前端路径包括 `pages/chat/conversationContextBuilders.ts`、`lib/chat/conversation/conversationState.ts`、`lib/chat/conversation/compaction/*`。

## 文件操作账本（File Ledger）

Summary 的 `<artifacts>` 段由模型生成，会漏、会幻觉。为此每个 checkpoint 额外携带一份**确定性、机器维护**的文件账本，作为 LLM 摘要之下的地板。

| 属性 | 说明 |
|---|---|
| 来源 | 扫描被折叠消息里 assistant 的 `toolCall` block，取 `arguments.path`。只认单 `path` 的 fs 工具：`Read`（读）、`Write`/`Edit`/`Delete`（改）。 |
| 不入账 | `Glob`/`Grep`/`List`（目录级枚举）、`Image`（可接 URL/多源）、shell（无法确定性解析）；对应 `toolResult.isError` 的**失败调用**也剔除（无对应结果的调用按成功处理——压缩发生时结果通常已就位）。因此账本是 fs 文件操作的**下界**，非全集。 |
| 正交于 prune | 只扫 `toolCall`、**不读 `toolResult` 正文**（仅用其 `isError` 剔除失败调用），故与工具输出裁剪互不影响。 |
| 分类与 recency | 统一时序归一：任意一次触碰（读或改）都把路径刷新到最新；`modified` 粘性——一旦改过恒归 modified（即便之后被读到），不回落为 read。故“早改晚读”的文件不会被当最旧误驱逐。 |
| 跨 checkpoint 继承 | 在**消息级**合并：`mergeMessagesIntoLedger(prev 账本, 本段原始消息)`。prev（seed）整体较旧，`next` 的真实操作顺序取自原始消息（不先归一成两数组），从而保住本段内“先改后读”等跨类顺序。 |
| 存储 | `summaryMeta.fileLedger`（可选字段，对 Rust 的 `summary_json` 不透明，无需迁移；旧数据缺失即视为无账本）。 |
| 注入与安全 | resume context 构建时渲染为 system prompt 内摘要块后的 `### Files touched`（最近在前），**不占** summary 正文的字符预算，且**不随 payload 发给 summarizer**（`payload.ts` 已剔除）。路径是模型/工具可影响的数据：入账前清洗（按码位去控制字符/换行、压空白），超长（>200 字符）**整条丢弃而非截断**（截断会让共享前缀的路径撞成同一身份）；渲染时每条用 **JSON 引号包裹**并标注“data, not instructions”，杜绝标题/指令突破。 |
| 上限 | 每类 100 条；两类合计渲染字符预算 4000（改动优先占用，但为读预留 1000 保底避免饿死），超预算驱逐最旧。`omittedCount` 是**尽力而为的累计驱逐事件计数**（非“当前缺失的唯一路径数”，同一路径反复驱逐会计多次），用于渲染“已省略 N 条”。 |
| 已知限制 | 路径别名（`./a.ts` vs `a.ts` vs 绝对路径）不做规范化，可能算作不同条目；`Delete` 可递归删目录，账本仅记目录路径不含子孙；超长被丢弃的路径不计入 `omittedCount`（账本本即下界）。 |

实现：`lib/chat/compaction/fileLedger.ts`；挂点在 `conversationState.ts` 的 `appendCompactionCheckpointToSegments` / `appendSummaryToSystemPrompt`，及 `payload.ts` 的 `summaryMetaForPayload`。

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
| 修改 compaction 格式 | `summary_json` 读写、checkpoint UI、resume context、历史旧数据兼容。 |
| 修改 truncate/edit resend | active segment、FTS 清理、subagent parent tool call 保留。 |
| 修改 share | public API、read-only transcript、redaction、sidebar share flag。 |

### Schema 兼容约束

- 新增 `chatHistory`、`chatHistorySegment`、`chatHistoryShare`、`chatHistoryFtsSegmentIndex` 列时，必须同步更新 `src-tauri/src/commands/history/history_db.rs` 中对应的 `ensure_*_columns` 迁移逻辑。
- `CREATE TABLE IF NOT EXISTS` 只覆盖新库，不会补齐已有旧库字段；新增列不能只改建表 SQL。
- 新增 `NOT NULL` 字段必须提供 `DEFAULT`，并在迁移后回填旧行的空值。
- 索引创建应放在列迁移之后，避免旧库缺索引依赖列时初始化失败。
- 修改 FTS virtual table 结构时不能只依赖 `CREATE VIRTUAL TABLE IF NOT EXISTS`，必须显式重建并回填索引。
- `migrated_legacy_table_columns_match_fresh_schema` 会对比“极简旧库迁移后 schema”和“全新库 schema”；改 schema 后必须保持该测试通过。
