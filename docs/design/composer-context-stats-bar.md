# Composer 上下文统计状态栏（Conversation Stats Bar）实现方案

> 状态：设计稿（未实施）
> 参照物：DSH 输入框下方的会话统计状态栏，形如
> `51 轮 · 672 步 ｜ LLM 306m34s · 工具调用 395m8s ｜ 首 token 平均 20.9s · 170 tok/s ｜ 缓存命中 85% ｜ 输入 111M tok · …`

## 1. 目标

在聊天输入框（composer 玻璃卡片）下方增加一条**全会话累计统计**的单行状态栏，让用户对当前会话的规模与开销一目了然：

- 会话规模：轮数（turn）、步数（step，即 provider 请求次数）
- 时间开销：LLM 累计时长、工具调用累计时长
- 响应性能：首 token 平均延迟（TTFT）、解码吞吐（tok/s）
- token 开销：缓存命中率、累计输入/输出 token

非目标（本期不做）：

- 子代理（Agent 工具派生的 subagent run）的耗时/token 并入主会话统计
- 跨会话/全局的用量看板（Settings 级别的统计页是另一个 feature）
- 费用（金额）估算——依赖各 provider 价格表，另行立项

## 2. 现状盘点：数据基础已经齐了

结论先行：**本功能不需要新增任何埋点或线格式字段**。轨迹（trajectory）体系已经记录了状态栏需要的全部原始事实。

### 2.1 轨迹事件（单一真源）

`crates/agent-ui/src/lib/trajectory/types.ts` 中的线格式 `TrajectoryEvent` 已包含：

| 事件 | 关键字段 | 可推导的指标 |
| --- | --- | --- |
| `user` / `turn_end` | `t`（turn 号）、`at` | 轮数 |
| `step_start` | `s`（step 号）、`at` | 步数、LLM 时长起点 |
| `first_token` | `at` | TTFT |
| `step_end` | `at`、`u`（`TrajectoryUsage`：input/output/cacheRead/cacheWrite/reasoning） | LLM 时长终点、token 累计、缓存命中、tok/s |
| `tool_start` / `tool_end` | `at`、`id` | 工具调用时长、工具调用次数 |
| `compaction_start` / `compaction_end` | `before` / `after` | 压缩次数（可选展示） |

### 2.2 双端数据通道（已存在，直接复用）

| 通道 | 桌面端（agent-gui） | WebUI（agent-gateway/web） |
| --- | --- | --- |
| 实时事件 | recorder 经 `recorderRegistry` 写入本地 live store（`lib/trajectory/liveTrajectory.ts`，100ms 合并通知） | `transcriptStore.ts` 在 seq 门之前无条件调用 `absorbTrajectoryChatEvent`（250ms 合并通知）——**轨迹视图没打开也在收** |
| 落盘读取 | Tauri 命令 `trajectory_get_window`（`trajectory_window.rs`，每页默认 8 段、上限 64 段，返回 `hasMoreBefore`） | `trajectory.fetch` 经 Gateway 中继由桌面端应答（`shims/tauriCore.ts` 同形转发） |
| 幂等收敛 | `eventLog.ts` 的 `buildTrajectoryLedger`：按事件语义身份去重，对乱序、重复、截断稳健 | 同一份共享实现 |

### 2.3 UI 挂载点（已存在插槽模式）

`crates/agent-ui/src/pages/chat/ChatComposerBar.tsx` 已经用 ReactNode 插槽接收宿主注入的附属条（`taskProgressBar`、`approvalBar`），状态栏沿用同一模式即可，不破坏 `check-ui-boundaries` 的共享层边界（agent-ui 不 import 宿主代码，数据全部经 props 注入）。

## 3. 指标定义

所有指标都从收敛后的 `TrajectoryLedger`（turns → steps → tools）推导。记号：`Σ` 遍历全部已加载 turn 的全部 step / tool。

