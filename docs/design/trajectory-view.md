# 轨迹视图（Trajectory View）设计与实现

轨迹视图是会话正文之外的第二种投影：它把一次 Agent 会话按「输入 → 模型请求 → 工具执行 → 子代理 → 压缩」展开，用于回答以下问题：

- 模型这一轮实际看到了什么 System Prompt 和工具目录；
- 首个模型侧输出何时出现，时间花在 TTFT 还是解码；
- 哪个 provider / model 真正完成了请求，是否发生 failover；
- 工具、子代理和上下文压缩的开始、结束、错误及中断关系；
- WebUI 断线重连、历史分页、编辑重发后，诊断数据是否仍与权威历史一致。

信息架构参考 deepseek-harness 的 trajectory 视图，但事件采集、生命周期、持久化、远端传输和宿主能力全部按 LiveAgent 自身的运行时重新实现，而不是把 harness 的前端组件孤立复制进来。

## 当前决策摘要

| 项 | 实现 |
|---|---|
| 埋点粒度 | turn、provider step、首输出、retry、tool、subagent、compaction、runtime context。 |
| Prompt 快照 | 按稳定槽位分段哈希，header 只保存 sectionId 引用。 |
| 正文 | 不重复写入事件；从当前已加载转录窗口按稳定 messageId / turn / step 汇合。 |
| 桌面实时 | recorder 同步发布到本地 bounded live store。 |
| Web 实时 | `ChatEvent(type=trajectory)` 在 transcript seq 门之前分流并按事件身份去重。 |
| 断线恢复 | 连接 false→true 后重新拉取最新 `trajectory.fetch` 窗口，与实时数据幂等合并。 |
| 存量会话 | 从 messages 降级推导结构，不伪造时间。 |
| 持久化 | 事件随 `chatHistorySegment`；Prompt 分段存 `chatTrajectorySection`。 |
| 历史生命周期 | 分支、编辑重发、截断和会话删除都同步处理轨迹及分段引用。 |
| 子代理 | 事件只记 runId；视图按实际引用的 runId 定向、批量读取。 |
| 挂载点 | GUI 与 WebUI 共用「对话 / 轨迹」tab 和同一套共享组件。 |

## 分层

```text
crates/agent-ui/src/lib/trajectory/
  types.ts             线格式、ledger、视觉记录类型
  sections.ts          Prompt 分段、内容哈希、精确重组
  eventLog.ts          事件流 → 规范化 ledger
  contentIndex.ts      已加载正文 → turn/step/call 索引
  fromMessages.ts      存量会话降级推导
  layout.ts            ledger + 正文 + 子代理 → 视觉记录
  timeline.ts          sequence / duration 三泳道投影
  liveStore.ts         幂等、限额、LRU 的实时事件缓存
  searchIndex.ts       搜索索引
  subagentRuns.ts      子代理消息骨架解析

crates/agent-ui/src/components/trajectory/
  TrajectoryView.tsx   数据收敛与视图外壳
  TrajectoryTimeline   时间轴
  TrajectoryTable      可虚拟化列表
  details/*            详情 tab

crates/agent-gui/src/lib/trajectory/
  recorder.ts          主运行时埋点
  recorderRegistry.ts  跨轮 recorder 生命周期
  persistenceQueue.ts  批量、顺序落盘
  liveTrajectory.ts    桌面端本地实时桥

crates/agent-gui/src-tauri/src/commands/history/chat_history/
  trajectory.rs            事件与 Prompt 分段持久化
  trajectory_window.rs     segment 窗口读取
  trajectory_lifecycle.rs  分支 / 编辑重发裁剪
  trajectory_subagents.rs  定向子代理批量读取

crates/agent-gateway/web/src/lib/trajectory/
  liveTrajectory.ts    WebUI 实时分流与缓存
```

共享纯逻辑不依赖 Tauri 或 Gateway；两端差异只通过 `TrajectoryHost` 能力对象注入。

## 事件模型

事件是紧凑 JSON。`k` 是判别式，`at` 是 Unix 毫秒，`t` 是绝对 turn，`s` 是 provider step。

