# UI 样式变量

这一步只集中管理现有样式值，不重新设计界面。桌面 GUI 和 Gateway WebUI
都通过共享 `base.css` 引入 `crates/agent-ui/src/styles/tokens.css`。

## Tailwind v4 用法

使用 CSS 中的 `@theme` 注册工具类，不使用 `tailwind.config.js`。
两端入口用 `@plugin` 加载 typography，用 `@source` 声明依赖包的扫描范围，
用 `@custom-variant dark` 保留原来的暗色选择器。

```css
@theme {
  --spacing: 0.25rem;
  --spacing-18px: 18px;
  --text-14px: 14px;
}
```

```tsx
<div className="py-2 gap-3 text-xs">标准 Tailwind 尺度</div>
<div className="py-1px h-18px text-14px">保留原来的特殊尺寸</div>
```

宽高值和变体前缀完全相同时使用 `size-*`，例如 `h-4 w-4` 合并为 `size-4`，
`web:max-820:h-32px web:max-820:w-32px` 合并为 `web:max-820:size-32px`。
不同断点、状态或条件分支下的宽高不能跨条件合并。

`py-2` 等标准工具类继续通过 `--spacing` 管理；已有的 Tailwind 默认色板、
字号和其他尺度直接使用 Tailwind 提供的变量。特殊值才新增代号，
例如 `text-11p5px` 对应 `11.5px`，不把不同值近似成同一档。
像素字号没有附加默认行高，以保留原来 `text-[14px]` 的行为。

原本随区域字号缩放的文本使用 `text-scaled-14px`。这类表达式在
`@theme inline` 中引用 `--zone-font-scale`，在实际元素上计算，保留弹窗和
聊天区域的字号设置。安全区、转录宽度、弹窗尺寸也采用具名表达式。

普通 CSS 和内联样式可以引用同一组变量，例如 `var(--spacing-18px)`。
颜色、阴影、圆角、行高和动画时长保留原数值；亮暗主题的原始颜色通道也在
共享文件中。既有语义颜色映射通过 `@reference` 引入 `semantic-colors.css`，保持旧配置
只展开映射、不额外导出颜色变量的行为。

响应式条件、比例、零值、SVG 路径及运行时测量和布局计算保持原样。
`@media` 条件不能直接使用 CSS 自定义属性。此次不改交互逻辑或组件结构。

新增尺寸类时同步检查 `cn()` 的类名合并：字号不能被识别成颜色，阴影大小
不能被识别成阴影颜色。`style-theme.test.mjs` 覆盖 CSS 编译和这些覆盖关系。

## 单处使用的样式

仅在一个标签消费的布局、字号、颜色和动画类，直接写成该标签的 Tailwind
工具类。保留数值和原有条件，例如 `text-14px`、`animate-mention-popup-enter`
和 `motion-reduce:animate-none!`。动画变量与关键帧统一在 `animations.css` 管理；阴影、网格等表达式继续在
`tokens.css` 的 `@theme inline` 中集中管理。

共享组件里的 `web:` 只匹配 Gateway 的 HTML 标记，`desktop:` 匹配桌面环境。
`max-820:` 等变体保留原 CSS 的 `max-width: 820px`（包括边界），按断点从大到小
注册；它们不替换已有的标准 Tailwind 响应式类。

迁移时检查 CSS 层叠：原来未分层的规则可能覆盖组件工具类，改写后需保留同样
的优先级。少数 `!` 用于继续覆盖仍存在的全局按钮样式或共享组件默认样式。
多处消费的视觉类先评估是否适合组件变体：相同标签和职责可合并；仅共享动画、
标签与交互不同的节点直接复用具名动画工具类。脚本定位类、第三方生成内容、
跨元素规则和复杂绘制可继续保留 CSS。

## 等价值和非 CSS 调用方

动画时长只使用毫秒 token，例如 `--ui-duration-120ms`；`0.12s` 和 `120ms`
不再分别维护。完全相同的颜色原语共用一个值，阴影、渐变和 API 调色板引用它。
不同语义角色仍可以有名称，但值通过引用共用原语；不把相近颜色或 px/rem 近似合并。

动画曲线通过 `--ease-*` 管理，标签使用 `ease-ui-enter` 等具名类。
Web Animations 的 `easing` 和 xterm 的颜色解析器不接受 CSS 变量表达式，
调用前必须通过 `getComputedStyle` 取得实际值。终端透明边线保留八位十六进制值。

