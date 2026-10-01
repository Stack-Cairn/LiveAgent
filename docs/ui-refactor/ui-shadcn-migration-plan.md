# 手写交互控件接入 shadcn/ui：调研与实施计划

日期：2026-09-11。调研基线：`e4e7f664` 加当前工作区。
状态：S1/S2/S3/T1/T2/R1/C1 已实施；H1/M1 完成兼容性审查并保留原实现。实际结果见各实施节。

本计划补充 `ui-component-drift-audit.md`，不重复其中的 Notice、Badge、EmptyState、
设置项行和加载层整理。目标是减少页面自行维护的交互原语，保留现有外观、业务状态与操作结果。
调研时工作区另有 Cron/Hooks/SettingsNotice 及其测试、审计文档的改动，实施不得覆盖。

## 1. 结论与范围

先迁移 Switch，再迁移两组手写 Tabs。其后才安排 RadioGroup、Command、Combobox、
ContextMenu；后四类需要各自的行为基线，不能混成一次批量标签替换。

当前共享 UI 已依赖 `@base-ui/react`，声明范围 `^1.6.0`，本地安装版本 `1.6.0`。
`components/ui/switch.tsx`、`tabs.tsx` 已使用 Base UI；Checkbox、ToggleGroup、
Dialog、Popover、DropdownMenu 等也已有入口。继续扩展本地组件，不执行 shadcn init，
不覆盖已有组件文件、不引入 Radix 来实现同一种责任。

