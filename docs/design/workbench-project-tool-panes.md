# 项目工具 Pane 化设计（审查 / 内网穿透 / SSH / 后台任务）

> 状态：已实现（2026-09-02）。本文档描述把 Right Dock 中剩余四个项目工具拆为独立
> Workbench 容器（Pane）的设计与落地方式；桌面端与 Web 端共用同一实现。
> 前置阅读：[session-workbench-pane-architecture.md](session-workbench-pane-architecture.md)
> §15（Terminal Surface）与 §16（File Tree Surface 与 Right Dock 边界）。

## 1. 背景与目标

Right Dock 的「开始使用」面板列出六个工具。在本轮之前：

| 工具 | 之前的形态 |
|---|---|
| 新建终端 | 已是独立 Pane（`localTerminal` / `sshTerminal` Surface，可拖拽拼接） |
| 新建文件树 | 已是独立 Pane（`fileTree` Surface，项目级单例 + 租约） |
| 新建审查 | 仅 Right Dock tab |
| 新建内网穿透 | 仅 Right Dock tab |
| 新建 SSH 连接 | 仅 Right Dock tab |
| 后台任务 | 仅 Right Dock 派生 tab |

目标：

1. 审查、内网穿透、SSH 连接、后台任务都能脱离 Right Dock，成为可拖拽、可拼接、可
   移动/关闭的 Workbench Pane，与终端 / 文件树享有同一套布局引擎（split、divider、
   最小尺寸、键盘命令、布局恢复）。
2. Right Dock 与 Pane 之间保持「同一工具只出现在一个宿主」的租约语义，避免重复的
   数据请求、订阅与状态竞争。
3. 桌面端（`agent-gui`）与 Web 端（`agent-gateway/web`）行为一致，实现放在共享层
   `@liveagent/ui`，两端只做注入。
4. 不复制任何工具面板的业务实现：`GitReviewPanel`、`LocalTunnelPanel`、
   `SshTunnelPanel`、`BackgroundTasksPanel` 原样复用。

非目标：

- 不改变工具面板内部的交互与数据流。
- 不改变终端 Pane 的租约/绑定机制。
- 不引入跨窗口/跨设备的布局同步。

## 2. 领域模型

### 2.1 Surface Spec

`crates/agent-ui/src/lib/workbench/types.ts` 新增「项目工具 Surface」族：

```ts
export const PROJECT_TOOL_SURFACE_KINDS = [
  "fileTree", "gitReview", "tunnel", "sshTunnel", "backgroundTasks",
] as const;

export type ProjectToolWorkbenchSurface = {
  [K in ProjectToolSurfaceKind]: { kind: K; project: ProjectRef };
}[ProjectToolSurfaceKind];
```

- 采用分布式映射类型，`switch (surface.kind)` 可逐 kind 收窄。
- 原 `FileTreeWorkbenchSurface` 保留为 `Extract<…, { kind: "fileTree" }>` 的别名。
- 所有项目工具 Surface 都携带 `ProjectRef`：聚焦 Pane 时 Right Dock 跟随该项目
  （`surfaceProjectRef` 语义不变）；布局只存 `{ kind, project }`，不存任何运行时
  数据。

### 2.2 身份（唯一性）

`projectToolSurfaceIdentityKey(kind, projectPathKey)`：

| kind | 身份键 | 作用域 |
|---|---|---|
| fileTree / gitReview / tunnel / sshTunnel | `${kind}:${projectPathKey}` | 项目级单例 |
| backgroundTasks | `backgroundTasks:` | 窗口级单例 |

后台任务镜像的是桌面端全局 ManagedProcess 注册表，与项目无关；第二个项目再开一个
只会显示完全相同的列表，因此裁决为整窗口单例（任一项目的 dock 都视为已租用）。
其余四个工具按项目分桶，两个项目各开一个审查 Pane 是合法布局。

`surfaceIdentityKey` / `findPaneIdBySurfaceKey` / reducer 的 `duplicate-surface`
拒绝 / `collectWorkbenchLayoutIssues` 不变量全部沿用同一身份键。

### 2.3 最小尺寸

`geometry.ts` 为每个 kind 定义硬最小尺寸（CSS px），参与 split 可行性判定、
divider clamp 与拖拽落点拒绝：

| kind | minWidth × minHeight | 依据 |
|---|---|---|
| gitReview | 320 × 220 | 工具栏 + 变更列表可读；列表/diff 分栏由面板内部在 ≥500px 时自行启用 |
| tunnel | 280 × 200 | 一行表单控件 + 若干行链接 |
| sshTunnel | 280 × 200 | 同上 |
| backgroundTasks | 260 × 180 | 进程行列表 |
| fileTree | 240 × 180 | 既有 |

### 2.4 拖拽载荷

`dragMachine.ts` 用统一载荷替代原 `fileTree` 载荷：

```ts
| { kind: "projectTool"; tool: ProjectToolSurfaceKind; project: ProjectRef; title: string }
```

