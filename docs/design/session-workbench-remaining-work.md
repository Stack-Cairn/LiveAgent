# Session Workbench 剩余工作记录

> 更新日期:2026-08-17(四轮实现后)。T-1~T-7、§四测试补齐与文档更新已全部完成;剩余项仅 §二(单独立项重构)与 §三(实机矩阵)。

## 〇、T 项最终状态(全部完成)

| 项 | 状态 | 落地方式 |
|---|---|---|
| T-1 cwd 范围校验 | ✅ | Rust `canonicalize_workdir_within`(registry.create / create_ssh 双路径强制,删除 cwd 反推)+ 前端 `projectScope.ts` 词法护栏(drop / restore / invariants 三道);cargo 测试 9 例 + 前端 6 例 |
| T-2 stale 恢复 | ✅ | 保留 Pane + stale binding 自动清理 + launchSpec 自动重建;TerminalPaneHost 纯逻辑测试覆盖恢复、去重与 kill 防自启 |
| T-3 newTerminal 拖入 | ✅ | 拖柄接到 RightDockLauncher 终端 tile(真实渲染路径),RightDockContent 不可达死代码已删 |
| T-4 关闭语义 | ✅ | Detach-first 裁决写回架构文档(§15/§17/§28 + §16/§27 两处附带);SSH 专属"断开连接"两态文案 |
| T-5 Right Dock 互斥 | ✅ | 本地会话改"保留+leased 标记"(视口层互斥,与 SSH overlay 同构);SSH hook 层对称;tab 右键/键盘菜单「在工作台打开/聚焦工作台面板」 |
| T-6 resize 相同值去重 | ✅ | `streamBuffer.ts` `lastSentResize`(重连/传输中断/发送失败三处豁免,含 reject 竞态防护);测试 4 例 |
| T-7 insufficient-space context 接入 | ✅ | `useWindowWorkbench` 从 ChatPage 的 `workbenchGeometryRef` 内部注入 context,`dividerSize: 6` 显式传入;拒绝经 `onCommandError` 转成 `workbench.noSpaceForSplit` 提示 |

**已裁决的冲突**:`view.compactChrome` 死分支已删除(`paneRendersCompact` 只按 rectWidth 判定);360px 自动 compact 保留。SSH `launchSpec.cwd` 语义统一为"本地 project 锚点(SFTP local root)",前端校验对两种终端 surface 一致生效,4 个测试夹具已修正。

**附加防御**:TerminalPaneHost 的 `killSession` 现在同时撤销启动资格(`setLaunchRequested(false)`),防止宿主未关 Pane 时 kill 被 ensure effect 变成静默重启。

### Permission-Changed blocked 态:调研结论(不实现)

设计文档 §7.4 要求 Pane blocked 有 Missing / Archived / **Permission Changed** 三态。
ChatPage 的 `blockedMessage` 目前只有前两个来源。调研后的结论是**数据层不存在可用于第三态
的信号**,因此本轮不实现,也不制造替代信号。

证据:

- **项目记录本身没有权限字段**。`WorkspaceProject`(`crates/agent-ui/src/lib/settings/types.ts`)
  只有 `id/name/path/kind/worktree/createdAt/updatedAt/lastConversationAt/isPinned/pinnedAt`。
  blocked 判定所依赖的两个集合(`missingWorkspaceProjectPathKeys` /
  `archivedWorkspaceProjectPathKeys`)是 `SystemSettings` 上两个平行的 path 数组
  (`useWorkspaceProjects.ts` 中 memo 化),没有第三个对应数组。
- **确实存在一个叫 `"changed"` 的状态,但它不是这个语义**。
  `workspace_root_grants_list`(`src-tauri/src/commands/workspace/root_grants.rs`)在每次调用时
  按 `fs::canonicalize(display_path)` 与授权时记录的 `canonical_path` 比对,得出
  `active | missing | changed`。它描述的是**项目额外挂载的 root**是否被换掉(软链/重挂载),
  **不是项目自身工作区访问权限被收回**。拿它去点亮"该项目权限已变更"的 banner 是假阳性:
  一个无关的附加 root 被重挂载,会让整个会话 Pane 被标记 blocked。
- **它也不可观测**。Grant 只走 request/response(`workspace_root_grants_list/apply/revoke`),
  刻意不进 settings 同步(见 `contracts/workspaceProjectRoots.ts` 的注释),Rust 侧不 emit 任何
  事件,前端也没有任何 `listen` 订阅它。现有三个消费点(设置弹窗、发送 turn 时、目录拖放)
  全是一次性 `await` 后即丢弃。要做成响应式只能新增轮询 + 新的 `SystemSettings` 字段,
  而轮询出来的仍是上一条所说的错误语义。