`touch-primary:` 保留原来的 `(hover: none), (pointer: coarse)` 条件；
它与 `no-hover:` 的 `any-hover: none` 含义不同，分别服务原有的触屏行为。

## Common CSS 加载组件（2026-09-10）

- `Skeleton` 的 `shimmer` / `pulse` 变体分别沿用原闪光和脉冲效果。
- `LoadingSurface` 的 `hero` / `skeleton` 变体集中加载容器的边框、渐变和伪元素；
  `LoadingTrack` 与 `FrostSpinner` 复用进度装饰及十二段旋转指示器。
- 组件仍输出原来的 div/span/i；调用方保留尺寸、子元素和业务属性。加载组件不接管
  请求、可见性、状态切换或事件。`className` 经 `cn` 合并，渐变与背景色分别处理。
- 动画表达式和关键帧统一在 `animations.css` 管理，通过 `@theme inline` 的
  `--animate-*` 暴露工具类。
  隐藏文档状态、减少动态效果、脉冲延迟及退出动画继续按原条件生效。
- 原 CSS 的直接 HSL alpha 颜色使用 `--color-hsl-*` 精确映射，不能机械替换成
  `/透明度` 工具类：当前 Tailwind 输出的 Oklab 混色表达式与原 HSL 表达式不同。
  标准 Tailwind 类仍正常使用；这里只保留被迁移规则原本的色彩计算方式。

## 动画统一入口

`crates/agent-ui/src/styles/animations.css` 集中维护两端的 `--animate-*` 与
`@keyframes`，由共享 `base.css` 在 `tokens.css` 后导入。组件继续使用
`animate-hub-panel-enter` 等具名类，时长和曲线继续引用 `tokens.css` 的原语。

关键帧保留原来的层级（包括 `@theme inline`、`@layer base/components` 和未分层定义），
不因集中存放而统一曲线、时长、位移或延迟。相似效果只有参数完全一致时才考虑合并。
`data-state`、减少动态效果、隐藏文档和跨元素状态选择器属于消费条件，仍放在原标签
或对应样式规则中。今后新增动画定义进入此文件，不再散落到各页面 CSS。

## 组件复用与防回退（2026-09-10）

- 筛选页签使用 `TabsList variant="filter"`，计数徽标使用 `Badge size="filter-count"`。
  Trigger 的现有密度、选中态和轮廓差异仍由调用方保留。
- `EmptyState` 的 `workspace` / `settings` 只负责原有空态布局；`StepMarker` 与
  `ChoiceCard` 只复用原 div/button 的样式。文案、请求状态、选择逻辑和事件仍归页面。
- 确认弹层和标签 Tooltip 共用 `animations.css` 的状态规则，通过各自的距离、进入和
  退出时长参数保留差异。检查变量引用时也要覆盖关键帧、脚本和跨端消费。
- 阴影、背景图、drop-shadow 的 Tailwind 合并名称登记在
  `style-token-names.generated.json`，由共享 UI 的契约测试核对其与 `tokens.css` 一致。
  `cn()` 直接消费登记表，避免用组件名称前缀猜测工具类类型。

## 设置与配置表单组合

共享设置、模型配置和 MCP 表单优先复用
`components/settings/FormField.tsx`：

- `FormField` 只输出一个 div；默认沿用 `space-y-2`，`density="compact"`
  沿用 `space-y-1.5`。列跨度、外边距等页面布局仍由调用方提供。
- `FormFieldLabel` 复用现有 `Label`；默认保留 muted 文字，`size="compact"`
  保留小号文字。`htmlFor`、ref 和其他原生属性继续透传。
- `FormFieldDescription` 沿用 p 标签及 `text-xs leading-5 text-muted-foreground`。
  其他行高、颜色或错误提示没有强行并成这一档。
- 标签、控件、说明通过 children 组合；ID、`aria-describedby`、校验、受控值、事件、
  加载和保存状态继续由业务组件管理，不自动生成关联或额外 DOM。
- `SettingsSurface` 集中普通设置分组与 CUA 步骤卡片相同的表面样式。
  `shadow-settings-surface` 沿用原阴影数值；不同表面的阴影不近似合并。

现有 `SettingsRow`、`SettingsChoiceRow`、`DialogActions` 和基础输入控件继续复用。
不要仅因其他结构也使用相同间距，就把工具栏、标签操作行或整个页面套进 FormField。
