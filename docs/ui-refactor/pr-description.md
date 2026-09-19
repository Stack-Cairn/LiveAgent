# UI 重构 PR 描述草案

> 本文件用于整理 PR 描述和复测范围。提交 PR 前应将正文复制到 PR，并按
> `docs/ui-refactor/README.md` 的要求删除整个临时审计目录。

## Summary

这次重构统一 Desktop GUI、Gateway WebUI 与共享 `agent-ui` 的样式、动效和交互基础设施。
主要目标是把可由 Tailwind 表达的业务样式放回组件，把颜色、动画和特殊视觉值集中管理，
并用共享组件或成熟库替换重复的 Switch、Tabs、复制反馈、拖拽排序和命令式 DOM 实现。

重构保留现有 MentionComposer 编辑器内核。Lexical 换核实验不在本 PR 中，避免把 IME、
Selection、历史记录、剪贴板和 mention 协议的高风险迁移混入样式与基础组件治理。

## 量化规模

统计基线为 `main` 的 `147ad855`，重构结果为 `refactor/ui` 的 `992db34a`。
源码扫描范围为 `crates/agent-ui/src`、`crates/agent-gui/src` 和
`crates/agent-gateway/web/src`。重构分支原始差异（不含本草案）为 431 个文件、
19,287 行新增、17,588 行删除；
其中 10 个临时审计文档占 2,633 行，提交 PR 前会按目录约定移除。

| 方向 | 结果 | 数字口径 |
| --- | --- | --- |
| CSS 业务规则迁移 | 生产 CSS 从 15 个文件、8,131 行降至 7 个文件、2,279 行 | 净减少 8 个文件、5,852 行，约 72%；删除 12 个旧 CSS，新增 4 个集中入口 |
| 源码覆盖 | 修改 250 个 TSX 文件 | 主要分布在 57 个聊天组件、28 个设置页文件、23 个 project-tools 文件、11 个 trajectory 文件、9 个 Skills 文件与 9 个 MCP 文件 |
| 测试覆盖 | 变更 83 个测试及测试辅助文件 | 新增 26 个、修改 57 个，覆盖样式契约、组件 DOM、键盘、复制、Toast、拖拽、布局与缓存行为 |
| 共享 UI 原语 | `components/ui` 变更 33 个文件 | 新增 9 个入口、修改 23 个既有原语、删除 1 套自建排序 hook；设置展示层另新增 7 个组件 |
| 无消费者样式 | 删除 58 个无消费者类名、118 个选择器分支 | 对完整类名、动态拼接、第三方生成节点和关键帧引用做过分层核查 |
| Tailwind 任意值 | 源码中的 arbitrary-value utility 出现次数从 2,013 降至 817 | 减少 1,196 处，约 59%；剩余项包含真正需要的动态/精确值，不能机械清零 |
| Tailwind 尺寸 | 179 个文件中的 1,704 组等值宽高改为 `size-*` | 同时将 34 个文件中的 62 组 padding、gap、定位等值组合改为标准简写 |
| 数值 token | 移除 68 个数值命名的 rem spacing token 和 5 个数字字重 token | 常规尺寸回归标准 Tailwind；局部精确值、运行时几何和复杂语义尺寸保留 |
| 长 className | 对 203 个文件中的长 Tailwind class 列表进行 `cn(...)` 分组 | 按布局、视觉、状态、响应式分类；这是可读性整理，不改变类集合 |
| 按钮尺寸漂移 | 52 处图标按钮尺寸覆盖归入共享 Button 规格 | 23 处使用 `icon-xs`，24 处使用 `icon-sm`，5 处删除与默认 icon 相同的覆盖 |
| 输入框漂移 | Input 与 Textarea 的 16 个相同基础工具类集中维护 | 单行高度、textarea 最小高度、文件输入、过渡和调用方覆盖顺序仍分别保留 |
| 动画 | CSS 关键帧从 80 组降至 9 组，动画声明从 176 处降至 11 处 | 分别减少 71 组（约 89%）和 165 处（约 94%） |
| Motion | `motion` 接入 8 个生产源码文件 | 覆盖折叠、瞬态弹层、mention 弹层、Skills 布局重排、列表拖拽和 reduced-motion |
| 自建动画基础设施 | 删除 `useFlipGrid`、`entranceOnce`、`menuMotion` 共 354 行 | Skills 的 single/wave/batch FLIP 编排改为 Motion layout；瞬态动画走共享组件 |
| 拖拽排序 | 434 行自建 `useVerticalListReorder` 替换为 207 行 `VerticalReorderList` | 3 个 Provider 列表调用点统一使用 Motion Reorder，减少 227 行基础设施代码 |
| 剪贴板漂移 | 文本复制底层调用出现次数从 36 降至 2 | 23 处 `navigator.clipboard.writeText` + 13 处 `execCommand("copy")` 收敛为共享边界中的各 1 处；七份 fallback 副本被合并 |
| 命令式 DOM | `document.createElement` 从 36 处降至 22 处，直接 style 写入从 105 处降至 26 处 | 分别减少 14 处和 79 处；保留编辑器、下载、测量和第三方渲染等合理边界 |
| 颜色 | 删除 80 个无消费者或重复颜色原语和 13 个 Tailwind 颜色映射 | 包括 23 个无消费者 `ui-color` 和 57 个黑白透明原语；仪表盘原始文字颜色引用从 44 处降至 1 处 |
| 边框与阴影 | 散落 CSS 中的 border 声明从 189 处降至 11 处，shadow/filter 声明从 77 处降至 6 处 | 分别减少 178 和 71 个 CSS 声明位置；大部分效果迁入 Tailwind/语义 token，并不代表视觉上删除了同等数量的边框或阴影 |
| 装饰投影 | 删除 SSH 卡片悬停投影、视图切换彩色投影/描边、ChoiceCard 选中投影及 Skills 结果提示厚投影 | 这是有意的视觉简化；键盘焦点、状态边框和选中底色保留 |
| Gateway 重复结构 | 6 个状态面板容器和 19 处标题/说明/区块标题统一 | 使用 `StatusPanel` 与 3 个 `StatusTypography` 展示组件，保留原生 section/p/h3/div |
| 快捷键设置 | 从 486 行设置页逻辑中拆出 252 行组件、190 行布局数据和 173 行局部 CSS | 删除运行时 `GHK_STYLE` 注入及颜色双写；61/87/104 键盘布局继续共用原几何 |
| SFTP 职责拆分 | `WorkspaceSftpPanel` 从 1,990 行降至 1,536 行 | 抽出路径导航组件和路径计算模块，主面板减少 454 行职责 |

