# 前端架构

## 定位

**只有一个前端源码树**：`crates/agent-gui/src`。阶段 5 把 `agent-gateway/web`
（126,934 行）整个删掉，以 GUI 为基线合并（决策 16）。

同一份代码跑在两种宿主里：

| 宿主 | 后端在哪 | 登录页 | 壳能力 |
|---|---|---|---|
| Tauri 桌面壳 | 壳在进程内启动，`127.0.0.1:<随机端口>` | 跳过 | 全部可用 |
| 浏览器 | 用户填的地址，可能在别的机器上 | 需要 | 隐藏或降级 |

差异**不靠构建分叉**，靠运行时探测。判定源头只有一个：`isDesktopShell()`。

## 模块地图

| 模块 | 路径 | 职责 |
|---|---|---|
| App shell | `src/App.tsx` | 设置 hydration/save、主题/i18n、Settings overlay、ChatPage、CronPromptRunner、MemoryOrganizerRunner、全局 toast |
| 登录门禁 | `src/pages/login/` | `AuthGate` + `LoginPage` + `probeEndpoint` |
| Chat 页面 | `src/pages/ChatPage.tsx`、`src/pages/chat/*` | 会话状态、发送/取消、历史、上传、模型选择、审批卡片、压缩状态 |
| Settings | `src/pages/SettingsPage.tsx`、`src/pages/settings/*` | Providers、System、MCP、Agents、Hooks、Cron、Remote、Memory、Skills |
| Hub 页面 | `src/pages/skills-hub/*`、`src/pages/mcp-hub/*` | Skills Hub、MCP Hub、store/registry 浏览 |
| UI 组件 | `src/components/*`、`src/components/ui/*` | Sidebar、Markdown、git、memory、cron、project-tools、workspace-editor 等 |
| **后端客户端** | `src/lib/backend/*` | 端点解析、HTTP + WS 传输、命令/事件分流、Tauri API 顶替 |
| 壳能力探测 | `src/lib/shell/capabilities.ts` | 七个语义化谓词 |
| 领域库 | `src/lib/{settings,skills,memory,terminal,sftp,git,tools,mcpRegistry,tunnels,…}` | 各功能域的前端侧逻辑 |

**`src/lib/providers`、`src/lib/chat`、`src/lib/tools` 已不再承载对话运行时**——
引擎在 `crates/agent-core-js`。前端保留的是渲染、设置与工具目录展示所需的部分。

## 后端客户端（`src/lib/backend/`）

这是整个前端唯一的对外出口。七个文件，各管一件事：

| 文件 | 职责 |
|---|---|
| `endpoint.ts` | 端点从哪来（壳注入 / URL 参数 / localStorage）、凭据存取、`isDesktopShell()` |
| `transport.ts` | **真正的传输层**：`fetch` 打命令、一条 WS 收事件、重连退避 |
| `client.ts` | `backendFetch` / `backendFetchGet` / `subscribeEvents` 的显式命名面 |
| `commandRouting.ts` | 哪些 command/event 走壳、哪些走网络 |
| `tauriCore.ts` | vite alias 顶替 `@tauri-apps/api/core`，`invoke()` 落到这里分流 |
| `tauriEvent.ts` | 同上，顶替 `@tauri-apps/api/event` 的 `listen`/`emit` |
| `tauriShim.ts` / `tauriOpener.ts` | 浏览器侧的 internals polyfill 与 `plugin-opener` 顶替 |

业务代码**继续写 `invoke("chat_history_list")`**，不需要知道它落到哪。这是阶段 4
的核心手法：分流只有一个判定处，新增后端 command 不需要改任何名单。

### 端点解析

```text
桌面壳   → invoke("get_backend_endpoint")  → {host: "127.0.0.1", port, password}
浏览器   → URL 参数 ?backendHost=&backendPort=&token=&secure=
         → 否则 localStorage["liveagent.backend.endpoint"]
         → 都没有 → MissingCredentialsError → 登录页
```

壳内嵌的后端是 `.setup()` 里 spawn 的，前端跑起来时它可能还没监听。
`askShellForEndpoint()` 退避重试到拿到为止（上限 30s）。**shim 的安装必须是同步
的，但所有真正的调用都 `await` 同一个 Promise**——于是「端点未就绪期间的调用」
自然排成队列，不需要额外的队列结构。

URL 参数优先并顺手持久化，所以「发一条链接就能连上远程后端」不必先过登录页。

### 传输

| 方向 | 实现 |
|---|---|
| 命令 | `POST {base}/api/<command>`，`Authorization: Bearer <password>` |
| 快照 | `GET {base}/api/<command>?…`（`conversation_live` 一类） |
| 事件 | 一条 `WebSocket {wsBase}/api/events?token=…`，全局共享 |

响应解析：`routes_gen` 的 `respond()` 统一包 `{ok: …}`，`engine_proxy` 的快照类
GET 不包。**有就拆，没有就原样给**——比「没有 ok 字段就报错」少一类假故障。
401/403 抛 `UnauthorizedError`，登录页据此提示「密码不对」而不是笼统的「连接失败」。

WS 重连：500ms 起指数退避、上限 10s；**全局只允许一个待触发的定时器**。订阅者有
十几个（每个 `listen` 都会调 `ensureSocket`），不去重的话退避链会成倍增长，后端
没起来时前端会拿几十条重连打自己。

## 登录与认证

| 阶段 | 行为 |
|---|---|
| 壳内 | `AuthGate` 直接渲染 App，**一次网络探测都不做**。没有闪屏，没有登录页（决策 8） |
| 浏览器无凭据 | 直接进登录页 |
| 浏览器有凭据 | 先 `probeEndpoint()` 探一次，把「密码过期」「填成了旧 Gateway 地址」「后端没起来」三种情况分辨清楚，否则用户看到的是应用加载后满屏失败的请求 |
| 旧版痕迹 | localStorage 里有 `liveagent.gateway.token` 时给 v2 迁移提示 |

