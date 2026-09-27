# 日历、轻量 Todo 与邮件扩展设计

状态：核心日程/Todo 已实现；实际交付和验证范围见 [实现记录](planning-calendar-implementation.md)。日期：2026-09-07。

基线：LiveAgent `b86061bb`（已包含资源管理入口和侧栏快捷入口）；分支 `feat/planning-calendar`。参考 [Proma 源码分析](proma-planning-reproduction.md)。本设计中的能力、接口和目录均为目标，不代表已经交付。

> 已被后续决策取代的部分：§2.1 的 280px 右栏与显示密度、§4.3 的三档时间密度、§5.2 交给 Agent / Cron 标记（日历已与定时任务隔离）、§7 的 `ReminderInbox`（到期提醒面板已移除，提醒改为系统通知）。以 [实现记录](planning-calendar-implementation.md) 与 [设计对齐](planning-design-alignment.md) 为准。

## 1. 产品定位与范围

面向使用 LiveAgent 安排个人工作、并把部分工作交给 Agent 的用户。页面的首要任务是：**把待办放到日历里的具体时间，并直接调整安排。**

采用 Proma 日历的克制布局、月/周切换、分类颜色、悬浮详情及多来源展示方式；Todo 保持简单。核心场景：写下“整理项目周报”→ 拖到周五 15:00 → 拉伸为 90 分钟 → 到点提醒 → 自己处理或交给 Agent → 标记完成。

| 范围 | 内容 |
|---|---|
| 首版核心 | 轻量 Todo、日历管理、月/周/日视图、Todo 拖入排期、日程移动与上下拉伸、时间轴缩放、提醒、项目/会话关联、桌面和 Web 一致体验 |
| 后续增强 | Cron 预计触发、系统日历/提醒事项同步、Workbench 拼接 |
| 邮件扩展 | 首版预留来源关系与适配边界；后续接收邮件、转 Todo/日程、打开原邮件、Agent 辅助草拟回复 |

首版不增加 Todo 看板、复杂工作流、依赖图或多级子任务。支持可选分组、共享标签、优先级与项目绑定；任务标题必填，截止时间和提醒按需填写。邮件收发和账户授权在单独阶段实现。

## 2. 信息架构与视觉

### 2.1 页面布局

在既有侧栏中增加“计划”快捷入口，遵守现有快捷入口配置与桌面/Web 导航。进入默认打开周视图，保留上次日期、视图、时间密度和筛选。

```text
既有全局侧栏       日历主体                         Todo（最右侧）
                  日期导航 / 月·周·日              快速添加
                  日历开关 / 收起的显示设置         分组 / 收起的筛选
                  全天栏                           ☐ 待办标题  ⠿
                  时间轴与时间块  ◄─────────────── 拖入排期
```

全局侧栏保持应用现有行为。Todo 右栏约 280 px，日历占据剩余宽度；窄屏从右侧打开待办抽屉。无营销标题、统计卡片或长期操作说明。项目、标签、优先级和提醒在事项详情中编辑，筛选及显示密度/时区按需展开。

### 2.2 视觉约定

基础背景、文字、边框和字体沿用 LiveAgent 主题 token：`--background`、`--foreground`、`--border`、`--app-font-family`。日期标题 18 px/600，控件和事件标题 13 px，辅助说明与时刻 11–12 px；时间使用 tabular-nums，继承应用字体与用户字体设置。

日历分类建议色：工作蓝 `#2563EB`、个人青 `#0F766E`、学习紫 `#7C3AED`、事务橙 `#B45309`；当前时间线红 `#DC2626`，禁用/辅助灰 `#64748B`。这些是分类色，不替换主题文字色。事件浅色填充、左边 3 px 分类线、6 px 圆角；深色主题降低填充亮度并提升文字对比度。

每小时主网格线、半小时弱线；15 分钟刻度主要在拖拽时显现。今天的日期轻量高亮，当前时刻线只出现在今天列。已完成事项降低视觉权重并带勾选符；来源、只读、重叠和失败都使用文字/图标，不能仅靠颜色表达。

标志性交互是拖拽时的“时间预览块”：同步显示起止时刻与总时长。周围控件保持安静，让日历编排本身成为重点。动画限于 100–160 ms 的浮层和回退，遵从 reduced-motion；不对正在拖动的块做位置缓动。

### 2.3 日历管理

