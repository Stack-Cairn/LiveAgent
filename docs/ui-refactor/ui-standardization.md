# UI 标准组件使用约定

对照 [coss UI](https://coss.com/ui) 的组件目录，沿用项目现有 Base UI 依赖和主题，不初始化第二套组件库。

## 选型

| 交互 | 项目组件 | 使用原则 |
| --- | --- | --- |
| 右键菜单 | `components/ui/context-menu.tsx` | 普通 React 元素使用 Trigger；编辑器等委托事件使用统一适配器，不各自实现外点关闭和键盘导航。 |
| 按钮菜单 | `components/ui/dropdown-menu.tsx` | 操作项、禁用、子菜单交由原语管理。 |
| 自由输入并提供建议 | `components/ui/autocomplete.tsx` | Provider Header 名称已接入；允许非预设值，不误用受限 Select。 |
| 有限选项 / 可搜索有限选项 | `SettingsSelect` / `SettingsCombobox` | 已基于 Base UI，复用现有组件。 |
| 点击展开的内容 | `components/ui/popover.tsx` | Portal、定位、碰撞避让、关闭由原语负责；支持 editor DOM anchor。 |
| 悬停或聚焦的详细预览 | `components/ui/preview-card.tsx` | 任务进度、桌面楼层预览、commit chip 详情已接入。 |
| 短提示 | `components/ui/tooltip.tsx` | 不用 CSS hover 拼装可交互详情。 |
| 模态表单 / 危险确认 | `dialog.tsx` / `alert-dialog.tsx` | 复用焦点与层级管理；轻量确认复用 `confirm-action-popover.tsx`。 |
| 数值 / 开关 / 多选 / 单选 | `number-input.tsx` / `switch.tsx` / `checkbox.tsx` / `radio-group.tsx` | 已有标准原语，业务页只负责值和校验。 |
| 分页签 / 切换组 / 滚动容器 | `tabs.tsx` / `toggle-group.tsx` / `scroll-area.tsx` | 使用现有封装，虚拟列表、终端滚动需要保留其专用布局。 |
| 通知 | `toast.tsx` / `toaster.tsx` | 统一生命周期和操作入口，不在业务页另写定时通知容器。 |

## 本次收敛

- Provider Header：删除手工建议列表状态、坐标测量、Portal 和键盘导航，改用 Autocomplete。
- `@` 建议：删除 resize / scroll / ResizeObserver 驱动的定位计算，改用 Popover；保留编辑器自身的建议筛选与键盘输入。
- commit 详情：删除 viewport clamp、尺寸测量与手工 Portal，改用 Preview Card 的 DOM anchor。
- 任务进度：删除绝对定位 + CSS hover 控制面板，改用 Preview Card。
- 楼层导航：桌面预览改用 Preview Card；触屏列表改用 Popover，删除手写外点关闭与预览延迟关闭逻辑。
- 浮层共用 `menu-surface.ts`：统一圆角、边框、轻阴影；尺寸和内容间距留给业务。
- 删除已不再使用的 `mentionPopupLayout.ts` 和旧坐标算法测试，以真实 React DOM 交互测试替代。

## 不应机械删除的 DOM 操作

`useEffect` 或 `window` 本身不是替换依据。编辑器选区、命令式 contenteditable chip 的事件桥接、图片缩放、终端尺寸、虚拟列表、拖拽排序、业务快捷键以及聊天滚动显隐仍有实际用途。区分业务 / 平台适配与标准交互：前者保留，后者优先交给组件原语。不要为了消除 API 名称把必要逻辑藏到另一层 hook。

原生表单控件、静态分隔线、业务进度图形无需为了覆盖组件目录而强行替换。新场景出现时，先检查上述封装，再按 coss / Base UI 组合扩展，避免增加平行实现。

## 验证入口

- `crates/agent-gui/test/chat/standard-overlays.test.mjs`：真实 React DOM 下的自动完成、自由输入、焦点保留、Escape、Portal、楼层收藏 / 跳转 / 触屏关闭。
- `crates/agent-gui/test/chat/task-progress-indicator.test.mjs`：任务内容、状态、无障碍摘要与长文本。
- `crates/agent-gui/test/input-context-menu/standard-context-menu.test.mjs`：标准菜单与编辑器桥接回归。
- UI / GUI / WebUI 三端类型检查。DOM 测试不替代真实窗口的视觉验收。
