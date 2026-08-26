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
| navigate | scheme 校验（仅 http/https）→ `Page.navigate`，按响应中的 `loaderId` 轮询 `Page.getFrameTree` 等该 loader 提交且 readyState 就绪（同文档导航无 loaderId，立即完成），返回落地 URL+标题+精简 snapshot |
| snapshot | `Accessibility.getFullAXTree` → 过滤 ignored/generic 空节点 → 缩进文本 `- role "name" [ref=eN]`；ref→backendDOMNodeId 存会话映射；name 压平换行/转义引号（不可信页面文本不得伪造快照行结构） |
| click | ref → `DOM.scrollIntoViewIfNeeded`/`DOM.getBoxModel` 取中心坐标 → `Input.dispatchMouseEvent` press+release |
| type | click 聚焦后全选，`Input.insertText`（空文本＝清空字段）；`submit: true` 时补 Enter（keyDown 带 `text:"\r"` 以产生 keypress 语义，否则表单不会隐式提交） |
| screenshot | `Page.captureScreenshot`(jpeg q80) → base64 image content block |
| eval | `Runtime.evaluate`（returnByValue + awaitPromise），存在 `exceptionDetails` 即报错（含抛出原语值），结果 JSON 截断 ≤8k 字符 |
| wait | 等 selector 出现（`Runtime.evaluate` 轮询 `document.querySelector`）或纯延时 |
| back | `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`，load 事件只作 ≤3s 快路径信号，readyState 轮询兜底 |

navigate/click/type/back/wait 成功后自动附带新 snapshot（可用 `includeSnapshot: false` 关闭），保证模型每步都有页面状态；附带 snapshot 失败不连累已成功执行的动作（错误降级为结果备注，防模型误判失败而重复副作用）。snapshot 预算按 UTF-8 字节数（28k bytes ≈ 7k tokens，bytes/token 跨文字系统近似恒定，CJK 页面不超验收线）。

### 2.4 命令层

`commands/integration/browser.rs`：`browser_action(args) -> Result<BrowserActionResponse, String>` 单命令承载全部 action（Rust 侧 dispatch），另加 `browser_status` / `browser_close`。注册进 `app_invoke_handler!`。

**当前限制（后续迭代）**：动作执行期间不可取消（TS 侧仅在发起前检查 AbortSignal，未接 `runtime_cancel` run-id 链路），且 `BrowserManager` 单锁贯穿整个动作——执行中的动作会让 `browser_status`/`browser_close` 排队等待（最长一个动作超时 120s）。接取消链路时应一并把生命周期管理与动作执行拆锁。

### 2.5 会话生命周期与失效恢复

- 浏览器进程随 app `ExitRequested` 清理块回收；`shutdown_cleanup` 先 `try_lock` 取出会话触发 kill-tree，拿不到锁（退出瞬间有动作在跑）时按旁路记录的 pid 直接 `signal_process_tree_by_pid` 兜底，避免残留实例锁死 profile。
- 会话失效自动重建，两类失效都覆盖：WS 断开（用户整个退出浏览器）；WS 未断但页面 target 消失（用户只关自动化窗口/标签、tab 崩溃）——每次动作前经 browser-level `Target.getTargets` 探测 target 存活。

## 3. TS 侧

- `agent-ui/src/contracts/builtinTools.ts`：`BuiltinToolGroupId` 加 `"browser"`；新增 `BrowserResultDetails` 入 details union。
- `agent-gui/src/lib/tools/browserTools.ts`：`createBrowserTools({ sandbox })` bundle，typebox schema（action union + url/ref/text/selector/timeoutMs/snapshot 等可选参数），executor 调 `invoke("browser_action")`；`sandbox.enabled && !allowNetwork`（即 sandboxOffline）时 executor 直接拒绝（双保险）。
- `builtinRegistry.ts`：条件注册——sandboxOffline 下整个 bundle 不注入（模型不可见）。
- `toolPolicy.ts`：resolver 中 `group:browser` 未显式配置时默认 `ask`（现有 fall-through 是 allow，需专门分支）；缺省同时声明在 `builtinToolCatalog` 的 `defaultPolicy` 字段——设置页据此展示真实缺省，且用户显式选 `allow` 时写显式键（而非删键回落到 ask），两处保持同步。
- `toolExecutionPrompt.ts`：`has("Browser")` 使用指引段 + Available Tools 条目。
- `builtinToolCatalog.ts` + i18n（en/zh）：设置页可配 policy。
- 截图渲染：`{type:"image", data, mimeType}` content block，桌面/WebUI 现有链路零改动；proto 无需变更（tool 事件 JSON 直通）。非截图结果由 `ToolResultDisplay` 的 `kind === "browser"` 分支渲染（MetaTags 概览 + 正文/快照），错误与状态行摘要经共享 `summarizeToolCall` 的 Browser 分支。

## 4. 安全模型

1. `group:browser` 默认 `ask`——每次 Browser 调用出审批卡（用户可 approve_session）。
2. `sandboxOffline`：注册期跳过 + executor fail-closed 拒绝，离线语义覆盖浏览器出网。
3. 独立 profile：不读用户日常浏览器登录态/Cookie。
4. navigate 仅放行 http/https：`file://` 会绕过应用文件权限模型读任意本地文件，`chrome://` 等特权页面同理，Rust 侧统一拒绝（URL allowlist 仍为后续预留项）。
5. 审批摘要按 action 精确展示对应参数（`summarizeToolCallForApproval` 特判）：navigate 显 URL、click 显 ref、type 完整显示输入文本（含 +Enter）、eval 完整显示表达式——不能取"第一个非空字段"，否则模型可用无关字段（如 eval 附带 url）顶掉真实执行内容。
6. a11y snapshot 中的页面文本（name/valuetext）压平换行并转义引号，防不可信页面伪造快照树行（如注入假 `[ref=..]` 行）。

## 5. 验收（对齐路线图）

- [x] 「打开文档站 → 检索 → 提取内容 → 截图佐证」闭环（手动 e2e：`cargo test -p liveagent browser_e2e -- --ignored --nocapture`，实测 tauri.app 首页，截图见 `docs/images/browser-automation-e2e-tauri-app.jpg`）
- [x] a11y snapshot 单页 <8k tokens（tauri.app 首页实测 13194 字符 ≈ 3.3k tokens）
- [x] 独立 profile 无法读取用户日常浏览器登录态（`~/.liveagent/browser-profile` 独立 user-data-dir）
- [x] 审批/沙箱策略生效（`group:browser` 默认 ask；sandboxOffline 下 bundle 不注册 + executor fail-closed）

## 6. 非目标（本次不做）

- Phase A 预设卡片（独立提交）；Right Dock Browser 面板（后续 UI 迭代）；URL allowlist（预留 policy 位，scheme 级 http/https 限制已内置）；Firefox 支持；多 tab 管理（单页会话，navigate 复用同一 target）；动作中途取消与生命周期/执行拆锁（见 2.4 当前限制）；跨 snapshot 的 ref 代际校验（ref 每次快照重编号，模型侧以"页面变化后必须用新快照"提示约束）。