要真正做这一态,需要后端先给出「项目根授权被撤销/变更」的一等状态并推送事件(与
`workspace:activity` 同级),前端才能像 missing 那样把它归约成一个 path 集合。在那之前
`workbench.projectPermissionChanged` 文案也未加入 i18n——没有生产者的文案只会成为死 key。


## 一、T 项原始缺口记录(已全部完成,以下为历史方案存档)

以下为当初审计的缺口描述与实施方案,现均已按 §〇 落地,保留作背景参考:

### T-1 · 终端 cwd 范围校验(安全,最高优先)🔴
- **缺口**:拖已有终端会话入 pane 时 `terminalDropCommit.ts` 不校验 `session.cwd` 与投放目标
  `payload.project` 同源;布局恢复路径 `useWindowWorkbench.ts` 对持久化的 `launchSpec.cwd`
  只做 schema 解码;Rust `registry.rs` 在 `project_path_key` 缺省时由 cwd 反推,等于任意 cwd
  自造合法 project key。违反架构文档 §19.2「Pane JSON 不是授权凭据」。
- **方案**:前端加 `assertCwdWithinProject(cwd, project)`(规范化前缀比对,Windows 大小写
  不敏感 + 分隔符归一),drop 与 restore 双路径校验;Rust `registry.rs` 在传入
  `project_path_key` 时强制 `canonicalize(cwd).starts_with(project_root)`,失败报错而非反推。
- **语义已统一(本轮)**:`terminalLaunchSpecIsInProject` 原先只对 `localTerminal` 生效,
  因为测试夹具把 sshTerminal 的 `launchSpec.cwd` 写成远端路径(`/remote/home`、`/srv`)。
  实际语义相反——`create_ssh` 和本地终端一样在**本地** canonicalize 这个 cwd(它是 SFTP 的
  local root),不是远端工作目录。已删掉 `projectScope.ts` 里的 kind 收窄,并把四个测试夹具
  改成项目内路径,校验现在对两种终端 surface 一致生效(`surfaceIsLive` 与 invariants 的
  `terminal-cwd-outside-project` 一并覆盖)。

### T-2 · 终端 stale 恢复语义(历史缺口,现已修复)✅
- **缺口**:binding 存活 → 自动 ensure 建 PTY(设计要求不自动启动);binding 失效 →
  静默删除 pane 并塌缩 split(设计要求 stale 占位)。binding 存 sessionStorage,
  **应用重启必然清空 → 重启后所有终端 pane 无声消失**。
- **最终实现**:`surfaceIsLive` 保留 terminal Pane;WebView reload 优先重挂现存绑定,
  完整应用重启或 stale binding 则自动清理旧 sessionId,再由 `TerminalPaneHost`
  按 launchSpec 创建新会话。显式 kill 会临时撤销启动资格并立即关闭 Pane,避免自启竞态。

### T-3 · `newTerminal` / SSH 拖拽入口缺失
- 类型、提交分支、terminalDropCommit、测试全部就绪,但全仓无
  `beginWorkbenchDrag({kind:"newTerminal"})` 调用点;SSH pane 只能来自恢复路径。
- **方案**:「新建终端 +」按钮加 pointerdown 拖柄(复用 `RightDockTabStrip.tsx` 终端 tab
  的拖柄模式),payload 用聚焦 pane 的 project。

### T-4 · 终端关闭语义与设计不符
- 实现为静默 Detach + 独立"终止进程"两态按钮;设计要求运行中关闭默认确认终止。
- **裁决建议**:认可 Detach-first 模型(不误杀进程,对终端更安全)并更新架构文档
  §15.8/§17/§28.13;另需给 SSH 补断开确认。

### T-5 · Right Dock 互斥做法 + SSH 未过滤
- 实现为从列表整个过滤 leased 会话(设计要求只展示状态);SSH 会话不应用
  `hiddenSessionIds`;dock→workbench 缺「在工作台打开」菜单入口。
- **方案**:改"标记 leased"渲染态;SSH 分支补同样处理;终端 tab 右键菜单加入口。

### T-6 · 终端 Resize 缺相同 cols/rows 去重
- `streamBuffer.ts` 的 `flushResize()` 不比较上次已发送值,拖分隔条回原位/theme 变更/
  attach 重 fit 均重复下发。
- **方案**:`streamBuffer.ts` 加 `lastSentResize`,flush 前相等则跳过。