- 自有 Pane 判定（`ownPaneIdForPayload`）按身份键查找：拖到自己 Pane 中心解析为
  focus，而不是 split。
- 落点可行性按 `surfaceMinSize({ kind: tool, project })` 取该工具的最小尺寸。

## 3. 事务与租约（共享纯函数）

`crates/agent-ui/src/lib/workbench/projectToolDropCommit.ts`，桌面端与 Web 端
共用，替代此前两端各自内联的文件树 drop 逻辑：

| 函数 | 语义 |
|---|---|
| `commitProjectToolDrop(payload, target, deps)` | 已有 Pane：落在自己中心 → 聚焦；其它落点 → 移动；空画布 → 忽略。无 Pane → 在落点打开。 |
| `openProjectToolInSplit(tool, project, deps)` | 菜单/键盘入口：已有 Pane → 聚焦；否则 `resolveAutoDockTarget()` 自动停靠，无空间 → `onNoSpace()`。 |
| `leasedProjectToolKinds(layout, projectPathKey, kinds)` | 布局中已被 Pane 持有的工具集合，供 Right Dock 隐藏 tab/内容/入口。 |

`useWindowWorkbench.openFileTreeSurface` 泛化为 `openProjectToolSurface`。

租约语义与文件树一致（§16）：Pane 存在期间 Right Dock 不挂该工具的 tab、内容与
新建入口（`RightDockPanel.leasedTools`）。

**关闭 Pane = 关闭工具**：Pane 的 × / `Meta+Alt+W` 在布局确认移除后，同步收掉 dock
里的该工具（`lib/projectTools/releaseProjectToolFromDock.ts`：工具 tab 删除
`tools[kind]` 与 tabOrder 项、清空指向它的 activeTabId；后台任务按其自身关闭手势
隐藏并快照当前进程 id）。释放租约后 dock 不会再把 tab 弹回来；从未进过 dock 的工具
是空操作。关闭不修改项目、隧道、SSH 会话或后台进程；再次从「开始使用」打开会以默认
UI 状态重建。

## 4. Pane 宿主与运行环境

### 4.1 `ProjectToolPaneHost`

`crates/agent-ui/src/components/workbench/ProjectToolPaneHost.tsx`：

```text
ProjectToolPaneHost({ paneId, surface, environment })
├── 按 surface.project 解析 WorkspaceProject（缺失 → UnsupportedPaneSurface "<kind>:missing"）
├── 组装 RightDockToolContextValue 并 Provider 注入
└── 按 kind 渲染：
    ├── fileTree        → FileTreePaneSurface（props 注入，自带多根拉取）
    ├── gitReview       → GitReviewPanel（读 context）
    ├── tunnel          → LocalTunnelPanel
    ├── sshTunnel       → SshTunnelPanel
    └── backgroundTasks → BackgroundTasksPanel（宿主负责 ensureManagedProcessInit）
```

设计裁决：GitReview 在 5 个文件里读 `RightDockToolContext`（数据层、状态视图、
工具栏、提交器、历史），把它改成 props 注入需要重写数据层；Pane 宿主改为「提供同一
个 context」，面板零改动，且 dock 与 Pane 渲染语义天然一致。

Pane 内工具永远 `active`（没有 tab 遮挡），字体缩放沿用 dock 的
`fontScale.rightDock`（`zone-font-scale`）。

### 4.2 `ProjectToolPaneEnvironment`

页面构造一次（`useMemo`），与传给 `RightDockPanel` 的是同一批 client / 回调，差别
只在「按 Pane 自己的 projectPathKey 取状态」：

| 字段 | 说明 |
|---|---|
| `clients` | terminal / git / textGeneration / tunnel / workspaceActivity |
| `capabilities` | git 写权限、隧道开关与 publicBaseUrl、禁用提示 |
| `fileTree.getState(key)` / `onStateChange(key, patch)` | 按项目分桶的文件树 UI 状态 |
| `fileTree.onOpenFile(request)` / `onInsertFileMention` / `onRevealInFileTree(key, path)` | 打开编辑器/预览、@ 引用、审查 → 文件树定位 |
| `git` | 提交/文件 mention、code-review 技能、`focusRequest` |
| `ssh.getAssociatedHostIds(key)` / `onAssociatedHostIdsChange(key, ids)` | 按项目关联主机 |
| `ssh.sessions` + `onSessionSnapshot` / `onSessionClosed` / `onSessionsReconcile` | 与页面级会话列表桥接（`sessionStore.ts` 新增纯函数 `mergeTerminalSession` / `removeTerminalSession` / `reconcileSshTerminalSessions`） |
| `activeProjectPathKey` | Composer mention 插入与 git focusRequest 只对 Right Dock 当前项目生效 |

## 5. 交互入口