最终源码不存在 `rounded-999px`、`rounded-9999px` 或对应 token。固定胶囊统一使用
`rounded-full`；8 处剩余 `rounded-[...]` 是经扫描保留的精确表达，不属于 999px 哨兵写法。

## 标准组件与共享能力

- 审查 15 个 DropdownMenu 消费文件，其中 14 个移除了调用方重复维护的字号、圆角、
  磨砂、投影、高亮和动画覆盖，统一使用共享菜单默认值。多行布局和业务尺寸继续由调用方控制。
- 5 类手写 Switch 实现接入共享 `Switch` / `SwitchRoot` / `SwitchThumb`，覆盖两个分享弹窗、
  Skills 设置、5 个 Provider Dialog 开关位置和 3 个资源开关消费者。两个特殊控件因语义不等价保留。
- 两组手写页签迁到共享 Tabs：会话顶部视图和轨迹详情。共享原语保留原来的单层 DOM、
  受控状态和“方向键只移动焦点，Enter/Space 激活”行为。
- 两个分享弹窗的脱敏选项接入 RadioGroup；会话搜索接入 `cmdk` Command，并保留原搜索排序、
  IME、Home/End、重试和打开会话逻辑。
- 设置表单的 76 个字段容器、78 个标签和 5 个说明迁到 FormField 组合；另统一 5 张 ChoiceCard、
  14 个 SettingsNotice 调用、5 个 SettingsPanel/Hint 调用、2 个 SettingsSurface 和 2 个紧凑空状态。
- Desktop 与 Gateway 各挂载共享 Toaster。聊天通知、图片反馈、Skill 扫描、导入结果和批量撤销
  统一生命周期、位置、更新、dismiss 与定时器清理。
- 七处文本复制 fallback 统一到 `lib/shared/clipboard.ts`；设置页复制按钮统一反馈 hook，
  保留 1,200/1,500/1,600/2,000ms 四档既有反馈时间。