shadcn 的 Base UI Switch 和 Tabs 有官方实现；标准化的是组合方式和交互基础，
不是将现有页面替换成官网默认皮肤。在线文档用于核对方向，具体 API 以锁定版本源码为准。
参见 [shadcn Switch](https://ui.shadcn.com/docs/components/base/switch)、
[shadcn Tabs](https://ui.shadcn.com/docs/components/base/tabs)。

以下路径除特别说明均相对于 `crates/agent-ui/src`。行号为调研时定位，后续以符号为准。

## 2. Switch：消费者与差异

全量扫描两端及共享源码的 `role="switch"`，定位到 7 个手写实现文件。
其中 RetryErrorSection 是选择芯片，不能仅凭 role 将其换成轨道开关。

| 实现 | 现有尺寸与外观 | 状态/事件契约 | 处理 |
| --- | --- | --- | --- |
| `components/chat/HistoryShareModal.tsx:113` ShareSwitch | 轨道 w-11 h-6；滑块 size-5，left/top-0.5，开启平移5；sky-500，关闭有 hover | 受控 checked；请求中 disabled；title/aria-label 随状态切换；onToggle 携带脱敏选项 | 第一批 |
| `components/chat/SharedHistoryManagerModal.tsx:77` ShareSwitch | 与上项开启态相同 | checked 固定 true；只有 onDisable；请求成功后由外部列表更新；不能内部乐观切换 | 与第一项一起迁移 |
| `pages/settings/SkillsSettingsForm.tsx:122` | 轨道 w-10 h-6；滑块 size-4，平移1/5；primary，关闭 /30，shadow-xs | Chat 模式锁定；setSettings(prev) 内更新 skills.enabled；disabled opacity-50 | 第二批，独立保留规格 |
| `pages/settings/ProviderPresentation.tsx:229` DialogSwitch | 点击区 size-8；内轨道 w-7 h-4；滑块 size-3，left/top-0.5，开启平移3；滑块 bg-background | ariaLabel；调用 onCheckedChange(!checked) | 第二批，保留包装函数及五个消费位置 |
| `components/resources/ResourceActivationSwitch.tsx:4` | compact：w-9 h-5/size-3.5；普通：w-11 h-6/size-18px；emerald、暗色、ring、专用阴影 | disabled opacity-45；可阻止 pointerdown/mousedown/click/keydown 冒泡；title | 第三批，保留业务包装与事件隔离 |
| GUI `src/pages/settings/GlobalShortcutsSection.tsx:188` ShortcutChoiceSwitch | 左右文字+轨道 w-10 h-6；带边框；滑块 size-4；200ms；reduced-motion | 整块可点击；左右键明确选值并阻止冒泡；不能进入快捷键录制 | 暂保留特殊组合，单独验证后再决定是否接原语 |
| `pages/settings/RetryErrorSection.tsx:100` | 带 HTTP code、标题和 Check 的可选芯片 | 每个 HTTP code 独立布尔值 | 不转轨道 Switch；后续评估 Toggle，变更 role 属语义变化 |

### 2.1 影响范围

- DialogSwitch 在 `ProviderModalView.tsx` 的 524、616、912、1022、1454 行有五处消费者。
  它已经局部复用，不删除包装让五处重新拼样式；只替换内部交互实现。
- ResourceActivationSwitch 被 ResourceSelectionCard、InstalledSkillCard、McpServerCard 消费。
  第一项继续向工作区资源设置等上层传递；必须验证资源卡片点击、批量选择、锁定状态。
- ShortcutChoiceSwitch 在 GlobalShortcutsSection 有两处使用，涉及作用域与布局选择。
- 现有标准 Switch 已用于 CUA、STT、Providers、SkillsHub、共享设置行及桌面 BackupSync。
  新增规格不得改变其默认样式，也不能为迁移旧按钮而全局切换根元素。

### 2.2 不能直接套现有 size

当前 Switch 的 default 是 w-9 h-5 / size-4，开启 translate-x-18px；sm 是
w-7 h-4 / size-3，开启 translate-x-14px。Thumb 默认 translate-x-0.5。
这与分享的绝对定位、Skills 的居中滑块、DialogSwitch 的 32px 点击区域都不相同。

表内尺寸是源码 Tailwind 表达，不是假定所有 rem 永远等于固定 px。
验证必须包含实际根字号和作用域样式。尤其 DialogSwitch 原注释明确区分左右 inset：
不能按轨道相同就复用现有 sm，否则滑块终点会变。

建议 API 方向：

1. 保留现有 Switch 的默认/sm/tone 行为。为两处分享加入一组稳定的大尺寸规格，
   根和 Thumb 的布局、位移一起定义，不让调用方只覆盖轨道尺寸。
2. 对模型弹窗、资源卡片等独特结构，允许在同一 switch.tsx 维护低层 Root/Thumb
   导出，由现有业务包装组合；不要为每个页面向公共 Switch 新增一个页面命名 variant。
3. 仅在确实需要独立轨道容器的组合中保留容器。通用变体不得产生 rootClassName、
   trackClassName、thumbClassName 加多组任意尺寸参数的配置系统。
4. 若抽出低层导出，共用行为、状态属性和事件契约；视觉责任继续在有限规格或包装中。
   本计划不要求将每一种历史外观统一成一个尺寸，也不扩充全局 token 字典。

### 2.3 已核对的 Base UI 风险

本地 `@base-ui/react/switch/root/SwitchRoot.d.ts` 和 `.js` 表明：

- 默认 Root 是 span，旁边会生成隐藏 checkbox；不是旧代码的 button。
- `nativeButton` 与 `render` 可用于原生按钮组合。旧按钮迁移优先验证
  `render={<button type="button" />}` 配合 `nativeButton`，保持 disabled、ref、键盘行为。
- Root click 会驱动隐藏 input，再经 onCheckedChange 通知。不能同时保留旧 onClick
  翻转和新 onCheckedChange 翻转，否则可能一次点击两次更新。
- 隐藏 input 会产生额外事件/兄弟节点；资源卡片的 stopPropagation 必须实测，
  不能仅在可见按钮上写一次就断言事件不泄漏。
- 无需为纯设置操作新增 name/form/required；避免改变表单提交与校验。
- 受控值继续来自业务。失败/请求中状态不得在控件内复制一份。

API 背景：[Base UI Switch](https://base-ui.com/react/components/switch)。
以上具体判断以本地 1.6.0 实现为证据；实施时若依赖升级，重新核对。

## 3. Tabs：两组迁移与宿主边界

### 3.1 ConversationViewTabs

入口：`components/chat/ConversationViewTabs.tsx:8`。
现状是 div tablist 和两个 button tab：conversation/trajectory；只有点击切换，
已选项点击不触发 onChange；没有自己的方向键与 roving tabIndex 管理。
外框 border-border/60、bg-muted/40、p-0.5，按钮 h-6、px-2、text-xs、图标 size-3.5。

直接宿主为桌面 ChatPage 与 Web GatewayAppView 的 AppWorkbenchChrome.leadingActions。
显示受 activeView、是否已有回复、是否多 Pane 控制。内容在别处渲染，因此：

- 保留 active/onChange/className 公共契约和显示条件，不改会话视图持久化与 pane 路由。
- 不为方便 TabsContent 把会话或轨迹内容搬进顶部工具栏。
- 若只在控件内部放 Tabs Root，必须检查 trigger/panel 的 ID 关联；不能生成指向不存在
  panel 的 aria-controls。若确需提升 Root，应分别核对两端宿主，评估额外 DOM 对 flex 的影响。
- 鼠标重复选中不得增加回调。新方向键导航属于明确的可访问性交互增量，应记录，
  不宣称完全无交互差异；不得让方向键焦点移动立即切换会话视图。

### 3.2 DetailsPanel

入口：`components/trajectory/details/DetailsPanel.tsx:80`，手写 tablist 在 217 行。
由 tabsFor(record) 生成动态 tab 集合；currentTab 在旧值不可用时回退首项；recordId
变化时重置 activeTab 和 sectionState。仅 SECTION_TABS 的选择触发 section 加载，
存在请求取消标记和 retry token。当前仅渲染一个 ActiveTab。

- Tabs 保持受控 currentTab，不另存 selected 状态。
- 保留 recordId 变化重置、无记录分支、空 tab 集合、异步结果忽略和重试逻辑。
- 不能为了完整 TabsContent 一次挂载所有面板，导致隐藏面板请求、滚动状态或资源占用变化。
- 将既有 aside/布局作为组合边界，避免新增 wrapper 改变 flex 高度、容器查询或拖拽宽度。
- 保留 520px 页签滚动边界、640px 上下布局边界；检查边界前后及恰好边界。
- 如改内容组件 key 或 panel 包装，验证同种 tab 切换记录时的状态复用是否仍与基线一致。

### 3.3 Tabs 基础组件改造策略

现有 TabsList default 自带 h-8、bg-muted、p-1；filter 也含横向滚动等职责。
TabsTrigger 默认 text-sm、px-3、py-1、选中阴影。两个目标均不等价。
建议添加有限的无装饰 `plain` 规格到 List/Trigger，保留其交互与状态契约，
由 ConversationViewTabs 和 DetailsPanel 定义原样式，不在页面堆叠取消默认样式的类。
当前 default/filter 消费者继续原样。

本地 TabsList.d.ts 确认 activateOnFocus 默认 false、loopFocus 默认 true；
计划显式使用 activateOnFocus=false，方向键仅移动焦点，Enter/Space 激活。
TabsPanel.d.ts 确认 keepMounted 默认 false。不要假定默认会保存隐藏面板。
参见 [Base UI Tabs](https://base-ui.com/react/components/tabs)。

新增标准键盘导航会改变旧组件的 Tab 停靠顺序。实施记录应区分“外观与业务行为保留”
和“补齐标准页签导航”；若当前要求严格保留每一个键盘动作，则本批只整理视觉共用入口，
不强行绕过原语的焦点机制实现一个假的标准 Tabs。

## 4. 后续候选的实施前置条件

| 目标 | 已发现的手写责任 | 后续实施前必须补齐的基线 |
| --- | --- | --- |
| RadioGroup：两个分享弹窗 RedactionPicker | 一个用原生 radio+label，一个用 button role=radio；各自间距、文案来源不同 | 默认有且仅有一项；点击已选项、方向键、disabled、脱敏请求失败后的受控值；保留各自皮肤，不改成可清空 ToggleGroup |
| Command：ConversationSearchDialog | 手动 activeIndex、ArrowUp/Down/Enter、滚动到选项、listbox | 服务端排序/搜索去重、边界不循环、输入法组合输入、草稿来源、异步乱序、失败重试；关闭默认二次过滤；核对拟引入依赖 |
| Combobox：ProviderModalView 的 headerSuggest | Portal+rect 定位、activeIndex、输入焦点保留 | 输入任意 Header 名；多行切换/删除；滚动及 resize 定位；Escape/blur/建议点击；输入法；选择后继续编辑同一行 |
| ContextMenu：文件树、后台日志，之后 Git/预览/编辑器菜单 | role=menu、绝对/固定定位、自建点击遮罩与菜单项 | 坐标空间、容器边界、Portal 层级、Escape/外点、禁用项、右键重开；复制成功保持菜单；日志文本选区、编辑器焦点恢复 |
| 原生 Checkbox：CherryStudioImportModal、SSH 创建 | checkbox 输入和标签 | 原生控件绘制与共享 Checkbox 不同；需明确接受视觉差异才整批迁移 |
| Collapsible/Accordion：MemoryPanel、OrganizerHistoryModal | details/summary，已有原生语义 | 默认展开、展开状态在数据刷新时的保留、内容挂载、是否引入动画；收益较低，暂保留 |

ContextMenu 不用 DropdownMenu 冒充：右键触发与按钮菜单的入口不同。
会话编辑器 mention、原生输入菜单和代码编辑器菜单具有选区/IME/宿主集成，
不能直接作为第一批通用菜单消费者。对这些项目的判断目前是源码候选分析，
尚未验证新组件与其全部业务契约兼容。

## 5. 执行批次与完成定义

| 批次 | 改动边界 | 完成定义 |
| --- | --- | --- |
| S1 | switch.tsx + 两个分享弹窗 | 两套 ShareSwitch 行为共用；大尺寸精确复现；旧 default/sm 回归通过；异步关闭不乐观翻转 |
| S2 | SkillsSettingsForm + DialogSwitch 内部 | 五处 DialogSwitch 无需重新拼样式；点击区与滑块终点一致；设置写入单次，锁定有效 |
| S3 | ResourceActivationSwitch 内部及必要测试 | 三个直接消费者均验证；卡片/批量选择不被开关事件误触发；两档主题与禁用外观一致 |
| T1 | tabs.tsx + ConversationViewTabs + 必要两端宿主关联 | 手写页签交互由原语承接；宿主 DOM 与 pane 行为保留；键盘增量单独记录 |
| T2 | DetailsPanel 页签 | 动态 tab/record 重置正确；请求次数、内容生命周期、拖拽与窄屏布局保持 |

S1–S3 是完整 Switch 阶段，T1–T2 是完整 Tabs 阶段；批次用于控制差异与验收，
不是要求每处理一个小组件都停下来确认。未经明确指令不 commit/push。
ShortcutChoiceSwitch 和 HTTP 选择芯片是有证据的保留项，不计为遗漏。

每阶段完成后更新 ui-design-audit.md 的实际结果；本计划的待执行检查不复制成已通过记录。
若远端 PR 合入，先重扫消费者和工作区差异，不按旧行号机械替换。

## 6. 验证计划

### 6.1 修改前

保存当次工作区源码与实际渲染基线，包括暂存差异；不能用本计划的 HEAD 替代实施时状态。
取共享 Switch default/sm 两档，以及所有目标开关的 on/off/disabled/focus/hover 状态。
同时记录两组 Tabs 的默认、切换、窄屏与动态数据行为。

### 6.2 测试职责

- Switch：真实 Base UI + React DOM 验证 click、Space、Enter、ref、原生 disabled、
  title/aria-label、受控状态、单次回调、不触发表单提交、卡片事件隔离。
- 分享：成功/失败/等待中、快速点击；管理列表只关闭、不反向开启；脱敏选项原样传递。
- 设置：Skills 锁定，DialogSwitch 五个消费者的目标字段不变。
- Tabs：方向键只移焦点，Enter/Space 激活，重复选中不重复业务回调；非活动页签的
  Tab 停靠与焦点环需实测。真实浏览器处理键盘默认动作，不能仅靠合成事件证明。
- Details：记录切换、tab 集合变化、无记录、仅选中需要 section 的页签才请求、重试、
  旧请求晚到、当前内容卸载/复用、滚动与宽度拖拽。

已有可复用测试入口（实际覆盖较窄，不代表已有全部迁移保障）：

- `crates/agent-gui/test/settings/presentation-primitives.test.mjs`：已有筛选 Tabs 选择/禁用与尺寸。
- `crates/agent-gui/test/settings/mcp-hub-tabs.test.mjs`：MCP/Skills 结构与资源开关入口约束。
- `crates/agent-gui/test/settings/shortcut-controls.test.mjs`：快捷键 switch 的箭头和作用域行为。
- `crates/agent-gui/test/skills/skill-card-interactions.test.mjs`：资源卡片交互。
- `crates/agent-gui/test/settings/workspace-resource-settings.test.mjs`：工作区资源设置。
- `crates/agent-gui/test/trajectory/display-presentation.test.mjs`：轨迹显示/尺寸/视图状态。
- `crates/agent-gateway/web/test/trajectory-mobile-layout.test.mjs`、`workbench-chrome.test.mjs`：两端宿主相关结构。
- `crates/agent-gateway/web/test/history-share-origin.test.mjs`：分享来源，不能替代开关 DOM 测试。

新测试优先补业务行为缺口；不新增只断言组件 import 或复制 class 的测试。
现有源码断言迁移后仍保留原本业务约束，不能删弱以通过检查。

### 6.3 视觉及构建

- 亮/暗主题；GUI 与 Gateway 真实宿主标记；默认/非默认字号缩放；hover/focus/disabled。
- 对比根、轨道、Thumb、页签和父容器的 bounding rect、最终颜色、边框、阴影、
  位移起终点、过渡属性/时长；保留 reduced-motion 原条件。
- 隐藏 input 不影响布局和命中；焦点状态截图不能只比较无焦点初始画面。
- Tabs 在 519/520/521 与 639/640/641 容器宽度检查实际容器查询，外加正常宽度。
- 本次不新建 Storybook；使用现有 dev 与隔离对照夹具，再回到真实宿主走通功能。

从仓库根按阶段运行并记录实际结果：

```sh
pnpm --filter @liveagent/ui typecheck
pnpm check:ui-boundaries
pnpm build:gui
pnpm build:webui
pnpm test:gui
pnpm test:webui
```

先运行受影响的定向测试，再在阶段收尾执行上述适用检查及改动源码 Biome。
本调研没有运行构建、测试或浏览器等效验证；所列兼容性与验收均为实施任务。

## 7. 调研证据与验收边界

检索范围覆盖 agent-ui/src、agent-gui/src、agent-gateway/web/src 的 TSX，
检查 role=switch/tablist、现有 Switch/Tabs 调用与被引用包装，再追踪直接宿主、事件和测试。
本地核对 SwitchRoot、TabsList、TabsPanel 的类型声明及 SwitchRoot 事件实现。
对第三方默认行为的判断优先采用安装版本；官方链接提供后续复核入口。

当前没有证据证明所有候选都能完全等效替换。已明确：Switch 需要处理原生节点和隐藏
input；Tabs 的标准键盘导航是行为增量；原生 Checkbox 换皮不能冒充外观不变。
实施时如出现无法等效的行为，保留原实现并记录具体差异，不为“全用标准组件”强行统一。


## 8. S1 实施结果（2026-09-11）

两个分享弹窗已使用共享 Switch size=lg，根通过 render/nativeButton 保留 button。
新增规格统一轨道 h-6/w-11、滑块 size-5、绝对定位和开启位移；默认/sm 原类集合保持。
lg 使用 inline-block，既支持此次原生按钮，也保证默认 span 根能应用宽高。
两处业务包装继续维护文案、title、受控值与回调，管理列表仍只请求关闭。
没有复制业务状态，没有新增表单 name，也没有改脱敏选项与分享请求。

验证实际通过：两端生产构建（含 TypeScript）、UI 边界、3 个改动源码文件 Biome；
share-switch、presentation-primitives、history-share-origin 定向测试共 6 项。
新增测试覆盖原生 button/ref/disabled、单次回调、外部更新前状态保持、不提交父表单，
以及 default/sm/lg 和原 success tone。测试目录被根 Biome 配置排除，未将测试文件报告为 lint 通过。

使用本次修改前源码与实际新组件建立浏览器夹具，加载桌面 CSS；亮暗 × 根字号16/20 ×
checked × disabled 共16组，根与滑块的几何、颜色、圆角、阴影、透明度、光标及过渡比较一致。
额外检查键盘焦点环一致，真实 Enter/Space 各回调一次，受控 false 未自行翻转。
此夹具没有覆盖完整分享服务端流程、Gateway 宿主样式或系统 WebView，未执行全量测试。
本批未执行暂存或提交命令；用户同期其他改动保持原样。


## 9. S2 实施结果（2026-09-11）

共享 switch.tsx 导出无样式 SwitchRoot/SwitchThumb，带样式的 Switch 同样通过这两个
入口组合。SkillsSettingsForm 与 DialogSwitch 接入原语，保留原生 button 和原类名；
未给公共 Switch 添加页面专用规格。DialogSwitch 的五个 ProviderModalView 消费位置不变，
32px 点击区、内轨道与滑块双侧 inset 保留。Skills 从 onCheckedChange 接收目标布尔值，
仍用 setSettings(prev) 更新，保留 selected 和 Chat 模式禁用逻辑。

新增 settings-switch.test.mjs 渲染实际 DialogSwitch 与 SkillsSettingsForm，mock 技能发现
和设置更新依赖；验证单次回调、受控状态等待外部更新、Skills 双向切换/锁定及 selected
保留。与 S1 的 share-switch 测试一起共3项通过。双端生产构建（含 TypeScript）、
UI 边界及3个改动源码文件 Biome 通过，git diff --check 通过。

浏览器对照夹具从本批工作区基线提取旧 JSX、从实际新源码提取对应 JSX，并使用真实
Base UI。分别加载 GUI/Gateway CSS；Web 设置实际 data-liveagent-webui=gateway 标记。
两类控件、亮暗、16/20px 根字号、checked 与 Skills disabled 共48组比较。
颜色、尺寸、边框圆角、阴影、透明度与过渡一致；一次坐标差约0.000004px，等待400ms
复核稳定终点完全一致。Web 夹具真实 Enter/Space 对两类控件均各回调一次。

此批未执行完整设置持久化/模型请求流程、系统 WebView 验收或全量测试。无额外安装、
无暂存/提交命令，用户同期其他改动保留。下一批为 S3 资源开关及卡片事件隔离。


## 10. S3 实施结果（2026-09-11）

ResourceActivationSwitch 接入共享 SwitchRoot/SwitchThumb，原生 button、两档轨道/滑块、
受控状态、title、aria-label、禁用态、主题与阴影类保持。ResourceSelectionCard、
InstalledSkillCard、McpServerCard 三个直接消费者及其业务回调未改。

实际 DOM 测试复现了本地 Base UI 的隐藏 input 点击冒泡：仅在可见 Root 上阻止 click
并不能阻止第二个内部 click 到达父卡片。因此增加 display:contents 的事件边界，使用
inputRef 精确识别并拦截内部 input click；不拦截正常按钮按既有策略传出的事件。
保留可见按钮的 pointerdown/mousedown/click/keydown 隔离，未改成 preventDefault 或
在 onClick 手动翻转，避免绕过原语或重复更新。边界不承担交互，键盘由内部按钮负责。

新增 resource-switch.test.mjs 验证隔离/未隔离模式下四类事件、单次状态回调、受控值、
两档禁用和标签，并渲染实际 ResourceSelectionCard 检查单次更新。Skill/MCP/工作区
现有消费者结构测试及 S1/S2 定向回归共26项通过。完整原生卡片工作流不由这些结构测试证明。

双端生产构建（含 TypeScript）、UI边界、改动源码 Biome、diff检查通过。
Switch 阶段全量回归：GUI 3112项、Gateway 718项均通过。数量为当次工作区结果，包含
用户同期改动，不作为未来固定门槛。本批未修改其他任务的消费者或测试。

浏览器夹具使用本批旧源码及实际新组件；GUI/Gateway各32组（两档尺寸×亮暗×16/20px
根字号×checked×disabled）共64组。Web使用真实宿主标记，比较轨道、Thumb和相邻卡片
文字的几何、颜色、圆角、阴影、透明度、光标与过渡。非几何样式完全一致；小数rem位移
产生小于0.0001px的浮点坐标差，以该阈值比较几何，64组通过。
真实Enter/Space验证隔离模式父级零click，未隔离模式每次父级仅一个click。
未执行真实技能启用/MCP持久化和系统WebView验收；隔离浏览器已关闭。未暂存或提交。

Switch阶段结束；ShortcutChoiceSwitch与HTTP选择芯片仍按计划保留，下一阶段T1/T2。


## 11. T1 保守迁移结果（2026-09-11）

用户明确允许迁移，要求优先保证既有特性。本批仅迁移 ConversationViewTabs；
DetailsPanel、两端宿主、面板内容、会话视图存储、滚动和请求逻辑未改。
TabsList/TabsTrigger 新增 plain 规格以保留调用方原皮肤，原 default/filter 默认不变。
Tabs Root 使用 render 组合 TabsList，最终仍为一层原位置的 div 列表，两按钮直接在列表下，
没有新增布局 wrapper 或 TabsContent。实际 DOM 验证无悬空 aria-controls。

active/onChange/className 契约保持受控。只接受 conversation/trajectory 值，且仅当不同于
当前选中值才调用业务回调；不会把原语的 null/缺失回退值传进会话状态。
显式 activateOnFocus=false、loopFocus=false，方向键只移焦点，Enter/Space 才激活。
补齐了标准页签的单一 Tab 停靠与方向键导航，这是已说明的键盘增量；没有改动页面快捷键。

新增 conversation-view-tabs.test.mjs 覆盖单层结构、原生按钮、className、重复点击、受控
状态等待和外部更新、方向键不切换、内容不迁入控件。连同原语/两端宿主定向测试共16项通过。
双端生产构建（含 TypeScript）、UI边界、源码Biome通过；GUI全量3113项、Gateway全量718项通过。

浏览器夹具从本批旧/新源码提取组件，图标为同尺寸SVG占位，加载两端真实CSS，Web带宿主
标记；亮暗×根字号16/20×两种选中值×两端共16组，列表/按钮/图标占位/文字/相邻内容的
几何、颜色、字体、边框、阴影及过渡完全一致。图标本身的绘制未作为该夹具验收项，源码未改。
真实浏览器验证ArrowRight仅聚焦未切换、Enter/Space各单次回调、首项ArrowLeft不循环、
Tab可离开页签组。未做实际工作区多Pane/滚动恢复/原生WebView端到端操作；相关宿主文件未改。
未暂存/提交，下一批T2需单独验证record重置、动态tab集合、按需加载和面板生命周期。


## 12. T2 保守迁移结果（2026-09-11）

先为旧 DetailsPanel 建立 details-tabs.test.mjs 并运行通过，再迁移并复跑相同测试。
测试渲染真实 DetailsPanel，具体内容Tab与ResizeHandle为测试替身，检查默认回退、同记录
普通重渲染不重挂载、切换内容卸载、recordId重置、动态集合移除、按需请求、section ID
去重、相同refs不重复请求、失败重试、离开页签后旧请求不写回、卸载后结果忽略。
额外锁住点击默认页签后记录明确选择的行为，避免同记录从initial变为updated时跳到diff。

改动仅 DetailsPanel 页签条：Tabs+plain TabsList/Trigger组合成原单层列表，内容仍是原来的
ActiveTab和原滚动div，没有加入TabsContent或keepMounted，没有修改hooks、请求或宽度控件。
当前有效页签集合校验回调值；已选项点击单独保留setActiveTab，非选中项由onValueChange
处理。显式关闭activateOnFocus与loopFocus，不因移动焦点触发section请求。

浏览器发现原语首次定位时，缺少本地offsetParent会把外层偏移算进横向滚动。
页签条增加relative作为测量基准，未设置偏移/z-index、不改变普通布局；复核初始页签不再偏移。
这项修正来自新旧对照发现的兼容性问题，不是新增视觉设计。

两端夹具加载实际DetailsPanel及原宽度控件，内容Tab替换为等高占位，图标为SVG占位。
宽度519/520/521、639/640/641、900 × 亮暗 × tool/system/empty × 两端，共84组
计算样式/几何对照一致。隐藏元素以零矩形比较，不拿无渲染元素相对两个父容器的坐标作差异。
Web有真实宿主标记。夹具首次旧源码JSX运行时配置不一致，修正为automatic后无渲染错误。

真实浏览器检查：ArrowRight仅移焦点、Enter激活；新旧切换raw后保持同一滚动容器和120px
scrollTop；宽度ArrowLeft均从360变384；手柄真实向右拖40px均从384变344，释放后cursor和
userSelect恢复。保留项：未验收真实内容Tab的完整绘制和原生WebView工作区流程。

31项定向测试、GUI全量3114项、Gateway全量718项通过。最后relative布局修正后重新执行
两端生产构建、状态回归测试、84组浏览器对照及源码Biome；全量测试未重复运行。
UI边界与diff检查通过，未提交。后续RadioGroup/Command/Combobox/ContextMenu仍属于
独立计划范围，不能将本次Tabs完成视为这些候选已经验证可直接替换。

## 13. R1 分享脱敏 RadioGroup（2026-09-11）

两个分享弹窗接入共享无样式 RadioGroup/RadioGroupItem，保持原 label 分段与 fieldset/button
两套外观。业务状态仍由原消费者控制；重复选中由原业务守卫忽略，pending 禁用策略不变。
分享管理原按钮支持 Enter，Base UI Radio 默认取消 Enter，因此显式保留原按钮激活；不额外
增加 onClick 业务回调，避免一次激活产生重复请求。

实际消费者 DOM 测试在修改前、后均通过，覆盖回调、重复选择和 pending 禁用。
两端生产构建通过。浏览器使用修改前后 RedactionPicker 源码与实际宿主 CSS，覆盖两套布局、
亮暗、16/20px 根字号、开关值、禁用值，共 64 组可见几何与计算样式完全一致。
另验证原 label 点击、方向键切换、分享管理 Enter 单次回调及两个选项的可访问名称。
这属于控件夹具验证，不代表完整原生 WebView 分享请求流程验收。当前未提交。

剩余范围仍为会话搜索 Command、Header 建议 Combobox、适合迁移的 ContextMenu。

## 14. C1 会话搜索 Command（2026-09-11）

接入 shadcn Command 使用的 cmdk 1.1.1，增加无默认皮肤的共享 Command/Input/List/Item。
保留原 Base UI Dialog、Input、fieldset 和原生结果按钮；Command 使用 display:contents，
不增加可见布局盒。shouldFilter=false 保留后端排序，关闭循环、Vim快捷键和原语 pointer
selection；原 mouseenter、受控索引及异步业务状态仍由页面维护。请求、180ms 防抖、
过期结果失效、错误重试、草稿打开方式和关闭顺序未改动。

Home/End 不进入 Command 的列表导航；带 Meta/Alt 的上下键仍按原逻辑移动一项。
结果及重试按钮阻止键盘事件冒泡，保留原生 Enter/Space，避免 Command 接管焦点按钮。
原语补上输入框与选项的 ARIA 关联。输入法组合期间保留旧处理策略，不顺带引入
新的按键策略；输入框仍为 type=search，原自动补全、纠错与拼写属性保持不设置。cmdk 的依赖包含 Radix，
但此处未使用它的 Dialog；弹窗开关、焦点恢复与 Portal 继续使用原共享 Dialog。

新增真实消费者 DOM 测试在迁移前通过；迁移后 10 项定向测试通过，涵盖列表顺序、边界、
Home、修饰键、本地草稿、搜索打开参数、旧请求忽略、失败重试和关闭后的结果隔离。
两端构建、共享 UI 类型检查、UI 边界检查通过。双端实际 CSS 的 24 组夹具比对覆盖亮暗、
16/20px 根字号及空/普通/长列表，可见几何和计算样式一致；比较前统一焦点，避免两个
autoFocus 输入框只有后者获得焦点造成假差异。浏览器验证重试按钮 Enter 产生一次原生点击。
夹具替换 Dialog 容器、图标和后端，尚不代表真实 WebView 完整会话打开流程验收。

C1 最后补齐输入法组合按键及原输入属性兼容后，重新通过消费者 DOM 回归与共享 UI 类型检查；
前述两端构建和 24 组视觉对照在该兼容补丁之前执行，后续批次收尾时补做最终构建。

## 15. H1 Header 建议：保留现有实现（2026-09-11）

审查入口：`src/pages/settings/ProviderModal.tsx` 的 openHeaderSuggest、applyHeaderSuggestion、
headerSuggestItems，以及 `ProviderModalView.tsx` 的 Header 行和 provider-header-suggest Portal。
这里是允许任意 Header 名的多行编辑器，不能将输入内容当成必须选中 preset 的值。

现有契约：
- 非空查询按 includes 匹配，排除其它行已用名与完全相同名；空查询不显示建议。
- focus、每次输入均将 active 重置为 0；上下键在选项间循环；Enter 应用高亮项，
  没有建议时移到本行 value。选择建议后在下一帧聚焦本行 value。
- blur、Header 列表滚动、身份头替换、导入成功关闭建议；菜单在 body，使用打开时测得的
  input rect 与 4px 间距。没有现成的 resize 重新定位逻辑，本轮不顺带增加。
- 行按索引维护 ref 与状态；删除、导入、身份头替换和校验都是同一个受控编辑器的操作。

针对已安装 Base UI 1.6.0 做浏览器原型：Root controlled open、inputValue="a"、
items/filteredItems=["Alpha","Beta"]、autoHighlight=true，Input onFocus 打开，正常
Portal/Positioner/Popup/List/Item 组合。输入框聚焦并等待 300ms，aria-activedescendant
为空；第一次 ArrowDown 后为 Alpha。旧实现同情形 initial=Alpha、第一次 ArrowDown=Beta。
类型声明 `combobox/root/ComboboxRoot.d.ts` 仅允许 boolean autoHighlight，提供高亮通知但没有
受控 highlightedIndex 或设置高亮的 actions；不能直接使用 Autocomplete 的 "always" 当作
Combobox 支持的值。初步从 loopFocus 文档推断会循环经过输入框并不充分：运行原型后发现
自动高亮生效时可直接 Alpha/Beta 循环，该推断已排除，不作为保留依据。

决策：保留。要满足原行为，需要自行维护高亮并拦截/模拟原语事件，还要协调共享弹层与
多行 refs；仅套上组件而同时保留两套高亮状态不能减少维护负担。不使用内部 store、类型
强转或合成 ArrowDown 来强行初始化。后续若公共 API 可控制首次/每次输入高亮，或另行
允许改变上述导航策略，再做多行输入、删除、导入与焦点转移的实际消费者迁移。
未修改这两个生产文件；这不是“已迁移 Combobox”，也没有宣称完整编辑器 E2E 验收。

## 16. M1 ContextMenu：按焦点契约保留（2026-09-11）

审查了以下消费者，当前没有在严格保留焦点/选区策略前提下可直接替换的入口：

| 消费者 | 保留的具体契约 |
| --- | --- |
| project-tools/file-tree/ContextMenu.tsx + index.tsx | 右键记录相对 panel 的坐标，测量菜单尺寸后在容器内留 8px；打开不主动聚焦菜单；copy 成功保持菜单显示反馈，失败报告错误并关闭；OS/可写权限决定条目 |
| project-tools/BackgroundTasksPanel.tsx | 从实时 window.getSelection 复制，mousedown preventDefault 保留选区；全选在关闭菜单后写入 Range；Escape 先关菜单再关日志 Dialog；保留固定坐标和外层点击遮罩 |
| project-tools/git-review/DiffView.tsx | 有效选区决定菜单是否存在；selectionchange、scroll、resize、blur、diff 状态变化均可关闭；与选区自动滚动共存 |
| project-tools/git-review/StatusView.tsx、HistoryView.tsx | 行/提交对应的数据和动作先关闭菜单再执行，窗口监听关闭现有菜单；没有菜单打开时接管焦点的逻辑，不能未经验证引入 modal 焦点域 |
| workspace-editor/WorkspaceCodeEditorOverlay.tsx | 菜单 mousedown preventDefault 保留编辑器焦点；命令通过原 editor 执行，另有剪贴板、快捷键和选区语义 |
| workspace-editor/WorkspaceFilePreviewOverlay.tsx | 预览内容/文字选区与右键操作共存，使用自己的坐标与关闭机制；不能把绘制预览当作普通菜单按钮 |
| workspace-editor/WorkspaceSftpPanel.tsx | 左右文件列表、多项选择、传输/重命名/删除等动作共享选择上下文；同期存在用户改动；保留现有焦点与操作上下文 |

关键公共原语限制已由代码和浏览器共同确认：ContextMenu.Popup 复用 MenuPopup，后者
FloatingFocusManager 设置 `modal: isContextMenu` 和 `initialFocus: parent.type !== 'menu'`。
MenuPopupProps 仅有 finalFocus，没有关闭初始聚焦的公开选项；ContextMenuRootProps 也排除
modal 配置。设置 finalFocus=false 仅影响关闭后的焦点，不能禁止打开时聚焦。

最小浏览器复现：先聚焦普通 input，将选区设为 [5,12]；在 ContextMenu.Trigger 触发右键，
使用正常 Portal/Positioner/Popup/Item，Popup 设置 finalFocus=false。打开前 activeElement
为编辑 input，打开后为 role=menu 的 Popup。确认的是焦点移动，不据此夸大为所有浏览器
都会丢失 DOM Range；原生 WebView 的编辑器选区风险仍需另行验收。

决策：保留现有菜单，不使用 DropdownMenu 冒充 ContextMenu，不仅替换 role/menuitem 标签，
也不通过原语内部 context 或立即 focus 回输入框来抵消焦点管理。后续需要一个支持非模态、
可配置打开焦点的真正 ContextMenu 组合，或获得调整菜单焦点/Tab 策略的明确范围，再迁移。
这些消费者源码保持原状；原型用于证明兼容边界，并非这些页面的完整业务回归。

### 原型复现要点

H1 使用以下公开 API 组合（省略 Portal/Positioner/Popup/List 内的两个正常 Item）：

```tsx
const [open, setOpen] = useState(false);
<Combobox.Root
  open={open}
  onOpenChange={setOpen}
  inputValue="a"
  items={["Alpha", "Beta"]}
  filteredItems={["Alpha", "Beta"]}
  autoHighlight
>
  <Combobox.Input onFocus={() => setOpen(true)} />
  {/* Portal > Positioner > Popup > List > Item */}
</Combobox.Root>
```

聚焦后比较 Input 的 aria-activedescendant，再按 ArrowDown；实际记录为 null → Alpha。
M1 使用正常 ContextMenu.Root/Trigger/Portal/Positioner/Popup/Item，设置 Popup
finalFocus=false；先聚焦外部 input 并 setSelectionRange(5,12)，再向 Trigger 派发含
clientX/clientY 的 contextmenu。比较 document.activeElement：input → role=menu。
这些原型是兼容性决策证据，保留的生产消费者未替换为原型。

## 17. 本轮 Goal 收尾审计（2026-09-11）

| 目标 | 结论与证据 |
| --- | --- |
| 分享 RadioGroup | R1 已迁移；真实消费者回归、64 组双端样式对照、label/方向键/Enter/可访问名称验证 |
| 会话搜索 Command | C1 已迁移；修改前行为基线、异步/键盘/导航/重试回归、24 组双端样式对照；最终兼容补丁已重新构建与类型检查 |
| Header 建议 Combobox | H1 按目标允许的保留分支结案；已记录实际编辑器契约、公开 API 限制及浏览器高亮差异，不标记为已迁移 |
| 合适的 ContextMenu | M1 审查文件树、日志与 Git/预览/编辑器/SFTP；初始聚焦不可配置与现有契约不符，本轮未找到可等效替换的入口，记录原型证据与后续条件 |
| 原生 Checkbox/details 与特殊编辑器 | 未强行替换，仍保留；没有增加未被消费的 Combobox/ContextMenu 包装层 |
| 现有样式、业务状态、请求与关闭 | 已迁移项保留原皮肤与业务状态；不能可靠等效的候选保持生产源码不变；实际 WebView 全业务 E2E 未宣称完成 |
| 工作区与交付 | 未执行 git add/commit/push/reset；用户同期 staged/unstaged 改动保留。当前计划与 UI 设计审计已同步 |

最后两端生产构建通过（GUI 49.70s，Web 38.75s），共享 UI 类型、源码 Biome、UI 边界及
`git diff --check` 通过。首次 GUI 全量暴露两个搜索测试缺少 ResizeObserver，以及一个
宽度控件测试进程失败：共用 jsdom 环境补入无布局观察器生命周期桩，专用尺寸测试仍使用
自己的可驱动桩；不改变业务断言。失败项与搜索相关 22 项复跑通过，随后 GUI 全量 3118 项
全部通过；Web 全量 718 项通过。源代码最后仅增加解释自定义 radio label 的 lint 注释。

本轮完成的是“能等效的迁移，并对不能可靠等效的候选给出保留证据”，不是“所有手写
交互都已替换”。未来更改高亮/焦点策略或库的公共 API 后，需要重新开启 H1/M1 迁移验收。
