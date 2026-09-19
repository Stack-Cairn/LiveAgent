# UI 组件漂移审查

审查日期：2026-09-11。基线提交：a2b5f4a2，审查开始时工作区干净。
本次是源码审查与建议，不修改产品组件，不代表全仓重复项已穷尽。
范围包括共享设置页及组件、桌面快捷键组件、两端会话加载层。

## 结论

最值得处理的是已有基础组件没有覆盖到的消费者。建议按 SettingsNotice、Badge、
设置页 EmptyState 的顺序渐进收敛。设置项行和所有加载状态不应先做通用化。
识别标准是用途、交互契约和维护责任，而不是相似的类名或代码长度。

## 1. 设置操作错误：先补齐 SettingsNotice

现有入口：`crates/agent-ui/src/components/settings/SettingsNotice.tsx`。
当前 validation、warning、installation-warning、inline-error 四种变体已经被
CronTaskModal、HookModal、ProvidersSection、CuaDriverSection 等使用。

| 消费者 | 发现 | 迁移判断 |
| --- | --- | --- |
| CronSection.tsx:191 | actionError；横向图标与截断文字，圆角 xl，边框 destructive/30，底色 /5，px-4 py-3 | 与 Hooks 共享提示样式，可第一批等效收敛 |
| HooksSection.tsx:269 | 同样的 actionError、图标尺寸、外框与 truncate，额外 shrink-0 | 接入同一变体，保留 shrink-0 |
| SkillsSettingsForm.tsx:184 | loadError；lg 圆角、px-3 py-2.5、图标 16px，文字不截断 | 同属错误提示，但保留换行策略；第二批确定紧凑规格 |
| SttSection.tsx:694 | error；items-start、长文 break-words、lg 圆角 | 保留多行错误；不能照搬 Cron 的 truncate |
| SttSection.tsx:670 | 连接测试结果，含成功/失败、标题和次要详情 | 复合结果，不塞入仅支持单行错误的组件 |

最小 API 建议：为现有组件新增 `variant="action-error"`，首批只迁移 Cron/Hooks，
图标和文字继续用 children 传入，保留现有条件、截断、DOM 标签与语义。

```tsx
<SettingsNotice variant="action-error">
  <AlertTriangle className="size-3.5 shrink-0" />
  <span className="min-w-0 flex-1 truncate">{actionError}</span>
</SettingsNotice>
```

不立即重构旧 variants 为 severity × density × layout 的所有组合，也不默认追加
role=alert/live-region。若后续同一种提示的内部结构确实重复，再提取内容结构。
验证：现有 settings-surfaces 测试补充新规格；触发两页操作失败，检查单行长文与
窄屏，不改变错误出现/清除条件。该批可以做到等效，风险最低。

## 2. 状态徽标：扩展 Badge，不再造第二套 StatusBadge

现有入口：`crates/agent-ui/src/components/ui/badge.tsx`。
已有 success/destructive/muted 等配色，默认 text-xs、rounded-md、带边框；
唯一额外尺寸 filter-count 专用于筛选计数，不适合冒充通用紧凑状态。

| 消费者 | 发现 | 必须保留的差异 |
| --- | --- | --- |
| CronSection.tsx:261 | 调度错误小胶囊，10px、圆角 full、px-1.5、图标 | title 错误详情、显示条件 |
| SystemToolsSection.tsx:113 | 浏览器扩展连接/缺失的小胶囊 | connected/missing 映射；缺失不自动等同错误 |
| CuaDriverSection.tsx:210 | 运行状态胶囊，12px、带脉冲圆点 | 运行与停止、脉冲动画 |
| CuaDriverSection.tsx:246 | 权限 loading/granted/pending/unknown | loading 的旋转图标、未知与待处理不能合并 |
| AgentsSection.tsx:548 | 启用/停用及 violet 状态，自建 badge/text/dot 三套 class 映射 | violet 用途保留；先迁移明确的启用/停用 |

建议 API：在 Badge 新增 `size="compact"`，用于紧凑状态的稳定尺寸与形状，
调用方保留状态判断、文案和图标，明确成功/错误先使用现有语义变体。
例如 `<Badge size="compact" variant="destructive" title={error}>…</Badge>`。
warning 是否加入应由 connected/missing、权限 pending 等真实消费者一起定义，
不先增加没有消费者的颜色角色。不要把 HTTP 类型、read-only 能力标签当作成功状态。

