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
