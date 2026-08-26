# 浏览器自动化：原生 `Browser` 工具（Phase B）

| 元数据 | 内容 |
|---|---|
| 状态 | In Progress |
| 版本 | v0.1 |
| 日期 | 2026-08-25 |
| 上游 | `docs/design/2026h2-capability-roadmap.md` 第 4 节 |

> 本文档实现路线图第 4 点 Phase B：Rust 直连 CDP 的原生 `Browser` 工具。Phase A（Playwright-MCP 推荐预设卡片）作为独立小改动另行提交。

## 1. 目标

- 单一 `Browser` 工具 + `action` 参数（navigate / snapshot / click / type / screenshot / eval / wait / back），沿用仓库 manager 风格（参照 `McpManager`），减少 schema 数量。
- 以 `--remote-debugging-port` + 独立 profile（`~/.liveagent/browser-profile`）拉起用户已装的 Chrome/Edge，与日常 profile 隔离，防凭据暴露。
- `snapshot` 输出 a11y 树 + ref id（aria-snapshot 风格），token 效率优先；`screenshot` 走现有 image content block 渲染链路。
- 安全：新 `group:browser` 默认 `ask`；`sandboxOffline` 下工具不注入且 executor fail-closed。

## 2. Rust 侧：`services/browser/`

模块结构（仿 `services/code_index/` 的多文件服务 + `services/stt/` 的 WS 会话模式）：

```
services/browser/
  mod.rs        # BrowserManager：单例浏览器会话，Arc 管理，注册于 lib.rs run()
  launcher.rs   # Chrome/Edge 可执行文件发现 + 独立 profile 启动 + DevTools 端口解析
  cdp.rs        # CDP WebSocket 客户端（tokio-tungstenite），请求/响应 id 配对 + 事件分发
  page.rs       # 高层操作：navigate/click/type/screenshot/eval/wait/back
  snapshot.rs   # Accessibility.getFullAXTree → 精简 aria 树文本 + ref id 映射
  types.rs      # serde 参数/响应类型
```

### 2.1 浏览器发现与启动（launcher.rs）

- 按平台固定候选路径探测 Chrome → Edge → Chromium（macOS `/Applications/...`、Windows `Program Files`、Linux `which`），不支持 Firefox（路线图待拍板项，先绑 Chromium 系）。
- 启动参数：`--remote-debugging-port=0`（随机端口防冲突）、`--user-data-dir=~/.liveagent/browser-profile`、`--no-first-run`、`--no-default-browser-check`、`--disable-sync`、`--new-window about:blank`。
- 端口获取：优先读 profile 下 Chrome 写出的 `DevToolsActivePort` 文件（轮询 ≤10s），成功后 `GET http://127.0.0.1:<port>/json/version` 拿 `webSocketDebuggerUrl`。
- 进程生命周期：`std::process::Command` + `configure_child_process_group`（同 MCP stdio）；`BrowserManager::shutdown` 与 app `ExitRequested` 清理块调用 kill-tree（`runtime/process.rs` 现有 helper）。

### 2.2 CDP 客户端（cdp.rs）

- `tokio-tungstenite` 连 browser-level WS；`Target.getTargets`/`Target.attachToTarget`（flatten 模式）拿页面 session。
- 命令 = 自增 id 的 JSON，`oneshot` 通道配对响应；事件（如 `Page.loadEventFired`）广播给等待者。
- 全部跑在 `tauri::async_runtime::spawn`，对外暴露 async 方法；错误统一 `Result<T, String>`（仓库惯例，不引入 anyhow/tracing）。

### 2.3 动作映射