提供“工作”“个人”两个初始本地日历，可重命名、选颜色、调整顺序、设置默认日历、显示/隐藏。新事件进入默认可写日历；Todo 排期优先使用 Todo 的最近排期日历，否则使用默认日历。隐藏日历只影响显示，不删除事项或关闭提醒；创建到隐藏日历时本次视图自动显示该日历。

日历管理中的来源类型预留 local/system/mail，来源支持项显示只读或同步状态。首版只创建 local 日历，未来不支持的来源入口不伪装为可用按钮。

删除日历先展示事项数量，默认提供“移动事项到其他日历再删除”。事务内迁移事件、删除日历，保留提醒和 Todo 关联；“连同事项删除”是单独明确操作。至少保留一个本地可写日历，默认日历删除时须选替代项。

## 3. Todo 与排期语义

Todo 默认只有勾选框、标题、排期摘要和拖拽柄；编辑时可展开说明、项目、可选截止时间与估算时长。新 Todo 不自动设置今天截止，不自动产生提醒。筛选为未安排、全部未完成、已完成；“今天”和“近期”可作为快捷筛选。

一个 Todo 可以对应多个 CalendarEvent 时间块，例如“撰写方案”安排周一 10:00–11:00 和周二 14:00–15:30。数据库维护 1:N 关联；右栏显示“已安排 2 段 · 2 小时 30 分”。排期时长是计划投入，不是实际耗时。未安排定义为未完成且没有结束晚于当前时刻的有效排期；仅有历史时间块的未完成 Todo 会重新出现，避免任务失踪。

| 操作 | 结果 |
|---|---|
| Todo 拖入日历 | 新增关联时间块，Todo 保留；不改截止时间、不自动执行 Agent |
| 同一 Todo 再次拖入 | 新增另一时间段，不移动已有段；单次手势重试仍只生成一条 |
| 移动已有时间块 | 只修改该段起止时间，保持时长 |
| 删除/取消一个排期 | 将该 Event 移入回收站并停止提醒，Todo 保留，可恢复 |
| 完成 Todo | Todo completed；关联块仍保留并展示完成样式，未触发的关联任务提醒停止 |
| 恢复 Todo | 恢复 open；仅恢复未来有效的自动提醒，不补发已过去的提醒 |
| 删除 Todo | 任务及其排期一并隐藏，可在回收站恢复；仅永久删除时一并移除关联排期 |
| 修改 Todo 标题 | 任务与关联时间块共用标题和详情；任一入口修改都会原子同步，旧 titleOverride 不覆盖任务标题 |

Todo 截止时间在日历作为轻量标记展示，与安排的工作时间块区分；截止标记不提供时长拉伸，可通过日期菜单改截止时间。“今天”筛选包括今日排期、今日截止和逾期的未完成项。

## 4. 日历交互规格

### 4.1 拖入 Todo / 创建事件

| 参数 | 默认行为 |
|---|---|
| 默认时长 | Todo 有估算时长时使用，否则 60 分钟；最少 15 分钟 |
| 吸附 | 15 分钟；详情表单允许按分钟输入，后续移动保持原分钟余量与原时长 |
| 拖拽开始 | 鼠标/笔移动超过 5 px；触摸从专用拖拽柄长按约 250 ms，普通滑动用于滚动 |
| 落点 | 日/周视图以日期列、时间网格和滚动偏移计算；显示起止时刻/总时长预览 |
| 保存 | pointerup 且落点有效时只提交一次；服务端成功前使用 pending 样式 |
| 取消 | Escape、pointercancel、视图切换、目标 Agent 切换、离开有效落点均不写入 |

拖入全天区创建关联全天事件，日期范围为一天；拖入月视图的日期格也创建全天事件，不猜测具体小时，详情中可切换为有时间安排。日/周空白网格单击打开 60 分钟草稿，按下拖出范围则按选择范围创建普通日程；松开显示输入浮层，标题提交后才持久化。

拖入过程中保留右栏 Todo 占位。未安排筛选下，保存成功后该 Todo 离开列表，可通过“查看已安排”找到；保存失败恢复拖入前布局。只读日历无有效落点，显示“此日历只读”。

### 4.2 移动、上下拉伸与跨日

块体是移动区，上下边缘是两个独立 resize handle：拉上边仅改 start，拉下边仅改 end。拖动时持续展示“10:15–11:45 · 1 小时 30 分”，不需要打开详情才能看见时间。