### T-7 · insufficient-space 命令 context 的 ChatPage 接入 ✅
- 引擎层已完成:`RevisionedWorkbenchCommand` 支持可选
  `context: { canvasSize, dividerSize? }`,提供时 OPEN_PANE / MOVE_PANE 在目标 region
  对半分不足最小尺寸时返回 `{ code: "insufficient-space" }`;不提供保持旧行为。
- **已接线**:context 不在各调用点分别传,而是由 `useWindowWorkbench` 在 `dispatch` 内统一
  注入——hook 新增可选 `geometryRef` / `dividerSize` / `onCommandError` 三个参数,ChatPage 传
  `geometryRef: workbenchGeometryRef` 与 `dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE`。这样
  拖放提交、自动贴靠菜单、键盘入口、resize 全部一次覆盖,调用点零改动;显式携带 context 的
  命令(冻结几何的拖拽事务)仍优先使用自己的。
- 画板尚未测量(`geometryRef.current` 为 null 或 0×0)时不传 context,保持旧的放行行为。
- 用户反馈:`onCommandError` 只对 `insufficient-space` 弹
  `addNotify("error", t("workbench.noSpaceForSplit"))`;stale-revision / duplicate-surface 等
  内部竞态保持静默。`resolveWorkbenchAutoDockTarget` 返回 null 的路径提前 return,不会重复提示。
- 覆盖测试:`crates/agent-gui/test/chat/workbench-command-context.test.mjs`。其中一例用
  `width = 2 * 320 + 6` 钉住 dividerSize 必须显式传 6——用 geometry 默认的 8 会被拒。

## 二、单独立项(改动面大,不与其他项混做)

### R-1 · DOM 级「Pane 移动不重挂」测试 ✅(2026-08-17 第四轮)
- 已落地:jsdom 基建 `test/helpers/dom-test-env.mjs`(jsdom 全局 + 真实 react/react-dom
  覆盖 loader 的 jsx-runtime mock,`Object.defineProperty` 安装以兼容 Node 22 getter-only
  globals;node:test 每文件独立进程,不影响既有 2128 例的纯对象 mock)。
- 测试 `test/chat/workbench-pane-dom-stability.test.mjs` 3 例:真实渲染 PaneSurfaceLayer,
  MOVE_PANE / RESIZE_SPLIT 后 `Object.is` 比对内容与 frame 节点实例不变(且断言 rect 确实
  更新,排除假阳性),CLOSE_PANE 只移除被关 Pane。jsdom 为 devDependency。

### R-2 · `syncVisibleConversationRuntime` 单槽位收敛(分层交付,2026-08-18 第六轮)

**已完成(本轮)**:
- **会话身份 + 模型选择收敛** ✅:`currentConversationSessionId` / `currentConversationCreatedAt` /
  `currentConversationSelectedModel` 三个页面级镜像 state 已删除。registry entry 是唯一事实
  来源,页面值经新增的 `useConversationRuntimeEntrySnapshot`(useSyncExternalStore 按
  conversationId 订阅 registry)派生。`syncVisibleConversationRuntime` 从同步 8 个 state 收窄
  到 5 个(state/compaction/isSending/errorMessage/hookWarning);
  `buildRuntimeEntryFromVisibleState` 与镜像→cache 写回 effect 改为从 cache 保留
  registry-owned 字段(identity/workdir/selectedModel),registry-first 更新不再被写回覆盖。
- **Send/Stop/Compact/Retry 显式 conversationId** ✅(核实为既有事实并加防回潮测试):
  `conversationControllerActions` 全部按显式 id 路由(send 走 `conversationIdOverride`,stop 走
  `stopConversationActionRef(conversationId)`,compact 走 `manualCompactActionRef({conversationId})`),
  send 管线 `overrideConversationId || currentConversationIdRef.current` 优先显式值。
- 测试:`runtime-slot-convergence.test.mjs` 5 例(registry-first 模型更新保身份且只触发 5 个
  瞬态 setter、后台会话更新零可见 state 写入、stop 按 id 隔离不误伤他会话、三镜像不回潮源码
  断言、action 显式 id 路由断言);`chat-stop-timing.test.mjs` 同步收窄参数。

**保留(理由与剩余步骤)**:
- 5 个瞬态镜像(conversationState/compactionStatus/isSending/errorMessage/hookWarning):
  它们是聚焦 Pane 完整管线(transcript 渲染、toast、发送闸门)的直接输入,消费面横跨
  useSendChatTurn/useManualCompaction/useChatTurnQueue/useNotifyToasts 等十余处;收敛需先把
  这些 hook 的读路径全部改为按 id 订阅 Controller slice,属独立大改造。当前语义安全:写入
  经 `updateConversationRuntimeEntry` 分桶,仅当前会话回镜像,后台会话零可见写入(有测试)。