| `k` | 载荷 | 语义 |
|---|---|---|
| `user` | `t, at, mi?, id?, tx?` | 开启 turn。`mi` 是全会话 messageIndex，`id` 是稳定消息 ID。 |
| `context` | `t, at, src?, tx?` | 动态上下文注入；`tx` 仅保存有界预览，全文进 runtime section。 |
| `header` | `at, hid, sec, ch, prev?` | 请求边界的 Prompt / 工具快照。 |
| `step_start` | `t, s, at, hid?` | 一次真实 provider 请求开始。 |
| `first_token` | `t, s, at` | 首个模型侧输出：text、thinking、tool call/delta、hosted search 或 final-only assistant。 |
| `step_end` | `t, s, at, st, u?, p?, m?, api?, sr?, err?` | 请求结束及实际 provider/model/api。 |
| `retry` | `t, s, at, n, max?, delay?, err?` | 同一请求的重试。 |
| `tool_start` | `t, s, at, id, n, a?` | 工具真正开始执行；参数为有界预览。 |
| `tool_end` | `at, id, err?, sum?, run?` | 工具终态；`run` 是派生子代理 runId。 |
| `compaction_start` | `t, at` | 上下文压缩开始；`t=null` 表示轮次之间的手动压缩。 |
| `compaction_end` | `t, at, st, before?, after?, err?` | 压缩终态和 token 前后值。 |
| `turn_end` | `t, at, st, err?` | turn 终态。 |

`st` 为 `running | complete | error | aborted`。事件只增字段，不改变旧字段语义。

### 为什么 user 同时保存 `mi` 与 `id`

尾部历史窗口可能只加载真实 Turn 93 之后的消息。如果仅从当前数组重新数用户消息，正文会错误地从 Turn 1 开始。现在正文优先使用稳定 `messageId` 与事件中的绝对 turn 对齐。早期开发版本只保存了全会话 `mi`；读取轨迹窗口时，SQLite 会跨 segment 按全局下标找回与历史正文相同的稳定消息 ID，再把增强后的事件交给共享 UI。不能直接使用 UI `messageRef.messageIndex`，因为它是 segment 内局部下标。

## Prompt 分段与旧数据兼容

线格式中的槽位顺序已经持久化，因此只能向末尾追加，不能重排：

| 线格式下标 | 槽位 | 来源 |
|---:|---|---|
| 0 | `base` | 会话基础 System Prompt。 |
| 1 | `agent` | 当前 Agent Prompt。 |
| 2 | `skills` | Skills Prompt。 |
| 3 | `memory` | Memory Prompt。 |
| 4 | `toolsSuffix` | provider 边界追加的工具运行规则。 |
| 5 | `toolCatalog` | 序列化工具 schema；它是请求参数，不进入 System Prompt 字符串。 |
| 6 | `runtime` | roster、父消息总线、当前 run task-list 等动态运行时上下文。 |

旧记录只有前六项，读取时第 4/5 项仍然分别是 `toolsSuffix/toolCatalog`。`runtime` 被追加在第 6 项，保证旧数据不会错位。

模型实际看到的 Prompt 重组顺序则是：

```text
base → agent → skills → memory → runtime → toolsSuffix
```

核心段使用聊天上下文构建器的 `trim + "\n\n"` 规则；`toolsSuffix` 使用 provider 边界规则追加。每次请求前会把这些段重组并与 `context.systemPrompt` 逐字比较。若未来新增了未分段注入导致不一致，recorder 会告警并保存 provider 边界的精确全文作为诊断兜底，而不是展示一个看似完整但实际错误的 Prompt。

sectionId 为：

```text
s_ + sha256(content) 前 16 个十六进制字符
```

分段内容按会话隔离，删除会话时由外键整体回收。

## 持久化与迁移

历史库 schema 版本为 **v3**。从既有 v2 升级时幂等补齐：

```sql
ALTER TABLE chatHistorySegment
  ADD COLUMN trajectory_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE chatHistorySegment
  ADD COLUMN trajectory_truncated INTEGER NOT NULL DEFAULT 0;
```

并创建：

```sql
CREATE TABLE IF NOT EXISTS chatTrajectorySection (
  conversation_id TEXT NOT NULL,
  section_id      TEXT NOT NULL,
  slot            TEXT NOT NULL,
  content         TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, section_id),
  FOREIGN KEY (conversation_id) REFERENCES chatHistory(id) ON DELETE CASCADE
);
```

关键原则：

- 轨迹 segment 必须先存在，append 不会偷偷创建孤儿 segment；
- 单 segment 事件上限 8 MiB，触顶后保留已有事件并持久化 truncated 标记；
- 单 section 上限 1 MiB，过大 section 允许诊断降级但不影响聊天；
- section 写入校验 SHA-256 内容寻址与合法槽位；
- 读取单个损坏 segment 时只标记该窗口不完整，其余 segment 继续返回；
- 分支只复制保留前缀引用的 section；编辑重发清理失去引用的 section。