这是视觉规范收敛，不是纯粹等值替换：旧胶囊常无边框，现有 Badge 带边框；圆角、
内边距、颜色和行高有差异。先给紧凑规格做亮暗对照，再逐组迁移，保留现有默认
Badge 与 filter-count。动画圆点留在业务组件，除非又出现多处相同实现。
验证：状态矩阵、窄屏换行/宽度、图标对齐和 title；测试语义状态映射，而非仅快照 class。

## 3. 设置页空状态：利用已有 EmptyState，统一有限的布局规格

现有入口：`crates/agent-ui/src/components/ui/empty-state.tsx`。
已有 workspace/settings 两种布局，settings 已被 AgentsSection 两处和
SshSection 的主列表使用。它刻意只提供布局，不接管业务内容、操作和错误判断。

| 消费者 | 当前差异 | 顺序 |
| --- | --- | --- |
| CronSection.tsx:205 | 相同设置卡片表面，py-12；裸图标、两行文字，靠 margin 分隔 | 与 SSH 导入空态先审查共同内容布局 |
| SshSection.tsx:820 | 相同表面和 py-12；flex gap-3、裸图标及文字组 | 最接近现有 settings 变体 |
| SkillsSettingsForm.tsx:210 | 图标有圆形底、lg 圆角、没有 muted 底色 | 保留图标插槽，先决定表面是否统一 |
| HooksSection.tsx:507 | xl 圆角、bg-muted/5、更大说明、添加按钮 | 保留 action 和文字宽度，后续迁移 |
| ProvidersSection.tsx:918 | 品牌图标、添加按钮、Web 专用 min-height/padding/button 宽度 | 单独验证移动端，放最后 |

建议先接入既有 `<EmptyState variant="settings">`，保持 icon/content/action
由 children 组合。若必须保留两种留白，只定义有消费者的有限 size/density，
不要为每个页面新增一种 variant。标题/说明/操作区若迁移后仍重复，再考虑具名子组件。
现有默认 py-14/gap-4 与手写 py-12/gap-3 不等价，不能只改标签就宣称外观一致。

必须保留空列表、搜索无结果、功能未启用和加载失败的判断区别。例如 Skills 当前
要求 !loading && skills.length === 0 && !loadError；Providers 根据 filtered 而非
原始列表判断。不要因共享外观把它们统一成一个 items.length === 0 逻辑。
验证：空列表、过滤无结果、loading/error 不闪空态、添加操作，及 520/820px 边界。

## 暂不优先统一

### 设置项行

`pages/settings/shared.tsx:21` 已有 SettingsRow，支持标题、说明和 control，
在 SystemSettingsForm、SidebarShortcutsSection 使用，具有分组分隔线和 sm 响应式。
其他近似结构需要区分：

- RemoteSection.tsx:87 的 ToggleOptionCard 是独立图标卡片，已经局部复用。
- SttSection.tsx:403 是有边框的语音启用卡片，直接传递 checked 的新值。
- CuaDriverSection.tsx:246 的 PermissionRow 展示权限检测结果，不是开关设置。
- SystemSettingsForm.tsx:103 的 ProxySettingsRow 有展开详情按钮和独立 switchControl。

当前没有证据支持把它们改成同一个高参数量控件。可以在发现第二组相同卡片契约后，
给 SettingsRow 增加明确的 card 表面或提取窄用途 SettingsToggleRow；不统一 callback
为 onToggle，避免丢掉 Switch 的 onCheckedChange(value) 契约。保留标题可点击性、
aria-label、disabled、响应式布局与展开按钮焦点行为。

### 加载状态与特殊空画布

- SkillsLoading 已复用 HubLoading 的 LoadingSurface/FrostSpinner/LoadingTrack。
- 桌面 TranscriptLoadingStates 使用 PaneLoadingSkeleton：不透明、遮挡交互，并与
  TranscriptWidthControls 暂停联动；支持 conversation/terminal 的不同骨架。
- Web HistorySwitchLoadingOverlay 是半透明背景加加载胶囊，层级和视觉不同。
- WorkbenchEmptyState 服务可拖放空画布；ChatEmptyState 包含建议操作；它们不是
  设置列表里的空状态，不能因为都有图标/文字就一起合并。

未来跨端统一加载层需先确定遮挡、层级、骨架/转圈和 aria-busy 的产品契约，
不是简单提取同名组件。目前优先补齐现有组件的消费者，收益更明确。

## 后续规范建议

