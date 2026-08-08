# Skills Hub 批量选择交互规格 v2

适用范围：`crates/agent-ui/src/pages/skills-hub/SkillsHubPage.tsx`。GUI/WebUI
通过同一公共页面渲染，平台能力由各自 `src/agent-ui-adapters/` 提供。

## 0. 核心原则

1. **选择（selection）与启用（enabled）是两个独立状态。**
   - 启用状态 = `settings.skills.selected`，用卡片的绿色底/边框表达，任何模式下都保持可见（保留现状）。
   - 批量选择状态 = 新增的临时 `bulkSelection: Set<string>`（组件内 state，不落盘），
     用左上角复选框 + primary 色 ring 表达，与绿色启用样式可叠加、互不干扰。
2. 批量模式下点卡片 **只改 bulkSelection，绝不直接改启用状态或触发预览**。
3. 删除不可撤销，必须走确认；启用/禁用可撤销，走 Undo snackbar（复用现有 bulkUndo 机制）。

## 1. 进入 / 退出批量模式

- 保留顶部「批量选择」toggle 按钮作为显式入口。
- 增加隐式入口（Google Photos 模式）：非批量模式下，卡片 hover 时左上角淡入一个圆形复选框；
  点击复选框 = 自动进入批量模式并选中该卡片。触屏设备（no hover）复选框常驻半透明显示。
- 退出：
  - `Esc` 第一次：清空 bulkSelection（若非空）；第二次：退出批量模式。
  - 切换视图（installed/store/import）或 bulkSelection 清空后点「完成」按钮退出。
  - 退出时清空 bulkSelection 和 shift anchor。

## 2. 卡片交互（批量模式下）

- 整卡点击 = 切换选中；`Shift+点击` = 区间选择（保留现有 anchor 逻辑，作用于 bulkSelection）。
- `Ctrl/Cmd+A`（焦点不在输入框时）= 全选当前筛选结果。仅已安装页有此语义；
  其余视图不拦截浏览器默认的 Ctrl+A。
- 选中样式：`ring-2 ring-primary` + 左上角复选框实心勾选；启用状态的绿色样式照常保留。
- 批量模式下不打开预览抽屉；卡片右下角原单个删除按钮隐藏（避免与批量删除双通道混淆）。
- 常驻启用类技能（alwaysEnabled）在批量模式下显示禁用态复选框（不可选中），并在 tooltip 说明原因。

## 3. 底部浮动操作栏（替代现有顶部三按钮组）

- bulkSelection.size > 0 时，从底部滑入浮动 bar（复用现有 bulkUndo snackbar 的容器样式）：
  `已选 N │ 全选(当前筛选) · 清空 │ 启用 · 禁用 · 删除 │ ✕ 完成`
- 各按钮语义（全部作用于 bulkSelection，而非启用集合）：
  - **启用 / 禁用**：批量改 `settings.skills.selected`，完成后清空选择、弹 Undo snackbar
    （"已更新 N 个技能 · 撤销"，复用现有 bulkUndo）。按钮旁显示将实际变化的数量，
    如选中 5 个里 3 个已启用，则「启用 (2)」「禁用 (3)」；数量为 0 时对应按钮禁用。
  - **删除**：ConfirmActionPopover 确认，描述里列出前 5 个技能名，超出部分用
    i18n key `skillsHubBulkDeleteMore`（"{names} 及另外 {count} 个"）表达；
    确认后串行删除（保留现有失败聚合提示），成功项从选择集中移除。
  - 顶部「批量选择」按钮在模式中变为高亮态，仅作退出用（或直接隐藏，统一由浮动栏的「完成」退出）。
- bulkSelection 为空但仍在批量模式时，浮动栏显示提示文案："点击卡片进行选择"（弱化样式）。

## 4. 筛选/搜索与选择集的关系

- 修改筛选词或分类时 **不清空** bulkSelection（用户可能分几次搜索凑一批）。
- 浮动栏的「已选 N」为总数；若存在选中但当前不可见的项，追加提示 "(其中 M 个不在当前筛选中)"。
- 「全选」只作用于当前筛选结果（追加进选择集）；「清空」清全部。