| 指标 | 公式 | 说明 |
| --- | --- | --- |
| 轮数 | `ledger.turns.length` | 含运行中的当前轮 |
| 步数 | `Σ turn.steps.length` | 一步 = 一次 provider 请求 |
| LLM 时长 | `Σ (step.endedAt − step.startedAt)`；运行中的 step 用 `now − startedAt` | 含 TTFT 等待段 |
| 工具调用时长 | `Σ (tool.endedAt − tool.startedAt)`；运行中同上 | 并行工具调用按各自 wall time 相加，**总和可能超过物理时长**（DSH 同样如此），文案不需要回避 |
| 首 token 平均 | `mean(step.firstTokenAt − step.startedAt)`，仅统计有 `firstTokenAt` 的 step | 重试后的 `step_start` 已是最后一次尝试的起点，无需特判 |
| tok/s | `Σ usage.output ÷ Σ (step.endedAt − step.firstTokenAt)` | 分母缺 `firstTokenAt` 的 step 回退 `endedAt − startedAt`；分母 ≤ 0 时该 step 不计入 |
| 缓存命中 | `Σ cacheRead ÷ Σ (input + cacheRead + cacheWrite)` | 口径 = 「prompt token 中有多少来自缓存读」。cacheWrite 计入分母：写缓存那次请求这部分确实没命中 |
| 输入 tok | `Σ (input + cacheRead + cacheWrite)` | 与账单口径一致的 prompt 总量 |
| 输出 tok | `Σ (output)` | `reasoning` 已含在各 provider 的 output 里则不重复加；以 `TrajectoryUsage` 现有语义为准 |

补充规则：

- `usage` 缺失的 step（provider 未返回）只计入步数与时长，不污染 token 类指标。
- 全部指标只统计**主会话**事件；`tool_end.run`（子代理 runId）不展开。
- 数值格式化：
  - token 用 `Intl.NumberFormat(locale, { notation: "compact" })` → `111M`、`2.3K`；
  - 时长统一 `formatStatDuration(ms)`：`< 60s → "42s"`、`< 60min → "12m34s"`、`≥ 60min → "5h06m"`（不学 DSH 的 `306m34s`，分钟数超过三位可读性差）；
  - TTFT 保留一位小数（`20.9s`），tok/s 取整。

## 4. 总体架构

三层结构，全部落在共享层 agent-ui，宿主只做接线：

```
┌────────────────────────────────────────────────────────────┐
│ 宿主接线层                                                    │
│  desktop: ConversationPaneHost → statsBar={<…/>}             │
│  web:     GatewayAppView       → statsBar={<…/>}             │
│  注入：TrajectoryHost.loadWindow + live events 订阅源          │
├────────────────────────────────────────────────────────────┤
│ 组件层  agent-ui/components/chat/ConversationStatsBar.tsx     │
│  展示 + 响应式收缩 + 运行中 1s 心跳 + 点击跳转轨迹视图（可选）      │
├────────────────────────────────────────────────────────────┤
│ 聚合层  agent-ui/lib/trajectory/stats.ts                      │
│  aggregateTrajectoryStats(ledger, now) → ConversationStats   │
│  useConversationStats(host, conversationId, liveEvents…)     │
│  模块级缓存：conversationId → {persisted events, 聚合快照}      │
└────────────────────────────────────────────────────────────┘
```

### 4.1 聚合层 `lib/trajectory/stats.ts`

```ts
export type ConversationStats = {
  turns: number;
  steps: number;
  llmMs: number;            // 已完成部分
  llmRunningSinceAt: number | null;   // 运行中 step 的起点，展示层用 now 补齐
  toolMs: number;
  toolRunningSinceAt: number | null;
  ttftAvgMs: number | null; // 无样本为 null
  ttftSamples: number;
  decodeTokPerSec: number | null;
  cacheHitRatio: number | null;
  inputTokens: number;      // input + cacheRead + cacheWrite
  outputTokens: number;
  compactions: number;
  /** 事件被截断或未加载完时为 true，展示层加 "≈" 前缀 */
  approximate: boolean;
};

export function aggregateTrajectoryStats(ledger: TrajectoryLedger): ConversationStats;
```

纯函数、无 IO，直接吃 `buildTrajectoryLedger` 的产物——**去重、乱序、重复回放的全部脏活都复用现有账本层**，聚合层不重新发明收敛逻辑。

配套 hook（同文件或 `useConversationStats.ts`）：

