# LiveAgent DESIGN.md

本文件是 LiveAgent 界面设计与前端编码规范的唯一正文，适用于桌面 GUI、Gateway WebUI 和两者共享的 `agent-ui`。贡献者和 AI 编程 Agent 改界面前先读这里。

写法参考 Vercel 的 [design.md 实践](https://vercel.com/blog/how-our-agents-build-on-brand-pages-with-design-md)，规则分三层存放：

- **判断**写在本文件，例如层级怎么排、什么时候不加装饰。
- **机制**写进 token 和共享组件，例如颜色、圆角、字号、弹层行为。调用方直接用名字，不重新发明。
- **能机器判定的**写进检查脚本和测试，例如禁止的导入、禁止的层级写法。

每条规则都要能观察和验证。“看起来干净一点”不算规则，“选中态只改背景和边框，不加投影”才算。

## 1. 范围与优先级

| 范围 | 路径 |
| --- | --- |
| 共享应用 UI（页面、组件、样式、i18n） | `crates/agent-ui/src/` |
| 桌面 GUI 前端 | `crates/agent-gui/src/` |
| Gateway WebUI | `crates/agent-gateway/web/src/` |

出现冲突时按下面顺序取舍：

1. 自动检查和 CI（`.github/workflows/ci.yml`）的结果。
2. 本文件。
3. 源码中共享组件的现有实现。
4. `docs/` 下的专项设计文档。

贡献流程（Issue、PR、截图要求）见 [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md)。架构说明见 [docs/README.md](docs/README.md)。

## 2. 产品定位与界面基调

LiveAgent 是本地优先的 AI Agent 桌面客户端，用户会长时间用它读对话、看工具输出、审 diff、调设置，所以界面按下面几点设计：

- **内容优先**。对话、代码、diff 是主角，外框、卡片、阴影都退后。拿不准时就少加一层装饰。
- **信息密度偏高但可扫读**。紧凑间距可以用，但同类元素对齐、字号档位一致。
- **两端一致**。GUI 和 WebUI 共用一套页面，差异只在宿主能力上（标题栏、文件系统、设备管理），视觉上不应该看出是两个产品。
- **亮暗主题、中英文、宽窄屏都必须支持**。任何改动都要在这几种组合下检查。
- **可访问**。键盘能操作，焦点可见，尊重 `prefers-reduced-motion`。

## 3. 架构边界

`agent-ui` 是共享应用 UI 源码，不只是基础组件库。详细说明见 [crates/agent-ui/README.md](crates/agent-ui/README.md)。

- 公共页面、组件和逻辑在 `agent-ui` 中只保留一份。不要把整页复制到 GUI 或 WebUI 再小改。
- 宿主差异放进各自的 `src/agent-ui-adapters/`，共享层通过 `@liveagent/adapters` 调用；应用业务类型通过构建期别名 `@liveagent/app` 读取。
- 共享层和 WebUI 都不能直接导入 `@tauri-apps/*`。WebUI 不能依赖桌面源码，GUI 也不能依赖 WebUI 源码。
- `@base-ui/react` 只能在 `crates/agent-ui/src/components/ui/` 中直接导入，业务代码使用封装好的原语。
- 应用独有功能（GUI 的全局快捷键、关于页；WebUI 的设备管理、网关连接状态）放在对应应用目录，通过扩展注册表或适配器接入。

以上边界由 `pnpm check:ui-boundaries` 强制检查。

## 4. Token 词汇表

所有样式值都从共享样式文件取：

| 文件 | 内容 |
| --- | --- |
| `crates/agent-ui/src/styles/tokens.css` | 主题原始值、Tailwind v4 `@theme`、自定义 variant |
| `crates/agent-ui/src/styles/semantic-colors.css` | 语义颜色到 Tailwind 颜色的映射 |
| `crates/agent-ui/src/styles/animations.css` | 全部 `--animate-*` 与 `@keyframes` |
| `crates/agent-ui/src/styles/base.css` | 两端共同入口，依次引入 `tokens.css` 和 `animations.css`；两端 `index.css` 通过 `@reference` 引入 `semantic-colors.css` |

项目使用 Tailwind v4 的 CSS 配置（`@theme`），没有 `tailwind.config.js`。

### 4.1 颜色

只用语义角色，亮暗取值由主题负责：

| 角色 | 工具类示例 | 用途 |
| --- | --- | --- |
| `background` / `foreground` | `bg-background` `text-foreground` | 页面底色与正文 |
| `muted` / `muted-foreground` | `text-muted-foreground` | 次要文字、弱背景 |
| `primary` / `secondary` / `accent` | `bg-primary` `hover:bg-accent` | 主操作、次操作、悬停与选中 |
| `card` / `popover` | `bg-popover` | 卡片与浮层表面 |
| `border` / `input` / `ring` | `border-border` `ring-ring` | 边框、输入框边框、焦点环 |
| `destructive` | `text-destructive` | 错误反馈与危险操作 |
| `success` | `text-success` | 成功状态 |
| `settings-*`、`control-surface`、`segmented-*` | `bg-settings-tile` | 设置页中性层级与分段控件 |
| `sidebar`、`chip`、`chat-*` | `bg-sidebar` | 侧栏、胶囊按钮、聊天气泡 |

注意两种写法不能混用：`--success`、`--destructive` 是完整颜色值，用 `var(--success)`；其余旧角色存的是 HSL 通道，要写 `hsl(var(--border))`。在 Tailwind 类里直接用 `bg-success` 之类即可，不用关心这个差别。

新增颜色时：

- 先找现有语义角色。分类和装饰用 Tailwind 标准色阶（`emerald-600` 等）。
- 黑白透明用 `white/8`、`black/20`；需要精确非整数透明度时写 `white/[0.055]`。
- 阴影、渐变里用 `color-mix(in oklab, var(--color-black) 20%, transparent)`。
- 不要新增按数值命名的颜色变量，比如 `--ui-color-1d4ed8`。`tokens.css` 里现存的这类变量属于历史遗留，只减不增。

### 4.2 字号与字体

| 档位 | 用途 |
| --- | --- |
| `text-tiny`（0.625rem） | 仅限紧凑徽标、计数、键帽 |
| `text-xs` / `text-sm` | 辅助说明 / 界面默认正文 |
| `text-base` 到 `text-5xl` | 标题与强调 |

- 只用上表的 rem 档位，不写 `text-[13px]`，也不写半像素字号。
- 字重用 `font-medium`、`font-semibold` 等标准名称。
- 字体族用 `--app-font-family`、`--chat-font-family`、`--code-font-family`。`font-mono` 跟随用户设置的代码字体。
- 局部区域通过 `--zone-font-scale` 整体缩放，不要单独换字号。

### 4.3 间距、尺寸、圆角

- 间距和尺寸用标准刻度（`--spacing: 0.25rem`），如 `px-2`、`gap-3`、`h-9`。宽高相等时写 `size-*`。
- 少量既有的像素特殊值用具名工具类，例如 `h-18px`，来源是 `tokens.css` 中的 `--spacing-*px`；新代码优先用标准刻度。
- 圆角用 `rounded-xs` 到 `rounded-4xl`，它们都从 `--radius`（0.625rem）派生。禁止写 `rounded-[6px]`。

### 4.4 层级

用 `--layer-*` 语义层级：`content`、`raised`、`panel`、`popover`、`modal`、`toast`、`critical`。禁止写 `z-[9999]`。

### 4.5 动效

- 新动画的 `--animate-*` 和 `@keyframes` 只加在 `animations.css`，组件里用具名类，如 `animate-hub-loading-progress`。
- 时长用毫秒 token，如 `--ui-duration-120ms`；曲线用 `--ease-*`，如 `ease-ui-enter`。不要写 `0.12s`。
- 非必要的动画都要提供降级，写 `motion-reduce:animate-none` 或在 CSS 中加 `prefers-reduced-motion` 条件。
- Web Animations 的 `easing` 和 xterm 颜色不接受 CSS 变量，调用前用 `getComputedStyle` 取实际值。

### 4.6 自定义 variant

| Variant | 含义 |
| --- | --- |
| `desktop:` / `web:` | 只在桌面端 / 只在 Gateway WebUI 生效 |
| `max-1080:` `max-820:` `max-640:` `max-520:` `max-480:` `max-380:` | 包含边界的 `max-width` 断点 |
| `has-hover:` / `no-hover:` | `any-hover: hover` / `any-hover: none` |
| `touch-primary:` | 以触屏为主（`hover: none` 或 `pointer: coarse`），和 `no-hover:` 不是一回事 |

## 5. 组件选型

先用 `crates/agent-ui/src/components/ui/` 里的原语，确实不够用再评估扩展。不要并行写第二套实现。

| 交互 | 组件 | 说明 |
| --- | --- | --- |
| 按钮 | `button.tsx` | `variant`: default / secondary / destructive / outline / ghost / link；`size`: default / sm / lg / icon / icon-sm / icon-xs。图标按钮用 `size="icon-*"`，不要自己写 `h-8 w-8` |
| 文本输入 | `input.tsx` / `textarea.tsx` / `number-input.tsx` | 公共样式由 `text-field-styles.ts` 维护 |
| 开关 / 多选 / 单选 | `switch.tsx` / `checkbox.tsx` / `radio-group.tsx` | |
| 有限选项 | `select.tsx` / `combobox.tsx`；设置页用 `SettingsSelect` / `SettingsCombobox` | |
| 自由输入加建议 | `autocomplete.tsx` | 允许输入预设之外的值 |
| 命令面板 / 搜索 | `command.tsx` | |
| 按钮菜单 / 右键菜单 | `dropdown-menu.tsx` / `context-menu.tsx` | 调用方只写宽高、滚动、截断等布局 |
| 点击展开 / 悬停预览 / 短提示 | `popover.tsx` / `preview-card.tsx` / `tooltip.tsx` | 定位、避让、关闭都交给原语 |
| 模态 / 危险确认 / 轻确认 | `dialog.tsx` / `alert-dialog.tsx` / `confirm-action-popover.tsx` | 侧滑面板用 `sheet.tsx` |
| 页签 / 切换组 | `tabs.tsx`（`variant`: default / plain / segmented / filter）/ `toggle-group.tsx` | 筛选页签用 `TabsList variant="filter"` |
| 徽标 | `badge.tsx` | 紧凑状态用 `size="compact"` 配合 success / destructive / muted；计数用 `size="filter-count"` |
| 空状态 | `empty-state.tsx` | `variant`: workspace / settings；`size="compact"` |
| 加载 | `skeleton.tsx` | `variant`: shimmer / pulse |
| 通知 | `toast-manager.ts` 的 `toast.*`，配合根级 `Toaster` | 页面不自己维护通知数组和计时器 |
| 复制 | `copy-button.tsx`；剪贴板逻辑在 `lib/shared/clipboard.ts` | |
| 滚动 / 分栏 / 分隔 | `scroll-area.tsx` / `resizable.tsx` / `separator.tsx` | |
| 浮层表面 | `menu-surface.ts` 的 `floatingSurfaceClassName` | 统一圆角、边框、轻阴影 |

设置页组合件放在 `crates/agent-ui/src/components/settings/`：`FormField`（含 `FormFieldLabel` / `FormFieldDescription`）、`SettingsSurface`、`SettingsPanel`、`SettingsNotice`、`ChoiceCard`、`StepMarker`、`SettingsCopyButton`、`SettingsToggleGroup`。

不需要强行替换成组件的情况：原生文件选择、内嵌搜索之类的原生 `input`，静态分隔线，业务进度图形，以及编辑器选区、终端尺寸、虚拟列表、拖拽排序中必要的 DOM 操作。

## 6. 可观察的设计规则

- **焦点**：只用 `focus-visible:` 显示焦点环，鼠标点击后不出现焦点环。
- **选中态**：用背景色和边框表达，不再叠加 `ring` 或投影。
- **阴影**：只给浮层（菜单、弹窗、Toast）使用。普通卡片、列表项、悬停态默认不加阴影。
- **边框**：一个元素只有一种外框，`border` 和 `ring` 不同时出现。
- **危险操作和错误**：统一用 `destructive`；成功统一用 `success`。不另调红色、绿色。
- **禁用态**：用组件自带的 `disabled:opacity-50`，不在单处另定透明度。
- **加载**：首屏如果已有缓存数据，直接显示，不先闪加载态；骨架屏保持最终布局的位置，避免内容跳动。
- **浮层**：定位、外点关闭、Escape、焦点回收都交给原语处理。
- **文案**：所有用户可见文字都走 i18n，zh-CN 和 en-US 两份同时写。
- **窄屏**：380px 宽度下不出现横向滚动，主要操作仍可点击。

## 7. 有名字的反模式

评审时直接用下面的名字指出问题。

| 名字 | 怎么认出来 | 改成什么 |
| --- | --- | --- |
| 装饰投影 | 普通卡片、悬停、选中态带 `shadow-*` | 去掉阴影，用背景或边框表达状态 |
| 双层外框 | `focus:ring` 或选中 `ring` 叠在已有 `border` 上 | 改用 `focus-visible:`，选中态只用边框 |
| 魔法层级 | `z-[数字]` | 换成 `--layer-*` 对应的层级 |
| 野圆角 | `rounded-[6px]` | 换成 `rounded-sm`、`rounded-md` 等标准档位 |
| 半像素字号 | `text-[13px]`、`text-[11.5px]` | 换成第 4.2 节的档位 |
| 数值色名 | 新增 `--ui-color-xxxxxx` 或硬编码 HEX | 换成语义角色或 Tailwind 色阶 |
| 手写浮层 | 自己算坐标、监听 resize/scroll、手写外点关闭 | 换成 `popover`、`preview-card`、`dropdown-menu` |
| 手写弹窗 | `role="dialog"`、自写遮罩、计时器控制退场 | 换成 `dialog` / `alert-dialog` / `sheet` |
| 页面级通知 | 页面里维护通知数组和 `setTimeout` | 换成 `toast.*` |
| 复制整页 | GUI 和 WebUI 各有一份几乎相同的页面 | 收回 `agent-ui`，差异放进适配器 |
| 散落关键帧 | 页面 CSS 里写 `@keyframes` | 移到 `animations.css` |
| 秒数时长 | `duration-[0.2s]`、`transition: 0.12s` | 换成 `--ui-duration-*ms` |
| 硬编码文案 | JSX 里直接写中文或英文字符串 | 改用 `t("...")` |
| 自造按钮尺寸 | `<Button className="h-8 w-8">` | 用 `size="icon-sm"` |

## 8. 编码规范

- **格式与 lint**：Biome（`biome.json`）。2 空格缩进，行宽 100，双引号，保留分号，尾随逗号 `all`；未使用的导入算错误；导入顺序由 Biome assist 整理。
- **包管理**：只用 `pnpm`，不要用 npm 生成或更新 lockfile。
- **类名合并**：用 `lib/shared/utils.ts` 的 `cn()`。调用方同时覆盖字号和行高时一起传入，例如 `text-xs leading-none`。新增阴影、背景图等具名工具类时，同步登记到 `lib/shared/style-token-names.generated.json`。
- **样式位置**：只在一处使用的样式直接写 Tailwind 类；多处共用同一职责的，做成组件变体（`cva`）；跨元素规则、第三方生成内容、复杂绘制可以留在 CSS。
- **组件**：业务组件只负责数据、状态和事件，外观交给原语。原语的 `className` 只接收布局类参数（宽高、间距、截断），不覆盖颜色、圆角、阴影。
- **i18n**：通过 `useLocale()` 拿到 `t`，翻译放在 `crates/agent-ui/src/i18n/translations/`，zh-CN 和 en-US 文件成对修改。
- **生成代码不手改**：`catalog.generated.ts`、protobuf 生成代码、`*.generated.json` 都通过对应命令重新生成。
- **注释与文档**：跟随所在文件的语言，改代码时同步更新相关注释。

## 9. 修正放在哪一层

评审中同一个问题反复出现时，把修正放到最窄、又能稳定生效的位置：

| 问题类型 | 放在哪里 | 例子 |
| --- | --- | --- |
| 需要判断的取舍 | 本文件第 6、7 节 | 普通卡片不加投影 |
| 可复用的外观机制 | token 或共享组件变体 | `Badge size="compact"` |
| 能用代码判定的 | `scripts/check-ui-boundaries.mjs` 或测试 | 禁止 `z-[数字]` |
| 只在一处出现的 | 就地修复，不写成规则 | |

一个问题只出现一次，先不写进规则；第二次出现时再考虑写进来。能写成检查的，不要只写成文字。

## 10. 提交前自检

按改动范围运行（完整命令见 [docs/operations/development.md](docs/operations/development.md)）：

```bash
pnpm lint                  # Biome，三处前端源码
pnpm check:ui-boundaries   # 架构边界与样式禁用写法
pnpm typecheck:ui && pnpm typecheck:gui && pnpm typecheck:webui
pnpm test:gui && pnpm test:webui
git diff --check
pnpm check:fast            # 一次跑完上面大部分项目
```

UI 改动的 PR 需要附截图或录屏，至少覆盖：

- 亮色和暗色主题；
- 宽屏（约 1600px）和窄屏（约 380px），只影响桌面端的改动可以省略窄屏；
- 涉及 GUI 和 WebUI 共享页面时，两端各一张。

最好提供修改前后的对比图。

## 11. 维护本文件

- 本文件和代码一起演进。改了 token、原语或检查脚本，就同步更新对应章节。
- 新规则必须能观察；写不出“怎么认出来”和“改成什么”的规则不收。
- 评审中反复出现的意见（PR 评论、Issue、截图反馈）按第 9 节决定放在哪一层，写进本文件的部分在 PR 里说明来源。
- 临时迁移记录和排查过程不写进本文件，放在 `docs/worklog/` 等位置；其中需要长期保留的结论，再提炼到这里。