- Git Review 删除 325 行在 `document.body` 手工创建 scrollbar 的实现，使用项目已有 6px 原生
  scrollbar；七个 drag/resize 入口统一 cursor、user-select、blur 和卸载恢复规则。
- SFTP 路径导航从 1,990 行面板中拆出，使主面板降至 1,536 行；路径计算由共享模块维护。

## 完整变更地图

### 共享基础组件

- 新增 `Command`、`RadioGroup`、`EmptyState`、`Skeleton`、`VerticalReorderList`、Toast 系列和
  `text-field-styles`；扩展 Button、Badge、Dialog、DropdownMenu、Popover、Select、Sheet、
  Switch、Tabs、Tooltip、ScrollArea、NumberInput、Checkbox 等既有原语。
- 新增 `FormField`、`ChoiceCard`、`SettingsNotice`、`SettingsPanel`、`SettingsSurface`、
  `SettingsCopyButton` 和 `StepMarker` 七个设置展示组件。组件只接管重复的结构与样式，
  请求、校验、保存、显示条件和状态仍由页面负责。
- 四处筛选 TabsList、三处计数 Badge、八处空态、六处步骤编号和五处选项卡片接入共享变体；
  Cron/SSH 的两个紧凑空状态以及 Cron/Agents 的两个紧凑 Badge 后续继续复用已有入口。
- 加载态集中为 Skeleton、LoadingSurface、LoadingTrack、FrostSpinner、HubLoading 与宿主骨架；
  Skills 与 MCP 原先相同的旋转指示器不再分别维护。

### Chat、会话与弹层

- Chat/Transcript 范围涉及 57 个组件：消息行、工具结果、推理折叠、附件、图片预览、文件拖入、
  上下文使用量、任务进度、会话搜索、分享、mention 弹层、工作区克隆与错误/确认弹层均完成样式迁移。
- `LazyCollapse`、`MotionPopover` 和 `MotionDirectionalPanel` 统一折叠与瞬态弹层生命周期，
  删除虚拟转录行的一次性进入注册表和桌面菜单的独立动画常量。
- 会话搜索换用无样式 cmdk Command，并增加输入/列表 ARIA 关联；顶部会话视图和轨迹详情页签
  换用共享 Tabs。分享流程的开关与脱敏单选分别换用 Switch 和 RadioGroup。
- Dialog、AlertDialog、ConfirmDialog、Popover、Sheet、Select、Dropdown 和 Tooltip 的状态动画
  改由统一 data 状态、Tailwind 或 Motion 表达；修复模型 Popover 与分支菜单退出时 scale/translate
  不在 transition-property 中导致的跳变。

### 设置与配置

- Provider、MCP、SSH、Cron、Hooks、系统、HTTP 请求、Agent 模板、Skills、STT、Memory、Remote、
  CUA 和 Backup Sync 的字段、标签、说明、提示、选择卡片、状态 Badge 与开关逐批收口。
- ModelPicker 统一“使用当前模型”和普通模型选项，集中 default/compact/quiet/dashed trigger 规格；
  高级设置模型选择器保留细边框并明确去除阴影。
- GlobalShortcutsSection 不再在运行时注入整段 CSS。ShortcutKeyboard 将键位布局、渲染、缩放和
  立体主题分开维护，保留快捷键录制、系统注册和状态优先级。
- 修复设置浮层重复打开或关闭中重开时短暂露出聊天页的问题，并将目标设置分区在子页面提交前同步，
  避免先提交旧分区再通过 effect 跳转。
- 修复 ResourceActivationSwitch 隐藏 input 的额外 click 冒泡，以及小号滑块右侧内间距不对称；
  资源卡片、批量选择和禁用态的事件隔离继续保留。

### Skills、MCP 与资源管理

- Skills Hub 删除 single/wave/batch 三套 FLIP 测量和计时器，卡片重排交给 Motion layout；
  安装、卸载、启停、筛选、排序和批量恢复统一走同一布局动画通道。
- Skills 首帧从 discovery 缓存初始化，进入页面时复用缓存与在途请求；主动扫描仍强制刷新，
  安装/删除继续使缓存失效。移除 `useDeferredValue` 的人为初始空列表，减少切回页面时的加载跳动。
