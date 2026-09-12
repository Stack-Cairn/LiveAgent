# React 命令式 DOM 审计与治理计划

状态：阶段 0—4 已实现；阶段 5 已从当前分支撤出，保存在独立实验分支等待专项验收
审计日期：2026-09-12
目标分支：`refactor/ui`

## 当前进度

| 阶段 | 状态 | 已完成内容 | 尚需确认 |
| --- | --- | --- | --- |
| 0：边界和基线 | 完成 | DOM 所有权规则、P1/P2/P3 清单、验证入口与防回归规则 | 后续发现的新模式继续补入清单 |
| 1：低风险收敛 | 完成 | 七处剪贴板副本合并；Workbench Canvas 改为显式 ref；FloorNavRail 与 TrajectoryTable 改为节点 ref；删除 `--spacing-minus-9999px` | 肉眼检查终端复制后的焦点与 Workbench 文件拖入 |
| 2：全局交互 | 代码治理完成 | 七个拖拽/resize 入口统一管理 cursor/user-select；快捷键缩放改为 state/JSX style；textarea 自动伸高收敛到共享边界；Web composer 显式接收高度 owner ref | 肉眼拖拽、缩放与输入框伸缩验证 |
| 3：滚动条 | 自动验证完成 | 删除 Git Review 手工 overlay、WeakMap、timer 与 body 节点；回到项目统一的 6px 原生 scrollbar | Status、History、Diff 肉眼滚动与选区自动滚动 |
| 4：Motion 动画 | 自动验证完成 | 删除 `useFlipGrid.ts`；Skills Hub 卡片改用 LazyMotion、LayoutGroup 和 layout position | 安装、启停、批量操作、排序和筛选的肉眼手感确认 |
| 5：编辑器 | 当前分支暂缓，实验完整保留 | `refactor/ui` 继续使用原有 MentionComposer；Lexical 换核保存在 `refactor/mention-composer-lexical` 独立工作树，未提交 | 在独立分支完成 Tauri WebView、系统 IME、选区、撤销、草稿切换、视觉和 VoiceOver 对照后再决定是否合入 |

阶段 1 的实现原则：兼容性 DOM 只保留在共享剪贴板边界中；React 拥有的节点通过 ref 传递；拖拽幽灵在 ref 挂载时同步获得位置，因此不再使用 `-9999px` 这类哨兵样式。

阶段 2 的全局样式管理器位于 `crates/agent-ui/src/lib/shared/globalPointerStyle.ts`。每次交互拿到独立 release 函数；新的 owner 只覆盖自己声明的属性，释放旧 owner 不会把新 owner 的 cursor 或 user-select 冲掉。最后一个 owner 释放时恢复交互开始前的 inline style，窗口失焦或页面隐藏时统一兜底释放。

阶段 2 进一步把 `ShortcutKeyboard` 的五处 observer 内样式写入改成 state 和 JSX style；Git commit 与消息编辑的 textarea 自动伸高统一到 `useAutosizeTextarea.ts`；Web composer 不再通过 `closest(".gateway-chat-frame")` 猜 owner，由主会话和每个 Workbench Pane 显式传 ref。保留的高频宽度/拖拽 CSS 变量写入均位于按帧合并的交互 hook 中。

阶段 3 选择原生 scrollbar，因为仓库已经在 `base.css` 为 WebKit scrollbar 提供 6px 的统一视觉。Git Review 不再隐藏原生 scrollbar，也不再在 React 树外重造一套 thumb。代价是 scrollbar 常显策略由平台决定，尺寸和颜色继续跟随全局主题。

阶段 4 取消了 single、wave、batch 三种手工编排，统一为 stiffness 420、damping 36、mass 0.7 的 spring。`useReducedMotion()` 为真时关闭 layout 动画。筛选、排序、启停和批量状态造成的卡片重排都走同一个 Motion 布局通道，不再自行读取前后 rect。

本轮自动验证结果：