| 入口 | 行为 |
|---|---|
| 「开始使用」六个卡片 | 点击：在 dock 内打开（不变）。按下并拖动（鼠标/笔，非触摸）：拖出到画布，落点直接打开该工具 Pane（`onToolDragStart`）。 |
| Right Dock 工具 tab（含后台任务） | 拖出到画布；右键/长按菜单「在分屏中打开」（`onOpenToolInWorkbench`）。 |
| 新建（+）菜单 | 已租用的工具不再列出。 |
| Pane 顶部 chrome | 拖动把手移动 / 拼接、× 关闭（同时关闭 dock 里的该工具）；键盘 `Meta/Ctrl+Alt+方向/W/=` 沿用。 |
| 拖拽幽灵 / 落点预览 | 标题取 `projectToolSurfaceTitleKey(kind)` 对应文案。 |
| 无障碍 | 区域标签 `workbench.paneRegionTool`（“工具面板：{title}”）。 |

## 6. 宿主接线

### 桌面端 `crates/agent-gui/src/pages/ChatPage.tsx`

- drop 提交：`payload.kind === "projectTool"` → `commitProjectToolDrop`。
- `handleToolWorkbenchDragIntent(kind, event)` / `handleOpenToolInWorkbenchSplit(kind)`
  替代文件树专用处理器；`dockToolProjectRef()` 提供 Right Dock 当前项目的 ProjectRef。
- `renderPaneContent`：`isProjectToolSurface(surface)` → `<ProjectToolPaneHost>`。
- `leasedDockTools = leasedProjectToolKinds(layout, terminalProjectPathKey, PROJECT_TOOL_SURFACE_KINDS)`
  传给 `RightDockPanel.leasedTools`。

### Web 端 `crates/agent-gateway/web/src/app/`

- `workbench/useGatewayWorkbench.ts`：同一份 drop / open-in-split 事务；控制器暴露
  `handleToolDragIntent` / `handleOpenToolInSplit`；新增 `projectToolTitle(tool)` 参数
  供幽灵标题本地化，`onProjectToolPaneClosed(tool, key)` 由 GatewayApp 接到
  `releaseProjectToolFromDock`。
- `GatewayAppView.tsx`：`projectToolPaneEnvironment`（终端 client 未连接时为 null，
  工具 Pane 与终端 Pane 同样不渲染）、`leasedDockTools`、`ProjectToolPaneHost`。
- 会话桥接：Web 页面只暴露整表提交 `handleProjectTerminalSessionsChange`，宿主按当前
  列表合并后回写。

## 7. 持久化与恢复

布局仍走 `layoutStorage.ts`（localStorage，`isWorkbenchLayoutValid` 校验）。新 kind
只存 `{ kind, project }`：

- 恢复后项目仍存在 → 正常渲染；项目缺失/归档 → `UnsupportedPaneSurface`
  占位（`<kind>:missing`），可移动/关闭，不自动改绑。
- 旧版本读到新 kind：`collectWorkbenchLayoutIssues` 会因未知 kind 判定无效并回退空
  布局（与既有 forward-compat 策略一致）。

## 8. 测试

| 文件 | 覆盖 |
|---|---|
| `crates/agent-gui/test/chat/workbench-project-tool-surfaces.test.mjs` | 身份键与作用域、最小尺寸、reducer 唯一性（同项目拒绝 / 跨项目并存 / 后台任务窗口单例）、不变量、`commitProjectToolDrop` 四种落点、`openProjectToolInSplit`、拖拽落点解析（自有 Pane → focus、最小尺寸拒绝）、dock 租约隐藏、两端源码合同 |
| `crates/agent-gateway/test/webui/session-workbench-web-project-tools.test.mjs` | Web 控制器/视图接线合同、共享事务在 Web 布局上的 open/move |
| 既有 `workbench-dock-focus` / `right-dock-model` / `workbench-drag-performance` | 已按 `leasedTools` / `projectTool` 载荷更新 |

`pnpm test:gui` 与 `pnpm test:webui` 全部通过；三端 `tsc`、改动路径 Biome、
`check:ui-boundaries` 与 `vite build` 通过。

## 9. 已知边界与后续

- **Git focusRequest 路由**：会话卡片「查看 diff」仍写 dock 的 `tools.gitReview`
  并发出 focusRequest；若审查已在 Pane 中，dock 隐藏该 tab、Pane 消费请求，但不会
  自动聚焦该 Pane。可在后续把 `handleChangedFileOpenDiff` 接到「已租用 → focusPane」。
- **SSH 交互终端**：SSH 连接 Pane 是连接管理入口；「进入 Bash / SFTP」仍打开 workspace
  overlay 或拖成 `sshTerminal` Pane，与 §15/§16 的互斥规则不变。
- **后台任务作用域**：整窗口单例是产品裁决；若未来注册表按项目分桶，改
  `projectToolSurfaceIdentityKey` 一处即可。
- **无项目上下文**：Tunnel 与后台任务自身可以在无项目的 Right Dock 中运行，但
  Workbench 布局中的所有项目工具 Surface 都需要稳定 `ProjectRef`，因此未选择工作区时
  不提供拖出或「在分屏中打开」入口；选择工作区后入口恢复。
- **实机矩阵**：本轮为模型/合同测试 + 构建验证，未做三平台实机拖拽验证。