- Skill 扫描、导入结果和批量撤销迁到全局 Toast，同时保留右下、右上和底部居中三类原位置，
  保留 6,500ms 扫描提示、常驻导入结果和 6,000ms 撤销时长。
- MCP Store 与 Skills Store 卡片由 `focus:ring` 改为 `focus-visible`，避免鼠标点击或预览关闭回焦时
  叠出第二层边框；STT 供应商选中态也移除了重复 ring。

### Workbench、终端、Git 与 SFTP

- Desktop 与 Gateway 不再通过全局 `document.querySelector` 猜测 Workbench Canvas；控制器显式
  暴露 `canvasRef`，文件拖入命中测试与 React 节点所有权一致。
- 七个 drag/resize 入口通过 `globalPointerStyle` 协调 cursor 和 user-select。每个 owner 独立释放，
  blur、visibilitychange 和卸载时兜底清理，避免重叠交互恢复过期样式。
- Transcript、Right Dock 和 Trajectory 的高频宽度更新保留 CSS 变量与 requestAnimationFrame 合并；
  ShortcutKeyboard 的低频 ResizeObserver 结果改由 React state/JSX style 输出。
- CommitComposer 与可编辑用户消息的 textarea 自动伸高统一到 `useAutosizeTextarea`；Web composer
  由宿主显式传入高度 owner ref，不再用 `closest(...)` 查找祖先。
- Git Review 删除 React 树外 scrollbar、WeakMap、定时器和全局 pointer 监听器；Status、History、
  Diff 统一使用全局 6px scrollbar。终端颜色与尺寸由 `lib/terminal/theme.ts` 提供给 xterm API。
- SFTP 路径导航拆出面包屑、键盘选择、刷新和过期请求隔离逻辑；原文件传输、重命名、删除与右键菜单
  的选择上下文保持在主面板中。

### Gateway WebUI

- Gateway 源码变更 28 个文件，覆盖登录、聊天框架、历史切换、Agent/User 菜单、共享历史、设备管理、
  设置同步和状态仪表盘。
- 删除 `base-chat.css`、`login.css`、`responsive.css`、`status-board.css` 和旧样式聚合入口；断点、
  高度媒体条件、触屏、安全区、伪元素和 reduced-motion 迁到实际消费者。
- 状态仪表盘使用 StatusPanel、StatusTypography 和语义颜色，保留雷达、网格、tone 变量及深色产品皮肤；
  登录和共享历史的加载/错误/空态复用局部展示结构。
- 转录区与 composer 共用网格列定义，历史切换遮罩、移动端 composer、右侧 Dock scrollbar 与轨迹布局
  的宿主契约同步更新测试。

### Desktop 宿主

- Desktop 宿主源码变更 34 个文件，覆盖应用根 Toaster、启动/加载壳、macOS/Windows 标题栏、
  原生输入右键菜单、聊天 Transcript、通知适配、图片预览和全局快捷键设置。
- 原生输入右键菜单与 Transcript 复制改用共享 clipboard；菜单展示使用 MotionPopover，仍保留
  WebView 输入选择、粘贴权限和焦点恢复边界。
- PaneLoadingSkeleton、ConversationPaneHost 和 Transcript 行模型随共享 Tailwind/动效入口更新；
  Tauri 调用、会话请求和后端协议没有改动。

### 工程配置与防回退

- 三份分散 Biome 配置合并为根 `biome.json`，根脚本统一格式化和 lint 三个 UI 源码目录；CI 新增
  shared UI typecheck/lint，并拒绝改动范围内新增 Biome warning。
- 新增共享 `tsconfig.base.json` 和 `tsconfig.node.base.json`，GUI、Gateway、agent-ui 与 virtual-core
  继承同一严格选项；Docker WebUI 构建同步复制这两个配置，隔离 CI 安装根工作区依赖。
- UI boundary 检查增加颜色新增规则、组件边界和 token/class 合并契约。一次性视觉夹具和迁移扫描
  均已删除，没有留下额外迁移脚本。
- `scripts/dev-stack.mjs` 不再通过 `mise exec` 启动 Go、Vite 和 Tauri，改为直接调用 `go`、当前 Node
  与 `pnpm`。这会改变开发机工具解析路径，属于需要 reviewer 明确认可的非视觉行为变化。

## 样式架构

