# 交接:终端 Pane 改造已完成(来自 shell 会话)

> 本文档由 "shell" 会话写给 "main" 会话的交接说明。main 请读完后按「请你继续」一节接手,完成后可删除本文件。

## 基本情况

终端(本地 + SSH)已成为可拖拽、可贴靠、与会话 Pane 并列的独立随动组件,严格按 `docs/design/session-workbench-pane-architecture.md` 的四层模型(Surface Spec / Runtime Binding / View Lease / PaneTree)落地。

### 架构分层

- **内核**(`crates/agent-ui/src/lib/workbench/`):`WorkbenchSurfaceSpec` union 化为 `conversation | localTerminal | sshTerminal | unsupported`;唯一性从 conversationId 泛化为 `surfaceIdentityKey()`;命令/不变量新增 `duplicate-surface` 错误码;codec 对未知 kind 前向兼容透传(re-encode 还原原始 payload,schemaVersion 仍为 1)。旧 conversation API(`findPaneIdByConversationId` 等)签名与行为不变。
- **身份与绑定**:布局 JSON 只存 `launchSpec + surfaceId`,**不存 sessionId**(设计文档约束);surfaceId→sessionId 走 `terminalPaneBindingStore`(sessionStorage `liveagent.terminalPaneBindings.v1`,生命周期恰好匹配 webview reload 后 Rust 端会话仍存活);sessionId↔paneId 互斥走 `terminalPaneLeaseStore`;Right Dock 与 SSH overlay 经租约集(`hiddenSessionIds` / `paneLeasedSessionIds`)互斥,防输出流双消费/输入双写。
- **组件**(agent-ui 共享层):`LocalTerminalPaneSurface`(connecting/ready/exited/error 四态受控,复用 XTermViewport,退出/错误叠提示条不清屏)、`SshTerminalPaneSurface`(三色状态点 + `user@host:port` + 重连按钮)、`UnsupportedPaneSurface`。所有新 props 可选、零 Tauri import(能力经 props 注入),webui 不受影响。
- **页面宿主**(agent-gui):`src/pages/chat/surfaces/TerminalPaneHost.tsx` —— 绑定解析 → 缺失时按 launchSpec 异步 ensure 建会话(`terminalPaneRuntime.ts` 模块级 in-flight 表防 StrictMode 双建 PTY)→ 租约 acquire/release → 按 kind 渲染。drop 事务"几何先行"(`terminalDropCommit.ts`:newTerminal 只提交布局,PTY 挂载后异步创建;既有会话先写绑定再 OPEN_PANE,失败回滚)。恢复对账:restore 前 `terminal_list` → `bindings.reconcile`,list 失败安全降级为丢弃终端 Pane、不阻塞会话恢复。
- **拖拽入口**:dock 本地终端 tab、SSH overlay 的 shell tab、dock 空态"新建终端"按钮均可拖入画板。Pane 的 × = Detach(进程保留回 dock);kill 走 Surface 内两态确认按钮(点一次武装、再点执行、3s 复位)。

### 验证状态(shell 会话在最终工作区独立复核)

- `pnpm --filter liveagent exec tsc --noEmit`:0 错误
- `pnpm test:gui`:2075/2075 通过
- `node scripts/check-ui-boundaries.mjs`:通过;i18n key 对齐:通过
- `pnpm build:gui`:构建通过(chunk 大小警告为预存在)
- **未 git commit;未改任何 Rust 代码**(后端 TerminalSessionRegistry 协议本就支持 detach/re-attach)

### 追加:性能与健壮性优化(shell 会话第二轮,已含在上述验证内)