1. 新增页面先查现有组件；只在组件有明确维护责任、能用少量属性表达差异时封装。
2. 颜色跟随组件变体管理；状态判断、请求和系统行为继续由消费者负责。
3. 对新增的具体漂移模式做有针对性的检查，不全面禁止 span/div 或长 className。
4. 分批提交可审查的消费者迁移；每批说明哪些严格等效、哪些是接受的视觉规范调整。

本次仅阅读源码和现有测试并形成记录，没有运行构建或视觉测试，也没有修改产品代码。

## 第一批实施结果

Cron/Hooks 已接入 SettingsNotice 的 action-error 变体，保留 Hooks 特有的
shrink-0，图标、truncate、显示条件及错误状态逻辑未改。现有 DOM 契约测试
新增默认和 shrink-0 两种消费者规格，检查原生 div、实际 class 集合、属性、ref
和事件透传。双端生产构建、UI 边界、改动源码 Biome、设置表面 DOM 测试通过。
本批未进行完整自动化失败流程的浏览器验收，未暂存或提交。

## 第二批实施：紧凑状态徽标

Badge 新增 compact 尺寸：text-tiny、leading-none、rounded-full、border-0、px-1.5，
保留基础 py-0.5 和图标间距。尺寸明确采用无边框规格，现有默认和 filter-count 不变。
Cron 调度错误与 Agents 全局启用标记已接入；错误详情 title、显示条件和图标保留。
Agents 绿色改用 success，浅色更深、深色更浅；没有迁移 HTTP 等分类标签、
权限待处理或运行脉冲，也没有新增 warning 角色。

显式在字号之后设置 leading-none，避免类名合并移除原行高。使用实际 Badge
及与消费者一致的 flex 父布局做亮暗浏览器对照，紧凑样例均为 14px 高，
迁移前后宽高一致；普通 Badge 与筛选计数尺寸保持不变。局部样例不替代全页面验收。
扩展现有展示原语 DOM 测试，覆盖图标、tooltip、ref、语义属性及普通规格回归。

本批双端生产构建（含 TypeScript）、3 项展示原语 DOM 测试、UI 边界、
三份改动源码 Biome 通过。未执行暂存或提交命令。

## 第三批实施：Cron / SSH 导入空状态

EmptyState 新增 size="compact"，仅在 variant="settings" 时应用 gap-3/py-12；
既有 settings 默认 gap-4/py-14、workspace 默认布局保持不变。Cron 无任务、
SSH 导入无候选接入相同表面规格，图标和内容保持在页面中。Cron 通过 block
保留原段落 margin 排版，SSH 保留 flex gap，避免重复间距。
条件仍分别为 tasks.length === 0 和 candidates.length === 0，没有改动
导入结果、过滤、loading、错误或任务操作逻辑。

验证：使用从本批工作区基线和迁移后源码提取的实际空状态片段，浏览器对比
2 种空状态 × 亮暗 × 360/820px 共 8 个场景；替代图标夹具中节点几何、
排版、颜色、背景、圆角和 padding 一致。此测试未触发完整业务请求。
展示原语 4 项 DOM 测试（含 compact/default/workspace 隔离）、双端生产构建
（含 TypeScript）、UI 边界和改动源码 Biome 通过。未执行暂存或提交。

## 第四批实施：紧凑与多行错误提示（2026-09-11）

SettingsNotice 新增两个各有两个消费者的规格：compact-error 供 SkillsSettingsForm 与
SttSection 使用；multiline-error 供 MemoryPanel 与 OrganizerHistoryModal 使用。
Skills 的子节点字号/颜色保持原处；Stt 继续 items-start、text-xs、break-words。
记忆两处保留 whitespace-pre-wrap 与各自 mt-3/mb-4，不统一相近但不同的边框透明度。
未修改错误状态、显示条件、请求、重试、ARIA 语义或内容结构。

基于本批工作区快照，将新外壳归一为旧外壳后，四份页面的 esbuild 编译结果逐字相同，
确认除样式外壳与对应 import 外无逻辑/内容变化。现有 SettingsNotice DOM 契约测试扩展
检查紧凑、顶部对齐、多行规格的实际类集合，保持原生 div、props、ref、事件透传。
组件测试、共享 UI 类型检查及两端生产构建通过；本轮没有运行全页面浏览器流程。
UI 边界检查遇到同期 NotifyToast.tsx 直接导入 Base UI 的既有工作区错误，本批未修改
该 Toast 迁移。未执行暂存、提交或推送。