## 正文汇合

事件流刻意不重复保存 assistant 正文、工具完整输出和附件二进制。轨迹视图从已加载的转录窗口建立：

- `userByTurn`
- `assistantByStep(turn, step)`
- `toolByCallId`

稳定消息 ID 把尾部窗口映射回绝对 turn；工具使用 callId 对齐。向前分页时视觉 `index` 会变化，但 `recordId` 由业务身份组成，因此选中、React key 和折叠状态不会因前插历史而跳错。

同一毫秒产生的多条 context/input 不再仅用时间戳作为 ID，而是组合 turn、messageId/messageIndex、source、text 和 ordinal，避免详情映射相互覆盖。

## 实时通路与断线收敛

### 桌面端

recorder 每次 emit 同时：

1. 进入顺序落盘队列；
2. 发布到桌面本地 live store；
3. Gateway 可用时进入 chat ingress。

因此保持轨迹页打开时，step、工具和压缩都会即时出现，不需要切换会话重新挂载。

### WebUI

轨迹事件不属于聊天转录。它在 transcript 的 `lastSeq` 去重门之前分流，因为运行快照并不包含轨迹；若先推进 transcript cursor，断线重放中的低 seq 轨迹会被误删。

实时 store 使用完整规范化事件作为身份，精确重放是 no-op。资源上限为：

- 每会话最多 20,000 条实时事件；
- 全局最多 100,000 条；
- 最多 64 个会话 bucket；
- 超限按每会话旧事件裁剪和全局 LRU 回收。

连接从断开恢复后，Web Host 触发 `TrajectoryView` 重新读取最新尾部 `trajectory.fetch` 窗口；当前画面在请求期间保留，成功后用权威窗口替换 persisted tail，再与 live events 幂等合并。重拉失败只标记 incomplete，不清空最后一份可用诊断数据。

## 压缩埋点

pre-send、mid-stream、post-tool、manual 四条压缩路径统一通过 `CompactionController` observer：

- `publishRunning` 是唯一开始点；
- `settleCompleted` / `settleFailed` / abort teardown 是终点；
- 每个开始严格对应一个 `complete | error | aborted` 终态；
- 用户取消、强制解绑和晚到的 summarizer completion 不会产生重复终态；
- `tokensBefore/tokensAfter` 在终态后清理，不能污染下一次压缩。

observer 是诊断通道，回调抛错不会影响压缩主路径。

## 子代理

主事件流只在父工具的 `tool_end.run` 保存 runId，不搬运子代理完整消息。

轨迹视图扫描当前 ledger 实际引用的 runId，只请求尚未加载的项：

- Web Host 每批最多 128 个 ID；
- 后端单请求最多 256 个唯一 ID；
- 后端按 parent conversation 作用域，用两条 SQL 批量读取 run header 和 segment；
- 返回顺序与请求 ID 顺序一致；
- 缺失 run 被跳过，不会把其他会话同名/相邻运行混进来；
- 不再依赖“最近 64 条运行”的列表接口，也不存在 N+1 `load`。

布局层仍然只接收 `subagentRuns` 纯数据并展开为 SUBTOOL 行。

## 文件跳转

详情中的 Markdown 文件链接和用户附件复用 LiveAgent 已有的 `ChatFileLink` 安全导航链路：

- 只传结构化 `path/source/line/endLine/column`；
- 相对路径在当前会话 workdir 中解析；
- 桌面端和 WebUI 使用与聊天正文相同的打开、预览和文件树 reveal 行为；
- 宿主不提供 `openFileLink` 时，附件详情保持只读，不渲染伪交互。

## UI

| 组件 | 职责 |
|---|---|
| `ConversationViewTabs` | 对话 / 轨迹切换。 |
| `TrajectoryToolbar` | Duration、Turn/Call 折叠、搜索。 |
| `TrajectoryTimeline` | Input / Model / Tools 三泳道。 |
| `TrajectoryTable` | 长列表虚拟化、选择与焦点。 |
| `DetailsPanel` | System Prompt、工具目录、diff、输入输出、时序、用量、原始数据等详情。 |

投影模式：

- `sequence`：记录等宽，展示结构顺序；
- `duration`：按真实耗时排宽并压缩无操作覆盖的空闲区间。

assistant 块内部按 TTFT 与 decoding 比例分段；无可靠时间的存量会话强制使用 sequence。

## 存量会话降级

没有真实 trajectory events 时，`fromMessages.ts` 从已加载消息推导 turn、step、tool 和 usage。所有时间字段保持 `null`，不会使用消息时间戳差值伪造工具或模型耗时。