```ts
export function useConversationStats(options: {
  conversationId: string;
  host: Pick<TrajectoryHost, "loadWindow">;
  liveEvents: readonly TrajectoryEvent[];      // useSyncExternalStore 产物，宿主传入
  authoritativeRevision?: number;               // edit-resend/rebase 后整体重载
  enabled: boolean;                             // 条为空/隐藏时不加载
}): { stats: ConversationStats | null; loading: boolean };
```

行为：

1. **首次加载**：`loadWindow(conversationId)` 拿最近窗口；若 `hasMoreBefore`，用 `requestIdleCallback`（回退 `setTimeout`）在后台向前分页直到读完（每页沿用后端上限，最多 64 段/次）。分页期间 `approximate = true`，读完后翻 false。
2. **实时合并**：`persisted ∪ liveEvents` → `buildTrajectoryLedger(events, { liveIdentities })` → `aggregateTrajectoryStats`。重建节流到 **1s**（与运行中时长的心跳同步），空闲（非 isSending 且无新事件）时不重建。
3. **模块级缓存**：`Map<conversationId, { events, oldestSegmentIndex, statsSnapshot }>`，LRU 上限 8 个会话。多 pane 打开同一会话共享一份；切走再切回不重新分页。
4. **权威重载**：`authoritativeRevision` 变化（edit-resend、断线 rebase、手动压缩截断历史）时丢弃缓存整体重载——语义与 `TrajectoryView.reconcileAuthoritativeWindow` 一致。
5. **内存挡板**：累计事件数超过 50k（约对应数 MB JSON）时停止向前分页，保持 `approximate = true`。这是给极端长会话的保险丝，正常会话（数百 step）远够不着。

### 4.2 组件层 `components/chat/ConversationStatsBar.tsx`

- 单行、水平居中、`text-[calc(11px*var(--zone-font-scale,1))]`、`text-muted-foreground/70`，分组间用 `｜`（`text-muted-foreground/40`），组内用 `·`——与 `UsagePanel` 现有视觉语言一致。
- 渲染在 composer 玻璃卡片**下方**、与卡片同宽的容器内（见 4.3），高度约 20px，不参与卡片的展开/收起动画。
- **响应式收缩**：composer 卡片已是 `@container`，按容器宽度分档隐藏低优先级分组：
  1. 恒显：`轮 · 步` `+ 上下文占用 %`（移动端够不到下一档，理由见 4.5 末尾的修订说明）
  2. ≥ 28rem：`+ LLM 时长 · 工具时长`
  3. ≥ 40rem：`+ 输入/输出 tok`
  4. ≥ 52rem：`+ 首 token · tok/s · 缓存命中`
- **运行中心跳**：`isSending` 时每 1s 触发一次重渲染，把 `llmRunningSinceAt`/`toolRunningSinceAt` 折算进显示值；空闲时零定时器。
- **空态**：`stats === null`（无任何轨迹事件）时渲染等高占位容器（`h-5`，无内容、`aria-hidden`），不返回 `null`——若不占位，首条 assistant 回复落地统计浮现的瞬间会让 composer/transcript 整体位移一次；常驻占位换零跳动为代价，稳态下视觉不可见。老会话、text 模式同样走这条占位分支。
- **交互**：hover 出 `LabelTooltip` 显示未被收缩掉的完整指标 + 压缩次数；占用达到手动压缩门槛（`canManualCompact`，≥50%）且宿主提供了压缩回调时整条可点击 → 弹出确认后触发手动压缩，门槛表达式与 `ContextUsageRing` 同源（`canManualCompact(ratio) && !manualCompactBlocked && Boolean(onManualCompactConfirm)`），复用同一套 `ConfirmActionPopover` 交互；不满足条件时纯展示，无点击行为。

  **修订**：上述「整条可点击 → 切换到轨迹视图」的原始设计已推翻，改为点击触发手动压缩确认。原因：轨迹视图已有独立入口（`ConversationViewTabs`，桌面端与 WebUI 均已接线），状态栏复用点击手势去做导航是重复入口；而手动压缩此前只能从 `ContextUsageRing` 的环形入口触发，环在窄屏/低占用（`hideBelowWarn`）时会隐身，压缩入口跟着一起消失——状态栏本就常驻可见（见 4.5 恒显上下文占用分组的确认），复用为压缩入口正好补上这个缺口。点击只 `open()` 出 `ConfirmActionPopover`，压缩回调只挂在弹层内部的 `onConfirm`，不会被整行点击绕过确认步骤。