- `pnpm lint`：通过，检查 1003 个源码文件。
- `pnpm typecheck:ui`、`pnpm typecheck:gui`、`pnpm typecheck:webui`：通过。
- `pnpm test`（在 `crates/agent-gui` 中执行，包含 frontend 与 backend）：3148 项中 3147 项通过；唯一失败是未改动的 Rust shell-session 时序测试未及时读到子进程 PID，随后精确复测 1/1 通过。
- `pnpm test:webui`：718 项通过。
- `pnpm check:ui-boundaries`：通过。
- `pnpm check:script-tests`：12 项通过。
- `pnpm build:gui`、`pnpm build:webui`：通过。

## 目标

减少 React 管理范围内的命令式 DOM 创建、查询和样式写入，让节点生命周期、状态、事件与样式尽量回到 JSX、React state、ref、Portal、Motion 和共享基础设施中。

本计划不要求消灭所有 DOM API。编辑器选区、元素测量、Canvas、文件下载、第三方渲染器和浏览器兼容层必须与 DOM 交互。治理标准是 DOM 的所有权：

- React 拥有的 UI 节点，不应在 React 树外另建一套创建、更新和销毁流程。
- 浏览器或第三方库拥有的节点，可以命令式操作，但必须封装在边界模块内，并保证清理、错误处理和服务端安全。
- 高频事件中的测量与写入必须分帧，避免交错读写造成强制同步布局。
- 可由 Tailwind 表达的静态样式继续使用 Tailwind；动态几何值使用 React `style` 或少量语义明确的 CSS 变量。
- 超过 8 个 Tailwind 类名的节点继续用 `cn(...)` 按布局、视觉、状态和响应式规则分组。

## 审计范围和方法

范围包括：

- `crates/agent-ui/src`
- `crates/agent-gui/src`
- `crates/agent-gateway/web/src`

搜索信号包括 `document.createElement`、`appendChild`、`innerHTML`、`querySelector`、`classList`、直接写 `element.style`、`setAttribute`、`Range`、`Selection` 和 `execCommand`。

目标扫描筛出 31 个与 UI DOM 所有权直接相关的文件。另有少量搜索结果来自数组 `append`、数据结构字段或只读环境探测，不属于 DOM 修改。

## 结论

当前有两个应优先替换的自建 UI 系统：

1. Git Review 悬浮滚动条在 React 树外创建节点并维护完整事件和定时器生命周期。
2. Skills Hub 自制 FLIP 动画直接测量并修改每张卡片，已经形成一套命令式动画引擎。

另有三个需要治理的重复或耦合问题：

1. 剪贴板降级实现复制了至少六份隐藏 textarea 逻辑。
2. Desktop 和 WebUI 都通过全局 `document.querySelector` 寻找 Workbench Canvas。
3. 多套拖拽和 resize hook 各自修改 `document.body` 的 cursor 与 user-select，缺少统一的并发和恢复语义。

`MentionComposer` 是特殊项目。当前实现是一套建立在 `contenteditable`、Range 和 Selection 上的自制富文本编辑器内核。它确实是最重的命令式 DOM 区域，但换核会同时改变 IME、selection、history、clipboard 和 chip 视觉，风险明显高于本轮其他治理项，因此当前分支继续保留原实现。

详细行为矩阵、选型、node 设计和实验记录见 `docs/ui-refactor/mention-composer-migration.md`。Lexical 0.50.0 的实现和自动化证据均保存在 `refactor/mention-composer-lexical` 工作树；这些证据不足以替代真实 Tauri、IME、可访问性和视觉对照，所以不进入当前 `refactor/ui` 交付范围。

## 分级标准

| 等级 | 含义 | 处理方式 |
| --- | --- | --- |
| P0 | 已发现确定的数据丢失、安全或节点泄漏 | 立即修复 |
| P1 | React 外维护 UI 生命周期，复杂且容易漂移 | 当前治理周期替换 |
| P2 | 可用 React ref/state 或共享 hook 收敛 | 分批清理 |
| P3 | 合理的浏览器、编辑器或第三方边界 | 保留并补齐边界约束 |

本次静态审计没有确认 P0 缺陷。P1 和 P2 项足以解释代码复杂、样式散落和后续交互难以维护的问题。

## P1：应替换的命令式 UI

### Git Review 悬浮滚动条