- Composer 单 Ref(§314):牵涉 IME 组合、焦点返还与 DOM 生命周期,且草稿数据已在
  `conversationDraftStore` 分桶(Controller `setDraft/clearDraft`),仅编辑器 DOM 实例是单例;
  双 Pane 下非聚焦 Pane 经 focusGuard 先聚焦再输入,无数据丢失路径。保留。
- focusGuard(§316 的 UI 侧):对 Send/Model/RuntimeControls 等聚焦 Pane 语义的入口仍保留
  ——它们读取的瞬态镜像仍是单槽位,先聚焦再执行是正确语义;数据层 API 已全部显式 id 化。

### R-3 · Hydration 全局单槽位分桶 ✅(2026-08-17 第五轮)
- 已落地:`conversationHydrationStore.ts`(`ConversationHydrationStore`,按 conversationId 分桶
  的 `hydrating | failed` 相位,同一会话两相位互斥,与 draft store 同款订阅模型),挂进
  `ConversationRuntimeRegistry.hydration`(registry.delete/clear 一并回收桶)。
- 生产者改造:`useConversationHistoryActions.openInitial` 走 `markHydrating/clearHydrating/
  markFailed`(重试自动清本会话 fail 标记);`useGatewayBridgeReadiness` 按 id 清两相位;
  `useSendChatTurn` 发送闸门改 `hydration.isHydrating/isFailed(conversationId)`;
  `cancelConversationLoad` 改 `clearAllHydrating()`(序列失效只清 hydrating,fail 标记
  按 id 保留待重试清除)。
- 页面级派生:`useConversationHydrationPhase`(useSyncExternalStore)只读当前会话相位,
  `isConversationHydrating/Failed` 语义不变;`useMirroredNullableState` 已无消费者,删除。
- Controller 快照新增 `lifecycle: { hydrating, hydrationFailed }` slice(常量对象引用,
  refresh 按引用比较零开销),controller 订阅 hydration 桶。
- 测试 `hydration-bucketing.test.mjs` 9 例:A/B 并发互不覆盖、失败按 ID 隔离、重试只清
  本会话、clearAllHydrating 保留 fail、按会话通知、registry 回收、controller lifecycle
  slice、ChatPage 单槽位不回潮。
- R-2(8 个镜像 state / focusGuard / syncVisibleConversationRuntime 收敛)保持原状,未动。

## 三、无法本地完成(记录)

- macOS Retina / Windows 混合 DPI / Linux X11+Wayland 实机矩阵(含终止进程树
  Unix PGID vs ConPTY、DMG/MSI/AppImage 安装包)。
- VoiceOver/NVDA/Narrator + CJK IME 人工实测(ARIA 与 IME 守卫已就位)。
- 双流式会话渲染频率 / 内存 / Long Task profiler 实测(架构文档 §24 性能预算)。

## 四、后续测试补齐(§四两项已完成,2026-08-17 第四轮)

- ✅ 7.4 跨项目与 Right Dock:「focusedPane → activeProject → dock 数据源」解析已抽成纯函数
  `resolveWorkbenchPaneProject`(`crates/agent-gui/src/pages/chat/workbench/paneProjectContext.ts`),
  ChatPage 的 `activateWorkbenchPaneProject` 只负责调它并 activate;模型测试
  `workbench-pane-project-context.test.mjs` 7 例(archived/missing 不激活、陈旧 key 不回退、
  规范化 key 匹配、ChatPage 接线断言)。Permission-Changed blocked 态维持不实现(见 §〇)。
- ✅ 窄 pane 容器退化:桌面转录根(`ChatTranscript.tsx`)加 `@container`,FloorNavRail 展开
  面板 `max-w` 从 100vw 改 100cqw(分屏窄 Pane 内不再按视口钳宽),极窄容器(<280px)整条
  rail 隐藏;gateway `.gateway-transcript-stage` 声明 `container-type: inline-size` 保持两端
  语义一致。TranscriptWidthControls 无需改——其 maxWidth 本就按转录根实测宽度计算,
  `areWidthControlsUsable` 在窄 Pane 下已自然隐藏手柄。测试
  `workbench-narrow-pane-transcript.test.mjs` 3 例。表格/代码块本就 `overflow-x-auto` 且按
  容器宽度收缩,无额外改动。
- 另:`cargo check` 已在本轮跑通(交接文档「请你继续」第 1 项的编译部分);
  `useWindowWorkbench.resizeSplit` 的内核 clamp 自 T-7 统一注入 context 后即已生效
  (`workbench-command-context.test.mjs` 有 resize clamp 用例),交接文档中
  "resizeSplit 未传 context" 为过时描述。