- 无障碍：容器 `role="status"` + `aria-label` 拼完整文本；数字变化不用 `aria-live`（流式期间会刷屏）。

### 4.3 ChatComposerBar 的改动（最小侵入）

```tsx
// props 新增一个插槽，与 taskProgressBar / approvalBar 同模式
statsBar?: ReactNode;
```

渲染位置：玻璃卡片 `</div>`（现 L1240）之后、外层宽度容器之内，保证与卡片左右对齐：

```tsx
  {fileDropOverlay}
</div>
{statsBar /* ← 新增：卡片下方，占位由组件自身决定 */}
```

注意：`onHeightChange`（transcript 底部预留高度）测量的是整个 composer 覆盖层，statsBar 出现/消失会改变高度——现有 ResizeObserver 逻辑已覆盖，无需额外处理，只需回归验证。

### 4.4 宿主接线

**桌面端** `crates/agent-gui/src/pages/chat/surfaces/ConversationPaneHost.tsx`：

```tsx
statsBar={
  <ConversationStatsBarHost   // agent-gui 侧薄包装
    conversationId={snapshot.conversationId}
    isSending={isSending}
  />
}
```

薄包装内部：`useSyncExternalStore(subscribeDesktopLiveTrajectory, () => desktopLiveTrajectoryEvents(id))` + `createInvokeTrajectoryHost(invoke)`（`ConversationTrajectorySurface.tsx` 已有同款取数代码，可直接抽用）。

**WebUI** `crates/agent-gateway/web/src/app/GatewayAppView.tsx`：同构——`subscribeLiveTrajectory` + `liveTrajectoryEvents` + `trajectory.fetch` 适配器（`agent-ui-adapters/trajectory.ts` 现成）。`liveOwnership` 语义沿用轨迹视图：桌面 `authoritative`、Web `observed`。

### 4.5 布局影响：卡片与胶囊压缩一号，为状态栏预留高度预算（已落地）

产品决策（已确认）：输入卡片和任务胶囊整体做小一号，把省下的高度让给状态栏，保证状态栏上线后底部总占位与改版前基本持平。以下尺寸调整**已实施**：

| 元素 | 调整 | 收益 |
| --- | --- | --- |
| 编辑器最小高度 | `min-h-[70px]` → `min-h-[60px]`（3 行文本高；经 ChatComposerBar 的 className 覆盖，twMerge 后写胜出，不影响 MentionComposer 其他使用方） | −10px |
| 编辑器区上内距 | `pt-3.5` → `pt-2.5` | −4px |
| 工具栏行内距 | `pb-2 pt-1` → `pb-1.5 pt-0.5` | −4px |
| 任务胶囊 | `h-10` → `h-9`、`px-3.5` → `px-3`、字号 13px → `text-xs` | −4px |
| 胶囊与卡片间距 | `mb-4` → `mb-3` | −4px |

高度预算：卡片折叠态约 128px → 110px（−18px），胶囊栈 −8px；状态栏上线约 +20px，净增 ≈ +2px，视觉上与改版前持平。

同时已落地的还有 **`statsBar` 插槽**：ChatComposerBar 新增 `statsBar?: ReactNode`，渲染在玻璃卡片正下方、与卡片同宽的容器内，且内置 `approvalBar` 互斥——审批面板可见时状态栏自动让位（审批操作优先级高于统计读数）。宿主未接线时不占位，transcript 底部预留走既有 ResizeObserver 自动适应。

