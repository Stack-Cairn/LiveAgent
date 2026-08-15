# 移动端 Android App 架构

`crates/agent-mobile` 是 Tauri 2 包裹的 Android 客户端。它不内置桌面 Agent 运行时，而是像浏览器 WebUI 一样作为 Gateway 客户端：前端通过 Gateway WebSocket 远程操作同一个本地 Agent 会话，Tauri 只提供原生外壳与 `opener` 插件，业务能力经 `shims/` 复用 Gateway 适配器。

## 定位

| 项 | 结论 |
|---|---|
| 执行真相源 | 仍在桌面 GUI/Tauri；移动端不本地执行工具，也不持有本地文件系统权限。 |
| 与 Gateway 的关系 | 与 WebUI 相同的 Gateway 客户端，走 `/ws/v2`（v2 WebSocket）与 `/api/*`。 |
| Tauri 角色 | 提供 Android WebView 外壳；Rust 端是极简模板（`greet` + `opener` 插件），不承载业务命令。 |
| 与桌面端的差异 | 复用 `@liveagent/ui` 共享 UI 与 `agent-ui-adapters`，但数据控制器、socket 客户端、shims 与 WebUI 对齐，而不是桌面端。 |

## 模块边界

| 模块 | 路径 | 职责 |
|---|---|---|
| React entry | `src/main.tsx` | 写入 WebUI 运行时标记（`GATEWAY_WEBUI_MARKER`），按 pathname 分派 GatewayApp / StatusDashboardPage / DevicesAdminPage。 |
| App shell | `src/App.tsx`、`src/app/GatewayApp.tsx` | 直接挂载 GatewayApp，复用 WebUI 的会话编排与视图。 |
| Gateway socket | `src/lib/gatewaySocket.ts`、`src/lib/gatewaySocketV2/*` | Gateway WebSocket 客户端（chat command/subscribe、settings/history 同步、terminal、sftp、git 等）。 |
| 数据控制器 | `src/lib/chat/*`、`src/lib/sidebar/*`、`src/lib/terminal/*`、`src/lib/sftp/*`、`src/lib/git/*`、`src/lib/tools/*`、`src/lib/providers/*`、`src/lib/settings/*` | 会话流、历史、终端、SFTP、git diff、工具调用、模型层与设置同步等 Gateway 客户端逻辑。 |
| 共享 UI 适配器 | `src/agent-ui-adapters/*` | 把共享 UI 的契约接到 Gateway 实现（头像、气泡、状态、composer、目录选择、设置扩展等）。 |
| 兼容层 shims | `src/shims/*` | 把 `@tauri-apps/api/core`、`@tauri-apps/api/event`、`@tauri-apps/plugin-opener` 重定向到 Gateway/browser 实现，与 WebUI `shims/*` 对齐。 |
| Tauri 外壳 | `src-tauri/src/lib.rs`、`src-tauri/src/main.rs` | `greet` 命令 + `opener` 插件；生成的 Android 工程见 `src-tauri/gen/android/`。 |

## App Shell 与运行时标记

| 责任 | 当前实现 |
|---|---|
| 运行时标记 | `main.tsx` 在渲染前把 `GATEWAY_WEBUI_MARKER` 写入 `document.documentElement.dataset.liveagentWebui`，是 `isGatewayWebuiRuntime` 的唯一权威写入点。 |
| 路由分派 | `/dashboard`、`/status-board`、`/observatory` → StatusDashboardPage；`/admin/devices` → DevicesAdminPage；其余 → GatewayApp。 |
| 入口 App | `App.tsx` 直接 `export default GatewayApp`。 |

## 能力通道：shims 重定向

移动端前端的 Tauri API 通过 Vite alias 重定向到本地 shims，实际命令走 Gateway 而非 Tauri Rust 后端：

| alias | 目标 | 说明 |
|---|---|---|
| `@tauri-apps/api/core` | `src/shims/tauriCore.ts` | `invoke` 把 `memory_*`、`chat_history_*`、`fs_*`、`system_*`、`terminal_*`、`proxy_*` 等命令映射到 Gateway WebSocket 客户端方法。 |
| `@tauri-apps/api/event` | `src/shims/tauriEvent.ts` | 事件桥接到 Gateway。 |
| `@tauri-apps/plugin-opener` | `src/shims/tauriOpener.ts` | `openUrl` 用 `window.open` 打开外链。 |

目录选择、文件选择等浏览器无法直接打开系统选择器的命令，在 shims 里退化为手动输入路径的对话框（`promptPathInBrowser`），语义与 WebUI 一致。

## Android 工程与签名

| 项 | 说明 |
|---|---|
| 生成的工程 | `src-tauri/gen/android/`（已提交仓库，供 CI 复现构建）。 |
| 标识 | `com.xiaofei.liveagent`，`compileSdk=36`、`minSdk=24`、`targetSdk=36`。 |
| 版本 | `versionName` 来自 tag；`versionCode` 按 `major*1000000 + minor*1000 + patch` 推导。 |
| 签名 | Gradle 从 `gen/android/local.properties` 读取 `storePassword`/`keyPassword`/`keyAlias`/`storeFile`；CI 由 `mobile-release.yml` 从 Secrets 解码后生成该文件。 |

## 设计取舍

| 取舍 | 原因 |
|---|---|
| 薄外壳、远端执行 | 移动端只做 Gateway 客户端，避免在 Android 上复制桌面端的高权限本地运行时，降低攻击面与维护成本。 |
| shims 复用 WebUI 语义 | 通过 alias 把 Tauri API 重定向到 Gateway 实现，前端代码可尽量与 WebUI 共用数据控制器与领域逻辑。 |
| 共享 UI 单一来源 | Settings、Hub、侧边栏、输入栏等仍在 `crates/agent-ui`，移动端只提供 `agent-ui-adapters`。 |
| 极简 Rust 后端 | 只注册 `opener` 插件与 `greet` 示例命令，业务能力不下沉到移动端 Rust，便于后续按需扩展。 |
