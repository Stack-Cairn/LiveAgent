# UI 颜色规范与渐进迁移

## 当前约定：沿用 shadcn 语义变量模式

参考 Crisp3D 的主题组织方式，颜色值在 `tokens.css` 的 `:root/.dark` 中定义，
通过 `semantic-colors.css` 的 `@theme inline` 映射给 Tailwind。
组件使用用途名称，透明度由共享组件变体管理。例如：

```css
:root {
  --destructive: var(--color-red-700);
  --destructive-foreground: var(--color-white);
  --success: var(--color-emerald-800);
  --success-foreground: var(--color-white);
}
.dark {
  --destructive: var(--color-red-300);
  --destructive-foreground: var(--color-red-950);
  --success: var(--color-emerald-300);
  --success-foreground: var(--color-emerald-950);
}
@theme inline {
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
}
```

```tsx
// 浅底错误徽标：文字使用主色；透明度归 Badge variant 管理。
<Badge variant="destructive">失败</Badge>
// Badge 内部：border-destructive/25 bg-destructive/10 text-destructive

// 实心危险操作：foreground 是放在主色底上的文字颜色。
<Button variant="destructive">删除</Button>
// Button 内部：bg-destructive text-destructive-foreground hover:bg-destructive/90
```

`success` 是项目扩展；其余优先沿用 shadcn 的标准角色。`*-foreground` 表示放在
对应实心底色上的文字，不是所有场景通用的状态文字色。
本批移除了上一阶段的六个 `status-success/error-*` 变量；不为每种状态再定义
surface、border 和 foreground 三套独立色阶。

## 渐进兼容边界

- 本批只把 destructive/destructive-foreground 转成完整颜色值，并新增 success 配对。
- background、foreground、primary 等仍是旧 HSL 通道，映射仍保留 `hsl(var(...))`。
  后续逐组迁移，不能对所有变量一刀切去掉或添加 `hsl()`。
- destructive 的内联消费者已同步更新：ChatComposerBar 使用 `var(--destructive)`；
  Git diff 占位渐变的 alpha 使用 `color-mix`，避免对完整颜色再次包装 hsl。
- 引用 semantic-colors.css 的方式保持不变，仍用 @reference，不扩大发布的变量集合。
- Crisp3D 用户侧是暗色产品；LiveAgent 继续维护亮暗两套，不复制其品牌色和大面积底色。

## 范围与后续规则

2026-09-11 评估基线：269 个 ui-color 定义，至少 164 个带透明度；组件使用 15 个
Tailwind 色系。数量表示定义/引用种类，不代表独立视觉角色。

| 用途 | 规则 | 当前阶段 |
| --- | --- | --- |
| 错误、失败、危险操作 | destructive；红色 | 已合并状态提示与危险操作配色 |
| 成功、完成、启用 | success；emerald | 已接入现有成功 Badge |
| 警告、待处理 | 考虑 warning 配对；amber | 后续有真实消费者再加入 |
| 信息、链接 | 分别审查语义；sky 可作原语 | 后续评估 |
| 运行、思考 | 允许 violet 强调 | 不强制给中性运行提示染色 |
| 页面、卡片、弹层、边框、文字 | background/card/popover/muted 等标准语义 | 后续整组评估 |
| 分类、品牌、终端、代码高亮、图表 | 独立用途，允许明确例外 | 本批不改 |

已接入：MCP OAuth 状态、Skills 启用/导入成功等 Badge，ToolCallItem 错误标题/详情，
ToolApprovalBar 错误提示。已有 destructive 按钮、菜单及其他语义消费者随主题变量
一起变化，不能宣称只影响小徽标。Skills 的多彩分类标签不表示状态，本批不迁移。
状态判断、标签、DOM、交互、尺寸与显示条件保持原样。

## 当前批次视觉结果

对照基线为上一阶段状态颜色试点的工作区。使用实际 Badge variant 的类名，编译
共享主题和项目 dark 变体，浏览器测量实际文字与合成背景颜色。背景为当前主题
background。按钮样例覆盖现有 Button 的实心底/文字及 hover 颜色组合。

| 样例 | 亮色对比度：前 → 后 | 深色对比度：前 → 后 |
| --- | --- | --- |
| 成功徽标 | 6.90 → 6.48 | 10.41 → 9.79 |
| 错误徽标/错误详情 | 5.54 → 5.30 | 8.87 → 7.98 |
| 错误标题/审批错误 | 6.42 → 6.42 | 9.52 → 9.52 |
| 危险按钮默认 | 3.60 → 6.42 | 7.59 → 8.42 |
| 危险按钮 hover 配色 | 3.23 → 5.85 | 8.46 → 7.06 |

14 个样例均超过 4.5:1。浅底与边框因改为同一主色的 alpha 会有小幅变化；状态
文字色延续上一批。危险按钮变化更明显：亮色变深红白字，深色变浅红底深红字。
已查看完整亮暗对比图；这是局部样例验证，不代表所有嵌套背景、disabled、focus 或
业务页面已完成视觉验收，也不等同于整个应用的无障碍认证。

## 下一批

先观察本批语义颜色的整体效果，再评估 warning/info 和分散的状态消费者。
中性色必须按页面、侧栏、卡片、弹层、文字、边框的整体层次单独迁移，不能以小徽标
对比替代。最后处理装饰渐变、阴影和透明度档位，并按实际消费者删除旧 ui-color。

验证：双端生产构建（含 TypeScript）、GUI 3098 项与 Web 718 项测试、UI 边界、
本批源码 Biome 检查通过。旧 status-success/error 及 destructive 的 HSL 包装无残留。
本任务未执行暂存或提交。