移动遵循 15 分钟增量并保留原分钟余量，resize 同样以原边缘为基准吸附；最短 15 分钟，不允许边缘反转。小于最小可交互高度的事件不通过假增高改变真实时间，使用增大的透明手柄命中区与详情表单辅助选择。

左右移动可以跨日期列；拖到网格上下约 32 px 热区时自动滚动，速度随接近边缘增加并设上限。拖拽期间冻结日期范围、密度和查询坐标系，滚动会重新计算命中点。首版跨周改期通过日期表单，避免悬停自动翻页导致误投。

跨午夜事件按日期切成多个视觉段，底层仍是一条 Event；仅真实起点段/终点段展示 resize handle，中间段不允许错误裁切。全天事件提供日期跨度编辑，月视图跨度拉伸列入增强项。

时间重叠允许保存，预览提示“与 2 项安排重叠”。重叠块分列展示，按 start/end/id 稳定排序，同一冲突簇共享列宽；相邻 `[start,end)` 区间不算重叠。不会自动挪动其他任务或强制拼接日程。

### 4.3 时间轴缩放与导航

垂直滚动浏览 00:00–24:00，首次进入将 08:00 附近置于视口上方；日期头和全天栏固定。提供“紧凑 / 标准 / 舒展”三档，分别为 40/64/96 px 每小时，标准为默认值。时间吸附仍为 15 分钟，不随显示密度改变。

缩放保持视口中心时刻，点击“现在”定位当前时间；普通滚轮仅滚动，不劫持系统缩放。页面记住每个视图的滚动位置。拖拽时禁止切换密度，避免位移换算突变。

月视图侧重安排概览和月份导航，单格超出容量显示“还有 N 项”；点击打开当天列表。周视图默认周一开始、显示周末，可在显示设置中隐藏周末；日视图在窄屏提供完整移动与拉伸。

### 4.4 键盘、失败和撤销

每项均有“安排时间/修改时间”表单作为鼠标拖拽的等价入口。选中事件后，在明确进入时间调整模式时使用方向键移动 15 分钟或一天，Shift+上下调整结束边缘；Escape 退出，Enter 保存，普通文本输入不拦截快捷键。屏幕阅读器播报新的日期、起止和时长，限制播报频率。

拖拽后提供最近一次操作的“撤销”（10 秒入口）。撤销是携带操作后 revision 的反向 mutation；如他端已改动，拒绝覆盖并提示打开最新记录。冲突时移除本地预览、展示权威位置，并保留尝试的时间供手动重试。

网络响应丢失时使用同一 requestId 查询/重试，不能先假定失败而生成新请求。最终成功后才改变未安排列表与统计；客户端可展示 pending 预览，但不把它计为权威数据。

## 5. 提醒、Agent 与自动化

### 5.1 提醒

新日历默认事件提醒为“开始时”，允许日历级关闭或改为提前 5/10/30 分钟；Todo 自身无截止时间时无提醒。Todo 设置截止时间时可启用独立截止提醒。提醒来源包含 event_start/todo_due/manual，自动提醒保存相对偏移，移动/resize 后与 Event 原子更新。

推迟产生用户覆盖：日程改期不覆盖 snooze；已经确认的提醒不重新激活。未来改期后的日程若没有有效自动提醒，则依照日历规则创建新代次；调到过去不新建立即弹出的自动提醒。过去到期且尚未被确认的旧提醒继续显示在应用内，重启可恢复。

Rust 负责启动扫描、约 30 秒到期检查、事务领取和送达状态。单一桌面服务发送系统通知，所有窗口/Web 展示同一数据库中的提醒记录；确认/推迟同步广播。首次提醒或每次推迟到期各通知一次，送达失败使用有限重试，不能声称系统弹窗恰好送达一次。

进程退出后的保证限于下次启动恢复；未来系统日历接入可由系统承担通知，届时增加来源去重，避免应用和系统同时弹窗。

### 5.2 Agent 与执行步骤

Todo 详情提供“交给 Agent”，执行前指定可用项目与模型。Todo ID 是长期任务身份，Agent 内部 TaskCreate/TaskUpdate/TaskList 继续管理本次 run 的步骤。

启动请求包含 requestId、projectId、providerId、model；后端校验并记录启动状态，协调会话创建、关联和消息投递。界面可打开最近会话，错误可重试；同一请求不重复开会话。Agent 先读最新 Todo，再工作，真正完成后才显式完成 Todo。