- **上下文用量环（ContextUsageRing）改为低占用隐藏**（已确认的产品决策，随状态栏一起实施）：占用 `< CONTEXT_USAGE_WARN_RATIO`（50%，即不可手动压缩时）环不渲染；≥ 50% 时浮现，恰好与手动压缩入口的可用窗口重合。语义分工：环管「当前上下文占用」（瞬时、压缩后回落），状态栏管「全会话累计」（单调增长）。实现为 `ContextUsageRing` 新增 `hideBelowWarn?: boolean`（默认 false，本处传 true），环在 `ratio < CONTEXT_USAGE_WARN_RATIO` 时返回 null；环是 absolute 定位，隐藏不影响右侧控制列布局。

  **修订（移动端反馈）**：上述「状态栏不含上下文占用分组」的决定已推翻。原因：composer 容器宽度在移动端到不了状态栏的第一个断点（28rem），窄屏只剩「轮 · 步」；用量环又在占用 < 50% 时隐身（`hideBelowWarn`）——两者叠加导致低占用会话在窄屏下完全看不到任何上下文信息。修复：状态栏新增恒显的「上下文占用」分组（与 `轮 · 步` 同级，不挂 `@min-` 断点），读数与用量环同源（`contextUsageTokensSource` + `contextWindow` → `contextUsageRatio()`），但**不复用 `hideBelowWarn` 门槛**——只要有合法 `contextWindow`（`> 0` 且有限）就显示，`contextUsageTokens` 缺省时按 0% 展示，而非整组隐藏。环与状态栏因此不再互斥：环继续做「≥ 50% 才浮现的压缩入口」，状态栏做「随时可见的占用读数」，二者共享同一数据源但各自的显隐门槛独立。

### 4.6 修订（2026-08-26）：状态栏与用量环改为严格互斥，由设置切换（已落地）

产品决策（已确认，**严格二态**）：§4.5 修订确立的「环与状态栏并存」不再保留——两者改为互斥的两种展示样式，用户在供应商设置页的高级设置抽屉里切换，默认沿用状态栏。没有第三态（并存/自动），也就没有并存形态下环与状态栏双份压缩入口的重复问题。

- **设置字段**：`settings.customSettings.composerContextDisplay: "statsBar" | "ring"`（`ComposerContextDisplayMode`）。`normalizeCustomSettings` 兜底 `"statsBar"`——旧配置无此字段、脏值（含曾设想过的 `"auto"`）一律落回默认。作为全局产品偏好随 gateway 设置同步：**不进** `syncableCustomSettings` 的本地重置清单（与字体/宽度这类设备本地偏好不同），桌面端与 WebUI 同步生效。
- **互斥强制点在组件内**：`ChatComposerBar` 新增 `contextDisplayMode?: ComposerContextDisplayMode`（缺省按 `"statsBar"`），两个宿主只透传设置值，环/状态栏的取舍由组件统一裁决，宿主无法配置出并存形态：
  - `"statsBar"`：渲染 `statsBar` 插槽，环整枚不渲染。压缩入口由状态栏整条点击承担（§4.2 修订）。
  - `"ring"`：渲染用量环且**常显**（composer 不再传 `hideBelowWarn`）——环此时是唯一占用读数，低占用隐身会重现 §4.5 修订修掉的「看不到任何占用信息」缺口；`statsBar` 插槽即使宿主传入也不挂载。<50% 时环不可点击（`canManualCompact` 门槛不变），≥50% 起承担压缩入口。
- **`ContextUsageRing.hideBelowWarn` 保留**为共享环的通用显示选项（真实 DOM 验收测试继续覆盖），只是 composer 这个挂载点不再使用。
- **开关 UI**：`ProvidersSection` 高级设置抽屉（`CustomSettingsDrawer`）新增 Switch——开 = 用量环、关 = 状态栏；i18n key `settings.composerContextDisplay` / `settings.composerContextDisplayDesc`（zhCNSettings/enUSSettings）。
- **接线**：桌面端 `ChatPage.tsx` 两处 composer 绑定与 WebUI `GatewayAppView.tsx` 各加一行 `contextDisplayMode`；`ConversationPaneHost` 与两端 `ConversationStatsBarHost` 零改动（statsBar 插槽照常构造，挂不挂载由组件裁决，未挂载时数据 hook 不 mount、无拉取开销）。
- **测试**：`normalization.test.mjs` 覆盖二态归一化与 gateway 同步透传；`context-usage.test.mjs` 的 composer 源码断言改为互斥语义（环按模式渲染、statsBar 插槽在 ring 模式不挂载、composer 不再出现 `hideBelowWarn`）。