## 仪表盘中性色试点（2026-09-11）

StatusDashboardPage、StatusPanel 和 StatusTypography 接入 foreground、muted-foreground、
background、card 和 border。仪表盘根节点保留固定深色作用域，在此覆盖标准语义变量，
不影响登录页和其他页面。移除六个旧 status 表面/文字别名；三个 TSX 文件内
`text-(--ui-color-*)` 的直接引用从 44 处、16 种降为 1 处、1 种。
这表示消费者收敛，尚未删除共享 ui-color 定义。

在线/离线徽标使用 success/destructive 及其透明度，圆点继承当前文字颜色。
雷达、分类色、光晕、网格与动画保留，避免把颜色规范化扩展成整页重新设计。
正文接近原色，辅助文字统一后更明亮；面板改用中性边框和 card 底色。

验证：Web 生产构建（含 TypeScript）、718 项测试、UI 边界和四个源码文件 Biome
检查通过。浏览器查看 1912×948 的前后对照；亮暗宿主下根节点的 background、
foreground、card、success 计算值一致。预览由实际页面和面板源码生成静态 HTML，
使用模拟在线数据、简化图标/按钮并禁用动画，没有验证真实事件流。
1440×900 静态预览未执行页面的响应式 effect，不能作为小屏布局验收。
本批保持未暂存、未提交。

## 迁移后的无消费者颜色清理（2026-09-11）

以仪表盘迁移后的工作区为基线，删除 23 个无消费者的 `--ui-color-*`，
定义数从 269 降至 246；同时删除无消费者的 `--color-rgba-233-245-255-0p84`
Tailwind 映射。类名合并注册表只维护阴影等分类，本批没有对应颜色注册项需要修改。

核查覆盖生产源码、测试、文档、CSS 间接引用及颜色工具类名称，检查动态变量访问
（包括终端的独立主题入口）。仍被阴影、渐变或其他映射引用的原语保留。
不改组件用色、不合并近似色，也不扩大到其他种类的无用 token 清理。

使用两端实际 CSS 入口和 Tailwind PostCSS 编译迁移前后样式：只排除这批删除的
声明并归一化空白后，双端编译结果完全一致。双端生产构建（含 TypeScript）、
UI 边界与 tokens.css 的 Biome 检查通过。本批未新增截图或重跑完整业务测试，
等效依据是消费者核查和编译 CSS 对比；现有 style-theme 的 3 项测试通过。
本批未执行暂存或提交命令；验证期间源码改动已由外部操作加入暂存区。

## Cron / Hooks 状态颜色（2026-09-11）

普通设置页正文和边框已基本采用语义变量，终端日志等固定配色区域保留。
本批改为收敛 Cron 已启用数量与圆点、调度错误和次数耗尽提示，以及 Hooks
已启用统计的文字、图标、边框和底色：分别使用 success / destructive，
保留原透明度档位、布局和显示条件。HTTP 类型、生命周期阶段、Cron 表达式
及剩余次数的信息色仍属于各自分类，没有统一替换所有绿色或红色。

亮色成功文字从 emerald-600 变为主题 success（emerald-800），深色从
emerald-400 变为 emerald-300；错误文字从 red-600/red-400 变为
red-700/red-300。边框及浅底跟随对应语义主色。以后调整状态主题无需再分别
修改两页的亮暗颜色组合，本批未新增全局变量。

验证：双端生产构建（含 TypeScript）、396 项设置测试、两份源码 Biome
和 UI 边界通过。浏览器查看三组状态在亮暗主题下的前后局部样例；样例使用
项目 Tailwind 编译和真实颜色类，未覆盖完整 Cron 执行或 Hook 触发流程。
React 差异检查确认只有颜色类及格式变化，没有修改状态、事件和 DOM 结构。
本批未执行暂存或提交。

## 黑白透明色与新增约束（2026-09-11）

以本批开始的工作区为基线，删除 57 个黑白透明原语和 12 个 Tailwind 颜色映射，
原始颜色定义从 246 降至 189。普通颜色类迁移至 black/white 加原透明度，
阴影、渐变、遮罩在完整表达式中引用标准黑白色；未合并透明度档位。
涉及共享 token/base、HubLoading、登录/同步加载、仪表盘，以及桌面快捷键图示
和聊天滚动按钮。终端精确透明黑保持不变，彩色原语本批保留。

两处仪表盘复合背景补充 image 类型提示，保持替换前 Tailwind 生成的属性类型。
验证使用实际双端入口编译，并对照删除声明、类名迁移、黑白 alpha 等值表达式
和编译器生成的 color-mix supports/fallback 分支；归一化后的声明集合无差异。
此对比不声称生成 CSS 字节或规则排列完全一致。浏览器验证 57 对颜色的 RGBA
输出，最大通道差为 1/255（量化误差），并查看全部色块对照；未执行完整页面业务验收。

新增 ui-color-policy 检查，接入 UI 边界命令；历史名称清单只减不增。
测试覆盖旧名称兼容、新名称拦截、注释/引用排除及内联 CSS。新增清单是迁移
约束，不是新的产品色板。

验证汇总：GUI 3099 项、Web 718 项前端测试、15 项脚本测试通过；
双端生产构建、UI 边界与九份改动源码 Biome 通过。五个阴影保留单行声明
并附格式化豁免，避免换行改变 Tailwind 对阴影颜色的识别；最终编译声明
对比已包含该处理。未执行暂存或提交命令，外部暂存操作保持原样。