| action | CDP |
|---|---|
| navigate | `Page.enable` + `Page.navigate`，等 `Page.loadEventFired` 或 readyState 轮询（超时 30s），返回落地 URL+标题+精简 snapshot |
| snapshot | `Accessibility.getFullAXTree` → 过滤 ignored/generic 空节点 → 缩进文本 `- role "name" [ref=eN]`；ref→backendDOMNodeId 存会话映射 |
| click | ref → `DOM.resolveNode`/`DOM.getBoxModel` 取中心坐标 → `Input.dispatchMouseEvent` press+release |
| type | click 聚焦后 `Input.insertText`；`submit: true` 时补 Enter keyDown/keyUp |
| screenshot | `Page.captureScreenshot`(jpeg q80) → base64 image content block |
| eval | `Runtime.evaluate`（returnByValue），结果 JSON 截断 ≤8k 字符 |
| wait | 等 selector 出现（`Runtime.evaluate` 轮询 `document.querySelector`）或纯延时 |
| back | `Page.getNavigationHistory` + `Page.navigateToHistoryEntry` |

navigate/click/type/back/wait 成功后自动附带新 snapshot（可用 `snapshot: false` 关闭），保证模型每步都有页面状态。

### 2.4 命令层

`commands/integration/browser.rs`：`browser_action(args) -> Result<BrowserActionResponse, String>` 单命令承载全部 action（Rust 侧 dispatch），另加 `browser_status` / `browser_close`。注册进 `app_invoke_handler!`；取消复用 `runtime_cancel` run-id 模式。

## 3. TS 侧

- `agent-ui/src/contracts/builtinTools.ts`：`BuiltinToolGroupId` 加 `"browser"`；新增 `BrowserResultDetails` 入 details union。
- `agent-gui/src/lib/tools/browserTools.ts`：`createBrowserTools({ sandbox })` bundle，typebox schema（action union + url/ref/text/selector/timeoutMs/snapshot 等可选参数），executor 调 `invoke("browser_action")`；`sandbox.enabled && !allowNetwork`（即 sandboxOffline）时 executor 直接拒绝（双保险）。
- `builtinRegistry.ts`：条件注册——sandboxOffline 下整个 bundle 不注入（模型不可见）。
- `toolPolicy.ts`：resolver 中 `group:browser` 未显式配置时默认 `ask`（现有 fall-through 是 allow，需专门分支）。
- `toolExecutionPrompt.ts`：`has("Browser")` 使用指引段 + Available Tools 条目。
- `builtinToolCatalog.ts` + i18n（en/zh）：设置页可配 policy。
- 截图渲染：`{type:"image", data, mimeType}` content block，桌面/WebUI 现有链路零改动；proto 无需变更（tool 事件 JSON 直通）。

## 4. 安全模型

1. `group:browser` 默认 `ask`——每次 Browser 调用出审批卡（用户可 approve_session）。
2. `sandboxOffline`：注册期跳过 + executor fail-closed 拒绝，离线语义覆盖浏览器出网。
3. 独立 profile：不读用户日常浏览器登录态/Cookie。
4. `eval` 属高危 action，审批摘要中显式标注 action + URL（`summarizeToolCallForApproval` 特判）。

## 5. 验收（对齐路线图）

- [x] 「打开文档站 → 检索 → 提取内容 → 截图佐证」闭环（手动 e2e：`cargo test -p liveagent browser_e2e -- --ignored --nocapture`，实测 tauri.app 首页，截图见 `docs/images/browser-automation-e2e-tauri-app.jpg`）
- [x] a11y snapshot 单页 <8k tokens（tauri.app 首页实测 13194 字符 ≈ 3.3k tokens）
- [x] 独立 profile 无法读取用户日常浏览器登录态（`~/.liveagent/browser-profile` 独立 user-data-dir）
- [x] 审批/沙箱策略生效（`group:browser` 默认 ask；sandboxOffline 下 bundle 不注册 + executor fail-closed）

## 6. 非目标（本次不做）

- Phase A 预设卡片（独立提交）；Right Dock Browser 面板（后续 UI 迭代）；URL allowlist（预留 policy 位）；Firefox 支持；多 tab 管理（单页会话，navigate 复用同一 target）。