文件：`crates/agent-ui/src/components/project-tools/git-review/useOverlayScrollbar.ts`

使用位置：

- `git-review/DiffView.tsx`
- `git-review/HistoryView.tsx`
- `git-review/StatusView.tsx`

当前实现：

- 使用 `document.createElement("div")` 建立横向和纵向 thumb。
- 直接挂到 `document.body`。
- 用 WeakMap 维护 viewport、overlay 和隐藏定时器的关系。
- 手动注册 pointerenter、pointerleave、pointerdown、pointermove、pointerup、pointercancel 和 resize。
- 直接写 `display`、`left`、`top`、`width`、`height` 与 dataset。
- 自己处理拖动、滚动换算、悬停、隐藏和销毁。

问题：

- 节点不属于调用组件的 React 树，状态和生命周期难以从组件结构判断。
- 每次滚动同时读布局和写样式，容易引入 layout thrashing。
- 多 viewport 同时使用时，WeakMap、全局监听器和定时器共同决定真实状态。
- Tailwind class 被塞进字符串再赋给手工节点，无法获得正常的组件组合和类型约束。

推荐方案：

1. 先确认原生 scrollbar 是否可以满足产品要求；可以则删除整套 overlay。
2. 确实需要悬浮 scrollbar 时，建立 `OverlayScrollbar` React 组件。
3. 组件通过 Portal 渲染两个 thumb，通过 state 保存几何数据和可见状态。
4. viewport 通过 ref 明确传入，事件使用 React handler；window/ResizeObserver 监听仍放在 effect 内。
5. pointermove 的高频位置写入可以保留 CSS 变量或 Motion value，避免每帧触发 React 树重渲染。

验收：Diff、History、Status 的横纵滚动、拖动、选中文本自动滚动、窗口 resize、切换 Tab 和卸载后清理全部正常。

### Skills Hub FLIP 动画

文件：`crates/agent-ui/src/pages/skills-hub/useFlipGrid.ts`

当前实现：

- 排序前后分别调用 `getBoundingClientRect()`。
- 查询所有 `[data-flip-key]` 卡片。
- 直接写 `transition`、`translate`、`willChange` 和 `zIndex`。
- 用 requestAnimationFrame 和多组 timeout 编排 hero、wave、batch 三种模式。
- 手动处理 reduced motion、延迟上限与样式复位。

问题：

- 组件排序状态和动画状态分属 React 与 DOM 两套系统。
- 动画中途重新排序、卸载或无关渲染时，需要大量防御性清理。
- hero/wave 的主观动画策略与布局测量、滚动跟随混在同一个 hook。
- 这正是项目计划采用 Motion 后可以删除的重复基础设施。

推荐方案：

- 使用 Motion `LayoutGroup` 和卡片的 `layout`/`layoutId` 管理位置变化。
- hero、wave、batch 只保留为 transition 参数或少量 variants。
- 使用 `useReducedMotion()` 统一处理降低动画偏好。
- 把“排序后让目标卡片进入视口”保留为独立 hook，不和布局动画生命周期绑定。

肉眼检查位置：Skills Hub 的安装、卸载、批量操作、排序切换和过滤结果变化。

## P2：应收敛的实现

### 剪贴板兼容代码重复

已有共享实现：`crates/agent-ui/src/lib/shared/clipboard.ts`

重复位置：

- `crates/agent-ui/src/components/chat/ImagePreview.tsx`
- `crates/agent-ui/src/components/chat/MentionComposerInternals.tsx`（当前分支仍保留；独立 Lexical 实验已删除）
- `crates/agent-ui/src/components/project-tools/XTermViewport.tsx`
- `crates/agent-ui/src/components/project-tools/git-review/model.ts`
- `crates/agent-ui/src/components/workspace-editor/WorkspaceFilePreviewOverlay.tsx`
- `crates/agent-gui/src/components/input-context-menu/NativeInputContextMenu.tsx`
- `crates/agent-gui/src/pages/chat/transcript/transcriptUtils.ts`

隐藏 textarea 与 `execCommand("copy")` 是旧 WebView 的兼容边界，可以保留一份。各副本目前在以下细节上不一致：

