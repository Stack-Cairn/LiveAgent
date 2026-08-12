# `@liveagent/ui`

`agent-ui` 是 GUI 与 WebUI 共用的应用 UI 源码，不是只存放基础组件的组件库。

## 目录职责

- `src/application/`：共享应用视图和页面路由框架。
- `src/pages/`：设置、Skills、MCP 等完整公共页面。
- `src/components/`：聊天侧栏、输入框、项目工具、编辑器等公共 UI。
- `src/contracts/`：定义共享 UI 的扩展注册表等公共契约。
- `src/i18n/`：定义两端共同使用的翻译片段与本地化上下文。

GUI 与 WebUI 应用只负责：

- 启动和挂载 React 应用；
- 准备业务状态、协议数据和回调；
- 在各自 `src/agent-ui-adapters/` 中实现共享 UI 需要的能力；
- 注册仅该应用拥有的页面或功能。

`ApplicationView` 直接创建 Skills Hub、MCP Hub 和聊天顶部栏。GUI/WebUI 不能再次导入并组装这些公共页面，只向它提供设置、模型状态、事件回调，以及协议相关的聊天内容控制器。这样公共应用结构的修改只发生在 `agent-ui`，不会在两个入口各维护一份 JSX。

## `@liveagent/app`

`@liveagent/app` 不是 npm 包，因此不会出现在 `package.json` 的依赖列表中。它是构建期别名：

- GUI 将它映射到 `crates/agent-gui/src`；
- WebUI 将它映射到 `crates/agent-gateway/web/src`。

共享 UI 通过这个别名读取当前应用的业务类型和通用实现。GUI 构建时指向 GUI，WebUI 构建时指向 WebUI。

## `@liveagent/adapters`

`@liveagent/adapters` 专门指向当前应用的 `src/agent-ui-adapters/`，用于目录选择、剪贴板、标题栏和 SSH 客户端等差异实现。公共 UI 不直接导入 Tauri 或 Gateway 的具体实现。

## 独有功能

应用独有功能放在对应应用目录，并通过扩展注册表或适配器接入共享页面。例如：

- GUI：全局快捷键、关于页、桌面标题栏、原生剪贴板；
- WebUI：设备管理、浏览器文件能力、网关连接状态。

供应商设置、聊天侧栏、聊天顶部栏、空会话页、工具参数、待办列表、助手状态、上下文检查点、重试详情、上下文用量、联网搜索组和 Diff 视图等公共 UI 同样只在 `agent-ui` 保留一份；GUI 的 CC Switch/Cherry Studio 导入由
`src/agent-ui-adapters/providerSettings.tsx` 注入，WebUI 使用同名空适配器。聊天侧栏的桌面标题栏、
应用更新按钮和系统文件管理器入口由 GUI 的 `src/agent-ui-adapters/sidebarChrome.tsx` 注入。
助手头像资源由两端的 `src/agent-ui-adapters/assistantAvatar.ts` 提供，共享组件不感知 Tauri 资源路径或 Web 公共目录。

不要在应用目录复制一份完整公共页面再做少量修改；应把差异收敛为 `agent-ui-adapters/*` 或独有功能组件。