日程开始不自动运行 Agent。未来可显式“为此待办创建自动任务”，与提醒分别控制。Cron 标记是只读预计触发，点击进入自动任务详情；不把 cron occurrence 存成普通 CalendarEvent。完整执行会话和 daily/reuse 会话策略作为独立增强任务实现。

### 5.3 自动化和系统接入边界

Planning 新工具注册在既有 builtinRegistry，明确 Todo/Calendar/Reminder 和 TaskList 的不同语义。Plan 模式只允许读操作；无人值守 Cron 使用现有 runtime scope 限定能力，不通过 Planning 绕过既有工具权限。

EventKit 增强阶段才实现账户/集合接入、外部修改、outbox 重试和冲突选择。只读来源在后端强制校验。重复事件在 master、instance 和 exception 模型明确后开放，不以“复制普通事件”冒充系列编辑。

## 6. 数据模型与 API

### 6.1 数据表

复用现有 `config.sqlite` 与 rusqlite，使用 `planning_` 前缀，独立顺序迁移元数据。对多态关系使用事务校验/明确清理逻辑，不假定 SQLite 能为 targetType+targetId 自动提供外键。

| 表 | 关键字段/约束 |
|---|---|
| planning_calendars | UUID、name、color、sortOrder、visibleDefault、isDefault、sourceKind、revision；本地至少一个可写日历 |
| planning_todos | UUID、title、notes、open/completed、projectId?、estimateMinutes?、dueKind?、dueDate?/dueAt?、dueTimeZone?、revision、timestamps |
| planning_events | UUID、calendarId、todoId?、title/titleOverride?、notes、timeKind、startAt/endAt 或 startDate/endDateExclusive、timeZone、revision、timestamps |
| planning_reminders | UUID、目标、origin、offsetMinutes?、triggerAt、snoozedUntil?、status、generation、lease/delivery/retry 信息、revision |
| planning_todo_conversations | todoId、conversationId、runId?、role、first/lastLinkedAt；组合唯一 |
| planning_requests | requestId、操作类型、请求摘要、状态/结果、目标版本；重放同一请求返回同一结果，ID 复用且参数不同报错 |
| planning_changes / meta | 全局 seq、资源与 ID、tombstone、schema version；有限保留，超出窗口强制重拉 |
| planning_source_links | 本地目标、providerKind、accountRef?、externalId、webLink?、来源摘要；首版支持手工/会话来源，预留邮件 |

每个 Event 必须属于一个 Calendar。Todo 可跨不同日历排期；日历管理与 Todo 分组分开。Todo 分组/标签属于增强字段，不影响首版轻量列表。删除关联 Todo 时，事务内物化事件标题、清除 todoId。

时间采用判别联合：timed 的 startAt/endAt 为 UTC 毫秒并保存 IANA timeZone；allDay 的 startDate/endDateExclusive 为 YYYY-MM-DD，结束日期不含当天。禁止 timed/allDay 混填，禁止 end <= start。日期截止与具体时刻截止也分别编码，不用 23:59:59 冒充全天日期。

所有页面使用可见的统一“计划时区”，默认桌面时区；浏览器不静默改为自己的时区。夏令时缺失时刻禁止落点并说明，重复时刻按 UTC offset 区分，坐标换算通过该日有效时刻映射。时区服务与转换规则在实现前确认依赖，不能按一天恒等于 86400000 ms 推算自然日。

### 6.2 命令契约

建议使用 `planning_query`、`planning_mutate`、`planning_start_agent` 三类 Tauri command，Web 对应 Planning 管理请求；共享层定义具名操作联合和判别式响应，不使用无校验任意 JSON。

```ts
// 契约草案，落地时与 Rust serde 类型同步。
type ScheduleTodoInput = {
  requestId: string;
  todoId: string;
  expectedTodoRevision: number;
  calendarId: string;
  time: EventTime; // timed / allDay 判别联合
};
type MoveOrResizeEventInput = {
  requestId: string;
  eventId: string;
  expectedRevision: number;
  time: EventTime;
};
type MutationResult<T> =
  | { status: "ok"; item: T; seq: number; replayed: boolean }
  | { status: "conflict"; current: T; seq: number }
  | { status: "error"; code: string; message: string };
```