- 有的返回 boolean，有的 fire-and-forget，有的抛异常。
- 隐藏位置分别使用 `top: -9999px`、`left: -9999px` 或 opacity。
- XTerm 需要复制后恢复焦点。
- 部分实现使用 `removeChild`，部分使用 `remove()`。
- `XTermViewport` 使用了 `--spacing-minus-9999px` 这类没有设计语义的 token。

推荐方案：扩展共享函数，使其支持同步结果、错误传播和可选的焦点恢复，然后删除所有副本。隐藏 textarea 的样式留在这一浏览器兼容函数内部，不进入设计 token。

### Workbench Canvas 全局查询

文件：

- `crates/agent-gui/src/pages/ChatPage.tsx`
- `crates/agent-gateway/web/src/app/GatewayAppView.tsx`
- `crates/agent-ui/src/lib/workbench/useWorkbenchDragSession.ts`

当前实现通过 `[data-workbench-canvas]` 从 document 查找画布，再读取 rect 做拖入命中测试。

问题：

- 多 Workbench、隐藏副本或未来 Portal 都可能让查询命中错误节点。
- Desktop 与 WebUI 重复依赖同一个私有 data attribute。
- 调用点无法从类型上知道 Canvas 是否存在。

推荐方案：Workbench controller 暴露 `canvasRef` 或 `getCanvasElement()`；Desktop、WebUI 和 drag session 使用同一引用。data attribute 仅保留给测试定位。

### 布局测量后直接写 React 节点样式

涉及：

- `crates/agent-gui/src/pages/settings/ShortcutKeyboard.tsx`
- `crates/agent-ui/src/components/chat/MentionComposerOverlays.tsx`
- `crates/agent-ui/src/pages/chat/ChatComposerBar.tsx`
- `crates/agent-ui/src/components/project-tools/useRightDockPanelWidth.ts`
- `crates/agent-ui/src/pages/chat/transcript/TranscriptWidthControls.tsx`

判定：这些代码需要 ResizeObserver 或 rect 测量，测量本身合理。需要收敛的是输出路径。

执行结果：

- `ShortcutKeyboard` 的低频测量写入已转为 state/JSX style。
- commit composer 与可编辑消息 textarea 的 `scrollHeight → height` 写入已合并到共享 hook。
- Web composer 高度仍用 CSS 变量向兄弟区域传递，但 owner 改为显式 ref，不再查询祖先。
- RightDock/Transcript resize 和拖拽 ghost 属于高频路径，保留单一 CSS 变量与 requestAnimationFrame 合并写入。
- Mention popup 的 position 写入属于编辑器选区弹层边界，随阶段 5 editor adapter 一起迁移。

建议：

- 低频 resize：将测量结果写入 React state，再通过 JSX `style` 输出。
- 高频拖动：使用 Motion value 或单一 CSS 变量，requestAnimationFrame 合并写入。
- 静态视觉规则继续使用 Tailwind，不把颜色、圆角、阴影写进动态 style。
- 统一“测量读取”和“样式写入”的帧阶段，避免读写交错。

### 全局拖拽样式

涉及：

- `lib/sidebar/useSidebarReorderDrag.ts`
- `lib/workbench/useWorkbenchDragSession.ts`
- `components/ui/useVerticalListReorder.tsx`
- `components/project-tools/useRightDockTabReorder.tsx`
- `components/project-tools/useRightDockPanelWidth.ts`
- `pages/chat/transcript/TranscriptWidthControls.tsx`
- `components/trajectory/details/DetailsResizeHandle.tsx`

这些 hook 都会保存并覆盖 `document.body` 或 `document.documentElement` 的 `cursor`、`userSelect`。

风险：两个交互意外重叠、组件中途卸载或 window blur 时，后结束的 cleanup 可能恢复一个过期值。

推荐方案：建立共享 `useGlobalPointerSession`/`acquireGlobalDragStyle`，使用 token 或引用计数管理占用，统一处理 pointer capture、Escape、blur、visibilitychange、卸载和样式恢复。

### 可声明化的滚动定位

文件：