- Tailwind 升级为 CSS-first v4 配置。GUI、Gateway 与共享 UI 统一从 `tokens.css`、
  `semantic-colors.css` 和 `animations.css` 读取主题、特殊 token 与基础关键帧；旧的两份
  `tailwind.config.js` 被删除。
- Gateway 的 `base-chat.css`、`login.css`、`responsive.css`、`status-board.css`，以及共享 UI
  的 `common-*.css`、`transcript.css` 等业务样式表已删除。伪类、伪元素、data 状态、移动端断点、
  安全区、触屏和 reduced-motion 能由 Tailwind 表达的部分都迁到消费组件。
- CSS 只保留主题/token、基础动画、字体、根节点默认值、浏览器全局滚动条、第三方生成节点、
  Streamdown portal，以及快捷键立体键盘这类无法合理挂到 React 消费节点的规则。
- 错误统一使用 shadcn `destructive`，成功状态使用成对的 `success` 语义色。状态仪表盘、Cron、
  Hooks、Badge 和危险操作已接入；终端、品牌、代码高亮、分类图表仍保留专用颜色契约。
- 普通 UI 字号收敛到 Tailwind rem 档位。这一项会改变部分字号和默认行高；Markdown 的 em 比例、
  xterm 的 13px API 字号和特殊精确排版保留。

## 行为变化与风险

这不是纯机械重排，以下内容需要作为 PR 的重点复测项：

1. Skills Hub 的三套自建 FLIP 动画统一为 Motion spring（stiffness 420、damping 36、mass 0.7）。
   动画节奏会变化，筛选、排序、安装、卸载和批量操作需要肉眼判断是否自然。
2. Provider 列表拖拽改用 Motion Reorder。需要验证拖动手感、插入位置、滚动容器、取消和持久化顺序。
3. Git Review 使用平台原生 scrollbar，常显策略由系统决定。视觉与旧悬浮 thumb 有意不同。
4. 普通 UI 字号归入标准档位，部分文本宽度、行高和换行可能变化；危险色、成功色和少量投影也有
   明确的视觉调整。
5. Command、Switch、Tabs、RadioGroup 改变了底层交互原语。自动测试覆盖键盘与受控状态，仍需在
   Tauri WebView 中确认焦点、输入法和屏幕阅读器体验。
6. Toast 从页面局部数组迁到全局管理器。需要确认跨页面关闭、同 ID 更新、常驻通知、撤销动作和
   页面卸载后的定时器行为。
7. 大量响应式、伪元素和安全区规则从 CSS 迁到 TSX。桌面/移动端断点、暗色主题和 Gateway 登录前后
   都应做真实页面检查。
8. MentionComposer、Header Combobox 和各类 ContextMenu 保留原实现；这三类未计入“完成迁移”。
9. Skills 页面现在会直接展示已有 discovery 缓存，并复用在途请求。需要验证切换账号/工作区、
   安装删除后的失效、手动强制扫描和错误重试不会显示过期列表。
10. 设置浮层重开时序、资源 Switch 冒泡、Tabs 首次测量、Popover 退出属性和焦点 ring 包含行为修复；
    这些并非单纯换写法，应该按对应复测路径确认修复没有影响相邻交互。
11. 根 Biome/TypeScript 配置和 CI 安装范围会影响三个包的独立检查；`dev-stack` 直接调用系统工具，
    需要在没有 `mise` 包装的开发环境确认 Go、Node、pnpm 版本及 PATH 解析符合项目预期。

新增运行时依赖为 `motion@13.2.0` 和 `cmdk@1.1.1`。Motion 负责折叠、弹层、布局与排序动画；
cmdk 只用于会话搜索。它们会增加前端依赖和 bundle 内容，也是本 PR 最明确的库级行为变化。

## 自动验证

最终源码版本已完成以下检查：

- `pnpm lint`：1,003 个源码文件通过。
- `pnpm typecheck:ui`、`pnpm typecheck:gui`、`pnpm typecheck:webui`：通过。
- `pnpm test:gui`：3,138 项通过。
- `pnpm test:webui`：718 项通过。
- `pnpm check:ui-boundaries`、样式约束与脚本测试：通过。
- `pnpm build:gui`、`pnpm build:webui`：通过；GUI 仍有既有的大 chunk 提示。
- `git diff --check`：通过。