## 5. 本地导入（import）视图

- 复用同一套：复选框 + 底部浮动栏，主操作换成「导入 (N)」。
- 列表头部常驻「已选 X / Y」计数 + 「全部选中/取消全选」按钮（不依赖批量模式），
  分子分母都只统计当前工具下可导入（未安装）的技能。
- 已安装的外部技能：**不要**再显示为"锁定勾选"，改为复选框禁用 + 卡片角标「已安装」，
  避免"会被重复导入"的误读。selectedExternal 中不再包含已安装项，也不计入任何计数。
- 导入进行中：浮动栏内联显示进度（done/total），完成后清空选择并复用现有 importToast。

## 6. 需要同步清理的现状代码

- `applyBulkInstalledSelection` / `handleBulkInstalledCardClick` 改为操作 bulkSelection，
  不再直接写 `settings.skills.selected`。
- `deleteBulkSelectedInstalledSkills` 的目标集合从 `selected`（启用集合）改为 bulkSelection。
- 顶部工具栏的「全选/批量删除/退出」三按钮组移除，逻辑迁入底部浮动栏。
- i18n：两端 `i18n/config.ts` 同步新增/调整 key（启用/禁用/清空/已选提示等），中英都要补。

## 7. 风险点自查（改完请逐条验证）

1. 批量删除的确认文案与实际删除集合一致（不再是"已启用集合"）。
2. Undo 只覆盖启用/禁用，不给删除提供伪撤销暗示。
3. 触屏（webui 移动端）无 hover：复选框常驻可点，浮动栏不遮挡最后一行卡片（列表底部留 padding）。
4. lockedByChatMode 时批量入口整体隐藏（保留现状）。
5. 公共 SkillsHubPage 的行为与样式在两端一致，宿主适配器和各自 i18n 文案均已检查。

## 8. WebView2 渲染规约

Skills Hub 在 Windows WebView2 中必须遵守以下合成约束：

1. **禁止对悬浮或覆盖在可滚动、可动画内容之上的元素使用 backdrop-filter。**
   这包括 fixed、sticky、absolute 浮层，以及位于 FLIP 网格上方的操作栏、提示条、
   搜索和排序控件、抽屉遮罩与抽屉面板。Tailwind 的 backdrop-blur-* 同样属于禁用范围。
2. **上述元素统一使用高不透明度实色背景模拟毛玻璃层次。**
   亮色模式优先使用 bg-background/95，暗色模式使用 dark:bg-popover/95，并保留原有
   border 与 shadow；遮罩层使用不带模糊的实色半透明背景。
3. **backdrop-filter 仅允许用于背后内容完全静态的场景。**
   例如页面顶部 HubHeader 或仅覆盖静态 HubBackdrop 的面板。若调用方可能覆盖列表、
   滚动区域或动画内容，应默认不用 backdrop-filter。
4. **两端必须验证。**公共样式只修改 `agent-ui`，并同时检查 GUI 与 WebUI
   的宿主样式和渲染结果，避免任一端通过局部覆盖重新引入独立合成层。

案例依据：

- **技能卡 hover 光斑：**已安装页和商店页曾在每张卡片上使用 backdrop-blur-xl，
  同时卡片 hover 会触发 translate 提层。60+ 卡片叠加 HubBackdrop 光晕后，部分
  WebView2/GPU 组合会留下竖向绿色过期采样残带。修复方式是移除动态卡片根节点的
  backdrop-filter，保留背景、边框、阴影、hover 位移与入场动画。
- **FLIP 与底部浮动栏光斑：**排序功能让技能卡在底部多选操作栏或 Undo 条背后高频
  重排，WebView2 的 backdrop-filter 采样缓存可能失效并在浮动栏上方形成残带。
  修复方式是让操作栏、Undo、搜索、排序和覆盖动态页面的抽屉使用高不透明度实色背景，
  不再采样其后的动画内容。