同一数据库事务执行版本校验、排期/提醒修改、requestId 记录和变更 seq 更新。事件仅在提交后广播。异步长会话启动以 pending/running/failed/completed 状态协调，不能在事务中等模型执行。

列表按可见时间范围、calendarId、Todo 状态和 projectId 查询；时间相交采用 start < rangeEnd && end > rangeStart。Event 返回的关联 Todo 显示摘要随 Todo 修改失效，避免继承标题更新不反映到缓存。

`planning:changed` 带目标 agentId、全局 seq、upserts/deletedIds；前端先订阅再取快照并按 seq 合并。对未完整加载的范围缓存失效重拉；断线、seq 缺口/超出保留窗口、切换目标 Agent 均重新同步。旧请求/迟到响应不能覆盖新范围或另一 Agent 的数据。

Gateway 经现有认证和桌面路由转发，不新增服务端计划数据库。协议改动同步更新 proto、`make proto` 生成物、Go v2 直通白名单、Rust handler 和 Web socket，不复用设置快照承载无限增长的事件正文。

## 7. 前端与后端实现划分

```text
crates/agent-ui/src/lib/planning/
  types.ts / backend.ts / store.ts / selectors.ts
  time.ts / geometry.ts / overlapLayout.ts / interactionMachine.ts
crates/agent-ui/src/pages/planning/
  PlanningPage.tsx / PlanningSidebar.tsx / CalendarToolbar.tsx
  TodoList.tsx / MonthCalendar.tsx / TimeGrid.tsx / EventBlock.tsx
  CalendarManager.tsx / PlanningInspector.tsx / ReminderInbox.tsx
crates/agent-gui/src/lib/planning/backend.ts
crates/agent-gui/src/lib/planning/startTodoAgent.ts
crates/agent-gui/src/lib/tools/planningTools.ts
crates/agent-gui/src-tauri/src/services/planning/
  mod.rs / types.rs / db.rs / store.rs / reminders.rs
crates/agent-gui/src-tauri/src/commands/planning/mod.rs
crates/agent-gateway/web/src/lib/planning/backend.ts
```

业务、时间布局和交互状态机放在共享 UI，平台适配器负责 I/O。按 Proma 的自定义时间网格方向实现，优先复用现有 React、Pointer Events、Base UI 及主题组件；本轮不新增日历依赖。后续若选时间库，先核对仓库依赖和实际 API。

交互状态机：idle → armed → draggingTodo/movingEvent/resizingStart/resizingEnd → committing → idle；取消从预览态回 idle。持久 store 仅接权威结果，预览在独立临时层；pointermove 通过 animation frame 更新，终止手势时清理 pointer capture、滚动计时器和监听。

共享时间几何纯函数接收视图时区、日期映射、网格 rect、scrollTop、hourHeight、pointer 和原始事件；不读取全局 DOM，方便精准测试。保存期间同一块禁止第二次修改，不阻塞其他块。

前端缓存按 agentId+范围分区；视图偏好（密度、可见日历、日期）与权威事件分开。新增页面纳入 sidebar/view 类型和 GUI/Web 宿主；Workbench 拼接延后，避免拖 Todo 的指针事件被现有 Pane 拖动捕获。

## 8. 邮件扩展方案

目标是“邮件 → 可处理事项 → 日历安排”，第一版保留来源数据和可扩展展示，不实现邮箱账号或空壳收件箱。

后续流程：连接邮箱 → 选择邮件 → 转为 Todo（标题/摘要可编辑）→ 拖入日历 → 处理时打开原邮件或交给 Agent → 可生成回复草稿。会议邀请可转为日程，用户核对日期、时区、参与人；接受邀请/发信为独立操作。

`planning_source_links` 仅存 provider、账户引用、稳定 message/thread ID、可校验链接和最小摘要；邮件正文、附件及 OAuth token 由单独 MailStore/凭据服务维护。适配器预留 listThreads/getMessage/createDraft/openSource 和同步游标，Gmail/Outlook/IMAP 等供应商在邮件阶段再选型。

同一邮件手动转 Todo 的重复点击使用幂等 ID，后台同步不自动反复生成待办。完成 Todo 不隐式归档邮件，删除日程不删除邮件，邮件失效不删除本地任务；来源不可用时保留摘要并提示。