旧会话升级后可能出现“旧轮次无事件、新轮次有事件”的混合历史。视图会用首个/后续稳定 messageId 锚点反推可见旧轮次的绝对 turn，只对事件未覆盖的 turn 补入降级结构；有事件的 turn 始终以真实 ledger 为权威。点击“加载更早轨迹”时会同时请求对应聊天历史正文，避免只出现事件骨架而详情为空。此时 Duration 仍可展示有真实时间的部分，但界面会明确提示旧操作被省略。

可用能力：结构、正文、搜索、折叠、工具详情。不可用能力：真实 Duration、TTFT、吞吐和 System Prompt 历史快照。

## 错误与降级

| 场景 | 行为 |
|---|---|
| recorder / observer 抛错 | 捕获并告警，聊天主路径继续。 |
| segment JSON 损坏 | 只丢该段并标记窗口 incomplete。 |
| section 拉取失败 | 当前详情 tab 展示重试，其余视图正常。 |
| section 缺失/过大 | 保留事件骨架，详情显示不可用。 |
| turn / tool / compaction 被取消 | 收敛为 `aborted`，不悬挂 running。 |
| WebUI 重放与 persisted 重叠 | live store 和 ledger 双层幂等去重。 |
| WebUI 连接恢复 | 以最新 `trajectory.fetch` 窗口重新对账。 |
| 当前窗口缺少早期正文 | 用 messageId 对齐已加载部分；向前分页后自然补齐。 |

## 测试矩阵

### TypeScript / Node

- event 乱序、重复、损坏、tool_end 先到、压缩配对；
- 绝对 Turn 93 的尾部窗口正文对齐；
- 同毫秒 input recordId 唯一；
- 旧六槽兼容与七槽 Prompt 精确重组；
- runtime context、tool-first TTFT、DeepSeek failover 元数据；
- compaction abort exactly-once；
- Web 低 seq 重放仍进入轨迹、精确重放幂等；
- live store 每会话/全局/LRU 上限；
- 300 个子代理 ID 分成 128/128/44；
- 附件结构化文件目标和详情点击回调；
- 时间轴、搜索、折叠、虚拟化、详情呈现。

### Rust / SQLite

- 新库与 v2→v3 迁移；
- append 顺序、损坏段隔离、容量上限；
- section 内容寻址、会话隔离、删除回收；
- 分支/编辑重发轨迹裁剪；
- segment 窗口分页；
- 70 个子代理运行定向批量读取、父会话隔离、请求顺序、去重、缺失 ID 与 256 上限。

## 验证门禁

```text
pnpm build:gui
pnpm build:webui
pnpm lint:ui
pnpm lint:gui
pnpm lint:webui
pnpm test:gui
pnpm test:webui
pnpm check:ui-boundaries
cargo test / cargo check（具备系统依赖时）
go build ./...
go test ./...
make proto-check
git diff --check
```

Tauri 完整 crate 在 Linux CI/服务器上还需要系统 `dbus-1` 开发包等原生依赖；纯轨迹 SQLite harness 可在不链接 GUI 系统库的情况下验证迁移和数据层。
## Implemented release invariants

The production implementation additionally enforces the following invariants discovered during integration testing:

- Existing `user_version = 2` databases migrate to schema v3 before any trajectory command runs; the migration adds both segment event columns and the content-addressed section table atomically.
- Transcript bodies and trajectory events use independent lazy windows. Body joins align the visible transcript tail to absolute ledger turn numbers instead of restarting at Turn 1.
- Desktop recorder events feed a bounded local live store. WebUI splits trajectory frames before the transcript sequence cursor. Both surfaces quietly reconcile against the persisted SQLite tail after terminal events, edit-resend rebases, and WebUI reconnects.
- Every compaction observer start has exactly one `complete`, `error`, or `aborted` end. A user cancellation never leaves a running interval behind.
- Prompt sections are accepted only when they reconstruct the exact sanitized provider request. Dynamic roster, message-bus, and task-list injections are folded into the final memory/runtime section; any future mismatch falls back to one exact content-addressed base section rather than displaying an approximate prompt.
- The first assistant-side output can be text, thinking, hosted search, or a tool-call delta. All four close TTFT through the same idempotent first-token marker.
- Provider/model/API metadata comes from the committed assistant response, so failover rounds identify the target that actually answered.
- Record identity is independent of display index and disambiguates same-millisecond context events. Edit-resend clears live tails only after the database rebase succeeds and then forces an authoritative reload.