1. **WebGL 渲染器**:`XTermViewport` 接入 `@xterm/addon-webgl@0.19.0`(与 xterm 6.0.0 同 release train),构造失败/context-loss 自动回退 DOM 渲染器。多 Pane 同屏渲染的主要性能保障。
2. **Right Dock 懒挂载**:非活跃终端 tab 不再挂 `XTermViewport`(原为全挂 + CSS hidden),attach 流随卸载释放,切回走 offset 快照重建。
3. **resize 两级节流**:divider 拖动中视觉 fit 80ms 节流跟手,PTY resize 独立 100ms 尾沿去抖,拖动结束保证最终尺寸提交。
4. **流事件分桶**:新增 `agent-ui/src/lib/terminal/streamHandleRegistry.ts`,output 事件按 sessionId Map 分桶 O(1) 派发(原 O(N) 遍历)。
5. **重启自动恢复(语义变化)**:终端 Pane 不再在恢复时丢弃或等待手动重启。布局恢复后,有存活绑定的 WebView reload 直接重挂;完整应用重启则清理陈旧绑定,按持久化 launchSpec 自动新建 PTY/SSH。旧进程与其内存输出无法跨进程复活,但 Pane 位置、cwd、shell/SSH 目标和交互入口会恢复。
6. **SSH 延迟显示**:`SshTerminalPaneSurface` 状态行显示 ms(<100 绿 / <300 黄 / 其余红),`TerminalPaneHost` 仅聚焦+running 时 15s 轮询 `sshLatency`,失败静默置 null。
7. **租约竞态测试**:`terminal-pane-lease-transfer.test.mjs` 7 例覆盖拖入链路、陈旧 release 令牌重放、detach 后再拖入、冲突 acquire。
8. **按 kind 最小尺寸预检**:内核 `surfaceMinSize()`(终端 220×140,按 20 cols×6 rows 折算;conversation 320×220 不变),接入 reducer OPEN/MOVE 预检、drop 四类 target 预检、DividerLayer 双侧子树 clamp(递归求和,超小窗口退化为对称 clamp 不崩溃)。注:内核 RESIZE clamp 已随 T-7 生效——`useWindowWorkbench.dispatch` 统一注入几何 context,`resizeSplit` 一并覆盖(`workbench-command-context.test.mjs` 有 resize clamp 用例)。
9. **极窄 Pane 自动 compact**:阈值 360px,`PaneSurfaceLayer` 渲染期由 rect 派生 `isCompact`(不写回 layout state,零 revision 开销),`view.compactChrome` 语义变为"强制紧凑"覆盖位;紧凑时 PaneChrome 收窄、SSH 状态行隐藏端点标签。

### 刻意保留的设计边界(不要"修复")

1. 陈旧 session 绑定自动清理并按 launchSpec 重建;创建失败或 SSH 需要交互输入时仍进入可重试错误态。
2. SFTP tab 留在 overlay、不参与互斥(独立通道,不争夺输出流)。
3. 绑定只走 sessionStorage,不落 SQLite。
4. 拖出手势仅鼠标/笔主键,触控保留原滚动/点击。

### 已知 TODO(代码内已注)

- SSH Pane 内无 SFTP(留在 overlay)。

## 请你继续

1. **编译/构建问题**:前端 `tsc`/`test:gui`/`build:gui` 已由 shell 会话验证通过,但 **`cargo check` / 完整 tauri build 未跑**;跑通后以 `VITE_LIVEAGENT_SESSION_WORKBENCH=1` 实机验证一轮(dock 拖出 → 移动 Pane 确认输出不闪 → divider 压到终端最小宽度 → 关闭回 dock → 应用重启确认布局与终端自动重建 → SSH 拖入/重连/延迟显示/互斥)。
2. **后续详细设计**:设计文档 Phase 5+ 剩余项——三平台硬化矩阵、`useWindowWorkbench.resizeSplit` 补传 context 启用内核 RESIZE clamp、SSH Pane 内 SFTP(如需)、以及你原有的待完善内容。
3. 改动未提交,commit 边界建议:内核泛化 / store+组件 / 集成收尾 / 性能与健壮性优化,四个 commit 很干净。

**建议**:任务面较宽,开启 agent team 分工执行以节省 token;开始前先压缩(/compact)一下你的上下文。
