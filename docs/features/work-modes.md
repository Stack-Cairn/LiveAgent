# 工作模式（编程 / 写作 / 设计）

侧边栏头部的一键切换器：logo 右侧原「Live Agent」品牌文字位置改为三段式模式切换（编程 / 写作 / 设计），快捷键 `Ctrl/⌘+Alt+1/2/3`。

## 架构

| 层 | 路径 | 职责 |
|---|---|---|
| 模式定义 | `src/lib/settings/workModes.ts`（GUI/WebUI 字节级镜像） | 纯数据 + 纯函数：模式 id、i18n key、模式提示词、工具裁剪面、空态建议卡片。 |
| 设置域 | `settings.customSettings.workMode` | `{ activeModeId, modelByMode }`；随 customSettings 走网关同步，双端一致。 |
| 切换助手 | `lib/settings/index.ts` 的 `setActiveWorkMode` / `setSelectedModel` | 离开模式前把当前全局模型记到该模式名下，进入时恢复目标模式记住的模型；用户手动换模型实时写入当前模式记忆。 |
| 切换器 UI | 两端 `ChatHistorySidebar.tsx` 头部 | 磨砂分段控件（复用 Hub 页签视觉语言），激活段带模式色圆点，悬停提示说明该模式改变了什么。 |
| 运行时注入 | `ChatPage` 的 `activeAgentPrompt` | 模式提示词追加在系统提示词后、用户全局提示词模板前（用户模板可覆盖模式约定）。 |
| 工具裁剪 | `builtinRegistry.ts` 的 `excludedToolNames` | 写作模式下线 `Bash` / `ManagedProcess` / `ReadTerminal`（含子代理注册表）；cron 等非 chat 作用域不受影响。 |
| 内容适配 | 两端 `ChatEmptyState` / composer placeholder | 每模式各自的问候语、三张建议卡片、logo 光晕色与输入框占位符。 |

## 三个模式

| | 编程 coding | 写作 writing | 设计 design |
|---|---|---|---|
| 模式提示词 | 无（默认行为即工程向，存量用户零变化） | 写作工作流：先大纲后成稿、保留作者语气、禁止虚构引用 | 设计产出：缺目标/风格先澄清，偏好 Mermaid、单文件 HTML/SVG 原型、HEX 配色表 |
| 工具面 | 全量 | 裁剪终端类（Bash/ManagedProcess/ReadTerminal） | 全量 |
| 模型记忆 | `modelByMode.coding` | `modelByMode.writing` | `modelByMode.design` |

## 同步与持久化

- 桌面端：`workMode` 随 `customSettings` 存 localStorage（`LocalUiSettings`），启动时经 `publishGatewaySettingsSync` 发布；
- WebUI：切换模式经 settings sync 回写桌面端——对话在桌面端运行，模式必须落到桌面端才对下一轮生效；
- Rust 端零改动：`customSettings` 已在 `UI_ONLY_SETTINGS_SYNC_FIELDS` 缓存覆盖名单内。