### 4.7 修订（2026-08-27）：二态开关改为三档状态滑块，新增「都显示」档（已落地）

产品决策：§4.6 的严格二态放宽为三档。设置抽屉里的 Switch 换成三档状态滑块，从左到右：**状态栏 → 都显示 → 用量环**；新增的中档「都显示」让状态栏与常显用量环并存，左右两档行为与 §4.6 的关/开完全一致，默认仍是状态栏。both 档下环与状态栏各自保留 ≥50% 的手动压缩入口（§4.6 消除的双入口形态随本档回归，属有意为之）。

- **设置字段**：`ComposerContextDisplayMode` 扩展为 `"statsBar" | "both" | "ring"`。两处归一化（`normalizeCustomSettings` 与 agent-gui `storage.ts` 的本地副本）接受三个合法值，缺省/脏值（含曾设想过的 `"auto"`）仍落回 `"statsBar"`；gateway 同步透传零改动（`Partial` + `??` 对新值天然成立），老对端 payload 缺字段时照旧保留本地值。
- **取舍仍在组件内**：`ChatComposerBar` 环的渲染条件放宽为 `"ring" || "both"`，statsBar 插槽维持 `!== "ring"` 时挂载——`"both"` 自然同时落进两个分支；`"statsBar"` / `"ring"` 两档行为与 §4.6 完全一致，宿主依旧只透传设置值。
- **滑块 UI**：新增通用组件 `SegmentedSlider`（`components/ui/segmented-slider.tsx`）——等宽分段 + 滑动指示块，底层同名原生 radio，方向键换档、Tab 进出分组由浏览器原生承担；`ProvidersSection` 抽屉用它替换 Switch。i18n 标题改为「上下文占用展示」，新增三档标签 key `settings.composerContextDisplayStatsBar` / `...Both` / `...Ring`（zhCN/enUS）。
- **测试**：`normalization.test.mjs` 改覆盖三态归一化、gateway 同步携带 `"both"`；`context-usage.test.mjs` 与 `conversation-stats-bar.test.mjs` 的源码断言改为三档语义。

### 4.8 修订（2026-08-31）：设置抽屉该分区的布局重构与文案精简（已落地）

纯 UI/文案调整，设置字段与组件裁决逻辑零改动。原「裸标签 + 滑块 + 罗列三档的四行长段落」改为与抽屉其他分区一致的形态：`DrawerSectionHeader`（Activity 图标 + 标题 + 提示气泡）+ 通栏 `SegmentedSlider` + 滑块下方一行只描述**当前选中档**的动态说明。「≥50% 保留手动压缩入口」这类通用信息收进分区头的提示气泡。i18n：删除长段落 key `settings.composerContextDisplayDesc`，新增 `...Hint`（气泡）与 `...StatsBarDesc` / `...BothDesc` / `...RingDesc`（单行档位描述，zhCN/enUS）。

## 5. 方案取舍：为什么不先做后端聚合

| | A. 纯前端（本方案） | B. 后端聚合命令 |
| --- | --- | --- |
| 新增后端面 | 无 | Tauri 命令 + Gateway 中继方法 + WebUI shim 三处 |
| 去重/收敛 | 复用 `buildTrajectoryLedger`，一套逻辑 | 落盘聚合与实时尾巴之间需要新的去重边界（段不按 turn 对齐，很难切干净） |
| 大会话成本 | 首开时后台分页 + 常驻事件内存（数 MB 级，有 50k 挡板） | 后端一次 SQL 扫描，前端零内存 |
| 一致性风险 | 与轨迹视图读数天然一致（同一账本） | 两套聚合口径可能漂移 |

**结论：A 起步。** B 作为二期优化预留——如果实测发现巨型会话首开分页耗时/内存不可接受，再加 `trajectory_stats_get`（只聚合**已关闭段**，开放段仍走前端事件收敛，天然避开去重边界问题）。聚合层的 `ConversationStats` 结构对两种来源保持中立，切换来源不动组件层。

## 6. i18n

`crates/agent-ui/src/i18n/translations/{zhCNCommon,enUSCommon}.ts` 新增：