网页中展示邮件正文须隔离 HTML、外部资源与脚本；模型读取邮件时作为来源数据处理。凭据不进入 Todo、事件或 Gateway 快照。只在邮件阶段引入系统授权与发送行为，首版数据模型不代替这些授权。

## 9. 分阶段实施与完成标准

| 阶段 | 工作包 | 验收门槛 |
|---|---|---|
| M0 开发基础 | 本设计、worktree、依赖和共享 UI 基线；实现前准备独立测试数据库与提醒可控时钟 | 设计可直接拆任务、无共享用户库测试 |
| M1 数据与日历骨架 | Rust schema/CRUD/revision/幂等、轻 Todo、日历管理、共享周/日/月视图 | 重启恢复、日历增删改与 Todo 关联一致，时区边界明确 |
| M2 核心编排 | Todo 拖入、移动、双边 resize、自动滚动、重叠布局、密度、取消/撤销 | 完整拖拽链路在桌面与浏览器测试宿主通过；所有交互有键盘/表单等价入口 |
| M3 运行闭环 | 提醒、Todo→Agent、会话关联、Gateway/Web 实际同步、备份恢复 | 可真实保存、重启恢复、到期处理、多端冲突不覆盖 |
| M4 自动化与生态 | Cron 投影/完整会话、EventKit、Workbench；邮件以独立子阶段接入 | 每个外部来源有能力/权限/失败边界后再开放 |

首版交付为 M1–M3；Todo 拖入与上下拉伸属于核心验收，不能推迟到增强阶段。M4 的每一项独立交付，不阻塞首版。

必须执行的验收场景：

1. 新建“整理周报”，拖至周五 15:00 → 16:00；拉底边至 16:30，预览和保存均为 90 分钟。
2. 拉顶边至 14:30，结束仍为 16:30；再整体移动到周四，保持两小时时长。
3. 同 Todo 分两天安排，显示两段；删除其中一段不删 Todo，完成 Todo 后保留排期历史。
4. Escape/离开有效落点/丢失 pointer capture 不落库；提交响应丢失以同 requestId 重试不重复创建。
5. 两窗口同时 resize，后提交的旧版本收到 conflict；保存失败/撤销冲突不覆盖其他窗口的数据。
6. 15 分钟短块、跨午夜、重叠、多天全天、夏令时缺失/重复小时与 23:45 落点正确处理。
7. 切换 40/64/96 px 密度保持中心时刻；边缘自动滚动后落点仍准确；窄屏可通过表单完成同样操作。
8. 删除日历移动事项、只读来源禁止拖入、隐藏日历不删除事项且创建后可看见结果。
9. 改期联动自动提醒、保留推迟，Todo 完成停止关联任务提醒，重启恢复未确认列表。
10. Agent 启动幂等、项目失效可恢复、运行成功不自动冒充 Todo 完成；关联会话能打开。
11. 桌面与 Web 相互修改可见，断线重连/切换 Agent/旧列表响应不会混数据；备份恢复保留日历与全部关联。
12. 浅/深色、键盘焦点、读屏标签、触控与 reduced-motion；千级可见事件仅按范围加载并验证交互流畅性。

## 10. 开发准备与验证记录

开发目录：`/Users/yovinchen/Projects/Rust/LiveAgent/.worktrees/planning-calendar`。此 worktree 从已提交的 `b86061bb` 创建，未搬入原目录的其他未提交改动；已有 Proma 分析作为参考一并带入。

依赖固定为仓库声明的 Node 22.19.0 与 pnpm 10.32.1，使用本地 store 离线冻结安装。首次自动选到其他 pnpm 版本且 lifecycle 找不到 Node，已显式指定项目工具链重新安装成功；没有修改依赖或 lockfile。

现有 Rust `config_dir()` 默认指向用户 `~/.liveagent`，worktree 本身并不隔离应用数据。实现 M1 时先给 PlanningStore 注入数据库连接，测试使用内存或临时路径；启动含迁移/真实通知的开发应用前补可控配置根与通知替身，不使用 HOME 改写绕过。当前未启动应用或迁移用户数据库。

实现时按改动层级验证：纯时间/拖拽函数和 Rust store 的边界测试 → 共享 UI 类型与边界检查 → GUI/Web 类型与交互验收 → Gateway 协议测试 → Rust/构建。文档准备阶段不以未运行的全量应用测试作为通过记录。

具体开发命令、检查结果和下一步入口记录于 [实施准备清单](planning-calendar-implementation.md)。