阶段验证还覆盖了亮暗主题、16/20px 根字号、桌面/移动端断点、普通/禁用/焦点状态、
reduced-motion，以及迁移前后的局部计算样式和 DOM 契约。夹具已在使用后删除，不属于产品代码。

## 人工复测路径

### Desktop GUI

1. 启动应用，在亮色和暗色主题分别进入聊天、设置、Skills、MCP、资源管理和工作区。
2. 聊天：发送与流式回复；展开/收起推理和工具结果；消息复制；图片预览与路径复制；文件拖入；
   mention 搜索、键盘选择、IME 输入、粘贴、撤销和草稿恢复。
3. 会话：侧栏分组和菜单；会话搜索的输入、方向键、Home/End、Enter 与重试；顶部视图 Tabs；
   分享弹窗的 Switch、RadioGroup、复制链接和禁用分享。
4. Workbench：文件拖入 Pane；会话宽度、右侧工具面板和轨迹详情宽度拖动；Dock Tab 拖拽排序；
   打开/关闭/切换多个 Pane 后确认 cursor 与 user-select 恢复。
5. Git Review：Status、History、Diff 的横纵滚动、文本选区自动滚动、提交信息/SHA/差异复制，
   并确认系统 scrollbar 在当前平台可辨识。
6. 终端：鼠标选区复制、快捷键复制粘贴、复制后焦点恢复；切换主题检查 xterm 颜色。
7. 编辑器与 SFTP：预览复制、右键菜单、代码编辑器焦点；SFTP 面包屑、键盘选择、刷新、传输和
   过期请求切换；真实服务器路径与错误状态。
8. 设置：Provider、模型、MCP、SSH、Cron、Hooks、系统、远程、CUA、STT、Memory、备份同步和
   快捷键录制；逐项检查标签、说明、错误提示、开关锁定、Dropdown 和保存后的状态。
9. Skills/MCP：筛选、排序、搜索、安装、启停、卸载、批量选择和批量操作；观察卡片重排动画及
   Toast 的右上、右下、底部居中位置。

### Gateway WebUI

1. 在 1,600px、820px、380px 附近分别检查登录、设置同步、聊天、共享历史、设备管理和状态仪表盘；
   同时覆盖亮暗宿主与移动端安全区。
2. 登录页检查 Logo、特性卡片、输入控件、触屏状态和断点换行；状态仪表盘检查面板、雷达、事件流、
   高度媒体条件和动画。
3. 登录后复测聊天发送、历史切换遮罩、模型/Agent/User 菜单、工作区 Dock、终端与复制能力。
4. 共享历史检查加载、错误、空内容和正常内容；设备页检查 token 复制和移动端设置布局。

### 动效、键盘和可访问性

1. 在系统“减少动态效果”关闭和开启时各跑一遍折叠、弹层、Skills 重排、Toast 和拖拽排序；开启时
   不应出现位移动画或长时间退出等待。
2. 仅用键盘操作 Dropdown、Switch、Tabs、RadioGroup、Command、Dialog 和分享流程；确认焦点环、
   Escape、Tab 离组、Enter/Space 单次触发及禁用态。
3. 检查 125% 字号缩放、长中文/英文、窄窗口和滚动区域，重点观察标题截断、表单标签换行、弹层尺寸、
   菜单行高和状态徽标。

## Screenshots / preview

该 PR 包含有意的字号、状态色、投影、动画和 scrollbar 变化，需要在提交 PR 时附上：

- Desktop：聊天、设置、Skills Hub、Git Review 各一组亮暗截图或录屏。
- Gateway：登录页、状态仪表盘和移动端聊天各一组截图。
- 动效：Skills 排序/启停、Provider 拖拽、折叠/弹层和 reduced-motion 的短录屏。

## Pre-submit checklist

- [ ] 填入关联 issue。
- [ ] 删除 `docs/ui-refactor/` 临时目录及 `docs/README.md` 中的临时导航。
- [ ] 重新与目标 `main` 同步并确认无冲突。
- [ ] 完成上述高风险人工复测并补截图/录屏。
- [ ] 复跑 lint、三组 typecheck、GUI/WebUI 全量测试、UI boundaries 和双端构建。
- [ ] 确认没有 secrets、token、个人数据或一次性迁移脚本进入 PR。