- `components/chat/transcript/FloorNavRail.tsx`
- `components/trajectory/TrajectoryTable.tsx`

当前实现从自身 ref 下 querySelector 当前行，再调用 `scrollIntoView()`。范围已经局限在组件根节点，风险较低。后续可由行组件登记 ref，避免依赖 data attribute 字符串；不需要优先修改。

### BrowserPathPrompt 独立 React root

文件：`crates/agent-gateway/web/src/shims/browserPathPrompt.tsx`

它为 Promise 风格宿主 API 创建 host、`createRoot`、渲染对话框，并在完成后 unmount/remove。清理是完整的，因此不是缺陷。

改进方向：如果全局 OverlayHost 已能提供命令式服务，可把请求送入现有 OverlayHost，避免每次建立独立 root。优先级低于滚动条和动画。

## P3：应保留的 DOM 边界

### MentionComposer 的暂缓边界

文件：

- `components/chat/MentionComposer.tsx`
- `components/chat/MentionComposerInternals.tsx`
- `components/chat/MentionComposerOverlays.tsx`

当前分支仍由业务组件创建 chip、维护 caret anchor、扫描原生 Selection/Range，并在历史记录中暂存 `innerHTML`。这不是理想的 P3 浏览器边界，而是明确延期的 P1 项。延期原因是现有实现虽复杂，却承载长期积累的交互语义；本轮不能用不完整的自动化证明一次高风险换核与它等价。后续只在独立分支处理，不再把编辑器迁移与滚动条、Motion、clipboard 和 ref 治理混成一次交付。

### 第三方 renderer

`WorkspaceFilePreviewOverlay.tsx` 清空专属容器后调用 docx `renderAsync`。容器内部由第三方库拥有，使用 `innerHTML = ""` 做清理合理。应保持 effect cleanup 和 cancelled guard。

### Canvas、图片转换和下载

以下操作属于浏览器能力边界：

- 图片适配器创建 Canvas 做格式转换。
- WebUI 创建隐藏 anchor 触发文件下载。
- Mermaid 全屏预览解析 SVG、补 viewBox/preserveAspectRatio。

这些节点不是产品 UI 状态，不需要改成 React 组件。

### 主题和字体根变量

`App.tsx` 与 `useGatewaySettingsSync.ts` 在 documentElement 上切换 `dark`，`fontFamily.ts` 写根级字体 CSS 变量。这是全局主题基础设施，React 组件树之外仍需要一个明确的 document 根副作用。保持单一入口即可。

### 拖动、选区和尺寸读取

`getBoundingClientRect`、`scrollHeight`、Pointer Capture、Range、Selection、ResizeObserver 和 `elementFromPoint` 都属于交互实现必需的浏览器 API。审计重点是限制作用域、统一生命周期和降低写入次数，而不是删除这些读取。

## 分阶段 Goal

### 阶段 0：建立边界和基线

- 为命令式 DOM 分类建立文档基线。
- 记录每个保留边界的 owner 与 cleanup 责任。
- 不增加一次性迁移脚本或长期扫描脚本。
- 为高风险交互确认现有测试覆盖和肉眼检查入口。

完成条件：本文件中的清单与源码一致，后续每阶段都能独立提交和回滚。

### 阶段 1：低风险收敛

- 合并剪贴板实现。
- 删除 `--spacing-minus-9999px`。
- Workbench Canvas 改用显式 ref/controller API。
- FloorNavRail 和 TrajectoryTable 在合适时改用注册 ref。

完成条件：零重复隐藏 textarea 实现；全仓没有全局查询 Workbench Canvas；复制、终端焦点和拖入命中测试通过。

### 阶段 2：布局与全局交互基础设施

- 抽取统一的全局 pointer/drag session。
- 收敛 body cursor/user-select 写入与恢复。
- 将低频测量结果通过 state/JSX style 输出。
- 高频 resize 保留单一 CSS 变量写入，并按帧合并。

完成条件：所有拖动/resize 在 mouseup、pointercancel、Escape、blur、visibilitychange 和卸载时恢复；同时只存在一个全局样式 owner。