| key | zh-CN | en-US |
| --- | --- | --- |
| `chat.stats.turns` | `{n} 轮` | `{n} turns` |
| `chat.stats.steps` | `{n} 步` | `{n} steps` |
| `chat.stats.contextUsage` | `上下文 {p}%` | `Context {p}%` |
| `chat.stats.llmTime` | `LLM {t}` | `LLM {t}` |
| `chat.stats.toolTime` | `工具调用 {t}` | `Tools {t}` |
| `chat.stats.ttftAvg` | `首 token 平均 {t}` | `Avg TTFT {t}` |
| `chat.stats.throughput` | `{n} tok/s` | `{n} tok/s` |
| `chat.stats.cacheHit` | `缓存命中 {p}%` | `Cache hit {p}%` |
| `chat.stats.inputTokens` | `输入 {n} tok` | `In {n} tok` |
| `chat.stats.outputTokens` | `输出 {n} tok` | `Out {n} tok` |
| `chat.stats.compactions` | `压缩 {n} 次`（仅 tooltip） | `{n} compactions` |
| `chat.stats.approximate` | `≈`（前缀，含 tooltip 释义） | `≈` |
| `chat.manualCompactTitle` | `手动压缩上下文？` | `Compact context manually?`（同时用作触发按钮 `aria-label`） |
| `chat.manualCompactDescription` | `将历史消息折叠为摘要检查点，释放上下文空间。` | `Folds earlier messages into a summary checkpoint to free context space.` |
| `chat.manualCompactConfirm` | `压缩` | `Compact` |

## 7. 边界与降级

| 场景 | 行为 |
| --- | --- |
| 老会话/text 模式，无轨迹事件 | 渲染等高占位容器（不隐藏、不返回 `null`），避免统计浮现时布局跳动 |
| `trajectory_truncated` 段或分页未完成/触发 50k 挡板 | 显示但带 `≈` 前缀 |
| 手动/自动压缩 | 统计是**事件累计**，不受上下文截断影响（与用量环的"当前上下文占用"口径互补，不冲突）；压缩次数进 tooltip |
| edit-resend 砍掉旧轮次 | `authoritativeRevision` 触发整体重载，读数收敛到新历史 |
| 断线重连重放事件 | 账本身份去重，读数不跳变 |
| provider 未返回 usage | token 类指标只算有 usage 的 step；全都没有时对应分组隐藏 |
| 轨迹视图打开中 | composer 挂起（`hidden`），状态栏随之隐藏；数据缓存共享，无重复拉取 |
| 多 pane 同会话 | 模块级缓存共享事件与聚合，只多一份订阅 |
| `approvalBar` 可见 | 状态栏暂时隐藏，审批操作优先 |
| 上下文占用 < 50% | statsBar 模式（默认）：无环，状态栏占用分组恒显（见 4.5 修订）；ring/both 模式：环常显但不可点击，≥ 50% 起承担手动压缩入口（见 4.6/4.7） |
| 无 `contextWindow`（老会话/text 模式） | 状态栏「上下文占用」分组整个不存在（不显示假的 0%），其余分组不受影响 |

## 8. 文件改动清单