密码就是 Bearer token，前端不做任何变换。

## 宿主差异清单

`src/lib/shell/capabilities.ts` 的七个谓词当前**全部等价于 `isDesktopShell()`**。
分开命名是给调用点说清语义、给将来判定分化（比如 Linux 无托盘）留位置，
不是七个不同实现。

| 能力 | 浏览器里的处置 |
|---|---|
| 系统托盘 | 入口隐藏 |
| 自更新 | 入口隐藏（浏览器版本随后端走） |
| 窗口控制（置顶/关闭行为/macOS 红绿灯） | 入口隐藏，调用点早退 |
| 全局快捷键 | 入口隐藏 |
| 剪贴板 | 降级 `navigator.clipboard`（`clipboardText.ts` 本就有兜底） |
| 外链打开 | 降级 `window.open`（`tauriOpener.ts` 经 vite alias 顶替插件，7 个 import 点零改动） |
| 上传选文件 | 降级 `<input type=file multiple>`，产出与 `system_pick_readable_files` 等价的结构 |
| **原生"浏览…"对话框** | **隐藏按钮，保留手输路径** |
| 打开系统文件位置 | 入口按 `hasSystemFileOpener()` 隐藏 |

**为什么"浏览…"不降级**：`system_pick_file` / `system_pick_folder` 选的是**后端
所在机器**上的路径。桌面壳里前端和后端同机，弹原生对话框是对的；浏览器连远程
后端时，弹浏览器对话框选到的是用户本机路径，对后端毫无意义。降级成
`<input type=file>` 是语义错误，所以不做。

隐藏按钮的连带损伤已排查：`WorkspaceCloneModal` 的父目录输入框原本 `readOnly`、
只能靠原生对话框填，藏按钮时已改条件式 `readOnly`。

## Chat 在前端这一侧

引擎在后端，**前端只是渲染**（决策 10）。ChatPage 的编排范围因此小了很多：

| 环节 | 前端做什么 |
|---|---|
| 发送 | `backendFetch("chat_send", {conversationId, text, …})`，拿 202 就结束 |
| 增量 | `useBackendEventSubscription` 订阅 WS，按 `conversation_id` 路由到对应的 `LiveTranscriptStore` |
| 取消 | `backendFetch("chat_abort", {conversationId})` |
| 恢复 | 切换会话 / 重连时 `backendFetchGet("conversation_live", {conversationId})` 拉引擎内存快照；404 当作「无 live 增量」，基线走历史命令 |
| 审批 | 收到 `tool-approval:request` 事件 → 渲染卡片 → `backendFetch("tool_approval_respond", {approval_id, decision})` |
| 历史 | `chat_history_*` 命令，与其他后端命令没有区别 |

前端不再持有 provider API key，也不再需要脱敏快照那一套——密钥在后端。

## 已知遗留

| 项 | 状态 |
|---|---|
| `src/pages/chat/gateway/` | 7 个文件仍在（`useGatewayBridgeListeners` 等）。Rust 侧的 `gateway_*` command 已删，`commandRouting.ts::REMOVED_GATEWAY_COMMANDS` 本地拦下这 21 个调用并给迁移提示，避免用户看到 "command not found" / 404 这类让人猜的错误 |
| `openChatFileLink` | 浏览器里是「报错」不是「隐藏」。聊天消息里的文件链接是内联渲染元素，没有可门控的菜单入口，点击弹一句中文错误。真隐藏要在渲染层把链接降级成纯文本，改动大收益小 |
| 门控实测 | 全部门控是静态推导 + tsc 保证，**未在真浏览器里逐项点过**（阶段 5 验收未跑完） |

## 测试

```bash
node --test 'crates/agent-gui/test/**/*.test.mjs'
```

1371 个测试。行为型测试走 `helpers/load-ts-module.mjs`，用 `vm` 真实执行 TS，
断言输入输出。

阶段 5 清理掉了 20 个「用 `readFileSync` + 正则断言源码文本」的脆测试
（删 8、重写 2、裁剪 7、保留 3，**无一 skip**）——它们锁死源码长相而不验证行为，
大规模重构时会成片红，且红了也不代表真有问题。同时清掉了所有「双跑
GUI+WebUI 两份实现」的 parity 断言：web 树没了，比较对象也没了。

## 设计取舍

| 取舍 | 原因 |
|---|---|
| 分流用**反向**白名单 | 只列 19 个壳专属 command，其余一律走网络。正向列 176 行白名单意味着每加一个后端命令都要改前端 |
| 顶替 Tauri API 而不是改调用点 | vite alias + tsconfig paths 让 57 个文件的 `invoke()` 零改动完成网络化 |
| 全局一条 WS | 端点解析、鉴权、重连退避都只有一份，不会出现「两条连接各自退避」 |
| 能力探测而不是构建分叉 | 两份代码必然漂移；`mirror-manifest.json` 那套 CI 逐字节校验就是漂移的代价，已随合并删除 |
| ChatPage 仍是编排中心 | 即使引擎搬走了，会话状态、上传、模型选择、审批 UI 仍需要一个汇聚点 |

## 相关文档

- [overview.md](overview.md) —— 三层结构与进程边界
- [protocols.md](protocols.md) —— 前端消费的 HTTP/WS 契约
- [migration/phase-4-frontend.md](migration/phase-4-frontend.md) —— 网络化过程与遗留事项
- [migration/phase-5-merge.md](migration/phase-5-merge.md) —— 两套前端如何合成一套