### 阶段 3：替换 Git Review 悬浮滚动条

- 先评估原生 scrollbar。
- 保留自定义视觉时改成 React Portal 组件。
- 删除 document.body 下的手工节点、WeakMap UI registry 和手工 className 拼装。

完成条件：横纵滚动、thumb 拖动、选区自动滚动和多面板切换可用；卸载后无节点和监听器残留。

### 阶段 4：Motion 接管 Skills Hub 布局动画

- 用 LayoutGroup/layout/layoutId 替换 FLIP 测量和 style 写入。
- 删除 animation frame、phase timer、cleanup timer 和手写 stagger。
- 把自动滚动从动画 hook 分离。

完成条件：安装、卸载、排序、过滤和批量操作动画自然；reduced motion 无位移动画；`useFlipGrid.ts` 删除。

### 阶段 5：MentionComposer 架构决策

- 先写行为矩阵和 editor document model。
- 制作 Lexical 与 ProseMirror/Tiptap 的小范围原型，比较 IME、mention、clipboard 和历史记录。
- 选定方案后按输入、selection、node、clipboard、history 插件逐步迁移。
- 在自动化行为矩阵通过后切换公开入口并删除旧实现，不长期维护双写或 feature switch。

当前分支没有执行本阶段。代码完成条件仍是：业务组件不创建 chip、不保存整段 `innerHTML`、不使用 `execCommand` 编辑；公开入口只导出选定框架的 shell 和稳定文档协议。

完成条件：编辑器 DOM 由所选框架管理；业务组件不再创建 mention chip 或保存整段 innerHTML；所有草稿与发送序列化行为保持兼容。

实验状态：5A—5D 的实现、测试和双端 Chromium 证据完整保存在 `refactor/mention-composer-lexical` 工作树。真实浏览器复测发现过 fixture 仍测旧裸编辑器、纯文本 token fallback 未接入两项差异，修复后 GUI/WebUI 通过 18 组文本、结构化 clipboard、手工换行和 undo/redo。正因为自动测试全绿后仍能发现行为缺口，当前分支选择撤出整个换核；实际 Tauri WebView、系统 IME、视觉和 VoiceOver 对照完成前不合入。完整设计见 `mention-composer-migration.md`。

## 每阶段验证

自动验证：

- `pnpm lint`
- `pnpm typecheck:ui`
- `pnpm typecheck:gui`
- `pnpm typecheck:webui`
- `pnpm test:gui`
- `pnpm test:webui`
- `pnpm check:ui-boundaries`
- `pnpm build:gui`
- `pnpm build:webui`

肉眼验证：

- Git Review：Status、History、Diff 的横纵滚动和选区拖动。
- Skills Hub：筛选、排序、安装、卸载和批量操作。
- Workbench：拖入文件时 Pane 命中与聚焦。
- Resize：会话宽度、右侧工具面板和轨迹详情面板。
- Clipboard：聊天正文、图片路径、文件预览、Git diff、xterm 和原生输入上下文菜单。
- MentionComposer：IME、mention、粘贴、撤销、草稿恢复和发送。

## 防回归规则

- 新增 `document.createElement`、`innerHTML` 或向 document.body 挂 UI 节点时，代码评审必须说明 owner、cleanup 和为什么不能由 JSX/Portal 表达。
- 不为一次性迁移新增仓库脚本；需要扫描时使用临时命令，完成后不留文件。
- 不以新的 arbitrary Tailwind token 代替 DOM style；静态值使用标准 utility，真正动态的像素值才使用 `style`/CSS 变量。
- 新的动画默认使用 Motion 或现有共享动效组件；CSS 只保留基础 keyframes 和无法由 utility/Motion 表达的全局规则。
- 命令式第三方挂载必须使用专属空容器，React 不同时管理该容器内部子节点。

## 推荐执行顺序

1. 剪贴板与 Workbench ref。
2. 全局 pointer/drag session。
3. Git Review scrollbar。
4. Skills Hub Motion 布局动画。
5. MentionComposer 编辑器迁移。

前两项适合小步改动；滚动条和动画需要肉眼验证；编辑器迁移必须独立设计和实施。