| 文件 | 动作 |
| --- | --- |
| `crates/agent-ui/src/lib/trajectory/stats.ts` | 新增：类型 + `aggregateTrajectoryStats` + 格式化函数 |
| `crates/agent-ui/src/lib/trajectory/useConversationStats.ts` | 新增：加载/分页/缓存/节流 hook |
| `crates/agent-ui/src/components/chat/ConversationStatsBar.tsx` | 新增：展示组件 |
| `crates/agent-ui/src/pages/chat/ChatComposerBar.tsx` | ✅ 已落地：`statsBar` 插槽（含 approvalBar 互斥）+ 卡片压缩（4.5）+ `contextDisplayMode` 展示裁决（4.6 严格互斥 → 4.7 三档，取代原「给环传 `hideBelowWarn`」方案） |
| `crates/agent-ui/src/components/chat/TaskProgressIndicator.tsx` | ✅ 已落地：胶囊压缩（4.5，两端测试同步更新） |
| `crates/agent-ui/src/components/chat/ContextUsageRing.tsx` | ✅ 已落地：`hideBelowWarn` prop（现为共享环通用显示选项，composer 挂载点不再传，见 4.6） |
| `crates/agent-ui/src/lib/settings/types.ts` / `index.ts` | ✅ 已落地（4.6/4.7）：`ComposerContextDisplayMode` + `composerContextDisplay` 字段与三态归一化 |
| `crates/agent-ui/src/pages/settings/ProvidersSection.tsx` + `zhCNSettings.ts` / `enUSSettings.ts` | ✅ 已落地（4.6/4.7）：高级设置抽屉的展示样式三档滑块（`SegmentedSlider`）+ 文案 |
| `crates/agent-gui/src/pages/ChatPage.tsx` | ✅ 已落地（4.6）：两处 composer 绑定透传 `contextDisplayMode` |
| `crates/agent-ui/src/i18n/translations/zhCNCommon.ts` / `enUSCommon.ts` | 修改：新增 key |
| `crates/agent-gui/src/pages/chat/surfaces/ConversationPaneHost.tsx`（+ 薄包装组件） | 修改：桌面接线 |
| `crates/agent-gateway/web/src/app/GatewayAppView.tsx`（+ 薄包装组件） | 修改：Web 接线 |
| `crates/agent-gui/test/trajectory/stats.test.mjs` | 新增：聚合单测 |
| `crates/agent-gui/test/chat/conversation-stats-bar.test.mjs` | 新增：组件行为测试 |

后端（Rust）零改动。

## 9. 测试计划

聚合层（纯函数，重点覆盖）：

- 完整回合事件流 → 各指标数值正确（手工算好的黄金样例）
- 乱序 + 重复回放 → 与顺序输入结果一致（幂等）
- 运行中 step/tool → `*RunningSinceAt` 正确、已完成部分不含运行段
- usage 缺失 step、`firstTokenAt` 缺失、分母为 0 → 不 NaN、对应指标为 null
- 缓存命中/输入 token 口径：cacheWrite 计入分母与输入
- 截断/挡板 → `approximate` 置位

hook 层：

- 首窗 + 后台分页拼接、`hasMoreBefore` 边界
- live 事件与 persisted 重叠 → 去重后读数不双算
- `authoritativeRevision` 变化 → 缓存失效重载
- 1s 节流：连续 live 通知只触发一次重建

组件层：

- 空态渲染等高占位容器（不返回 null）；容器分档收缩（现有 workbench-dom-boundaries 测试风格）
- `≈` 前缀、`role="status"` aria-label 完整性
- 时长/token 格式化边界（59s、60s、999K、1M…）
- `approvalBar` 可见时状态栏隐藏
- 环 `hideBelowWarn`：49% 隐藏、50% 显示、压缩后回落再隐藏（`context-usage.test.mjs` 对共享环的 DOM 验收；prop 保留，composer 不再传，见 4.6）
- 三档展示（4.6→4.7）：ChatComposerBar 按 `contextDisplayMode` 渲染环/状态栏（statsBar/both/ring，`context-usage.test.mjs` 源码断言）；`composerContextDisplay` 三态归一化 + gateway 同步携带 `"both"`（`normalization.test.mjs`）
- 上下文占用分组：合法 `contextWindow` 时恒显且不挂断点；`contextWindow` 缺省/非法（0、负数、NaN、Infinity）时分组整个不存在；`contextUsageTokens` 缺省但 `contextWindow` 合法时按 0% 展示（`conversation-stats-bar.test.mjs`）

回归：composer 高度上报（`onHeightChange`）在状态栏出现/消失时正确更新；`pnpm check`（biome + ui-boundaries）通过。

## 10. 实施步骤

1. **聚合层 + 单测**（stats.ts，纯函数，半天）——先把口径钉死
2. **hook 层**（加载/缓存/节流，1 天）
3. **组件 + i18n + ChatComposerBar 插槽 + 环低占用隐藏**（1 天）
4. **双端接线 + 回归**（桌面先行，Web 复用，1 天）
5. **可选增强**：点击跳转轨迹视图、tooltip 明细（半天）
6. **二期观察项**：巨型会话首开性能数据 → 决定是否上后端聚合（方案 B）

总量约 3–4 人日，风险集中在 hook 层的缓存/去重正确性——但全部复用轨迹视图已验证的收敛原语，属于组合而非新造。
