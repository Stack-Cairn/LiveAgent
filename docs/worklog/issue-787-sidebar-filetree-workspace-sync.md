# Issue #787：切换工作空间会话时右侧文件树未同步切换

日期：2026-09-16。状态：本地实现与自动验证完成，已在分支提交，尚未推送或创建 PR。

## 起因

v1.3.5（main @ 4eb6a4a8）复现：左侧会话树里点选另一个工作空间下的会话，会话内容切换了，但右侧文件树、终端、Git 面板仍停留在上一个工作空间。上游已有 Issue #787（v1.3.2 报的，open，无关联 PR），所以没有另开 issue，只在 #787 下留言确认复现并说明分支。

## 分支

fix/sidebar-filetree-sync，基线 main @ 4eb6a4a8。

## 根因

右侧 dock 的 `cwd` / `projectPathKey` 来自 `activeWorkspaceProjectPath`（Desktop 的 `useWorkspaceProjects`、WebUI 的 `useGatewayWorkspaceProjects`），而不是当前会话的 cwd。它只在用户点项目行、Workbench 聚焦 Pane、或者从搜索弹窗打开会话（#752 修的 `beforeCommit` 路径）时才被更新。PR #770 把侧栏改成跨工作空间的会话树以后，普通点选会话走的是 `openController.open(id)` 直开，没有任何一步把会话所属工作空间置为当前，dock 自然不动。

## 修复

两端一致：

- 从 `activateSearchConversationWorkspace` 里抽出 `activateConversationWorkspace(cwd)`，只做一件事，按 cwd 找到（或以 history 类型临时建）对应项目并 `activateWorkspaceProject(project, { preserveMissing: true })`；同工作空间或无 cwd 时直接返回，不写 settings。搜索路径改为调用它再做自己的 scope 处理，行为不变。
- Desktop `ChatPage.handleSelectConversation` 与 WebUI `handleSidebarSelectConversation` 的普通点选分支，把该激活挂在 `openController.open` 的 `afterCommit` 上：会话先提交（当前会话已切成目标会话），提交后再激活其工作空间。cwd 优先取运行时缓存/历史响应的权威 workdir，退到侧栏行 cwd。只在 agent 模式下做，text 模式不动工作空间。
- Desktop `useConversationHistoryActions.openInitial` 的 cache-hit 分支补调 `request?.afterCommit?.()`（热路径同样是一次真实提交，此前只有 painted 路径调用）。搜索路径不走 cache-hit 分支，不受影响。

### 为什么必须等 afterCommit（第一版返工的原因）

第一版在 `open` 之前同步激活工作空间，实测表现为"点一次只切工作空间，要再点一次才进会话"。机制：激活 → `sidebarScope` 先行切换 → 侧栏 store 重载后旧的当前会话从列表消失 → ChatPage 里"当前会话被删则新建草稿"的兜底 effect 触发 `startNewConversation` → `cancelConversationLoad` 顶掉了正在进行的这次打开，用户落在新工作空间的空白草稿上。改为提交后激活，此时当前会话已是目标会话（存在于新作用域列表中），兜底 effect 不再误判。

不改 `activateWorkspaceProject` 本身，不动搜索路径与 Workbench 路径的语义。文件树面板关闭时同样更新 `activeWorkspaceProjectPath`（RightDockPanel 的 `cwd`/`projectPathKey` 常驻传入），下次展开即为对应工作空间根目录。

## 涉及文件

- crates/agent-gui/src/pages/chat/workspace/useWorkspaceProjects.ts
- crates/agent-gui/src/pages/ChatPage.tsx
- crates/agent-gui/src/pages/chat/history/useConversationHistoryActions.ts
- crates/agent-gateway/web/src/app/hooks/useGatewayWorkspaceProjects.ts
- crates/agent-gateway/web/src/app/gatewayConversationActions.ts
- crates/agent-gateway/web/src/app/GatewayApp.tsx
- crates/agent-gateway/test/webui/history-chat-ui.test.mjs（新增 3 个用例）

## 自动验证

| 检查 | 结果 |
| --- | --- |
| tsc --noEmit（agent-gui） | 通过 |
| tsc --noEmit（gateway-webui） | 通过 |
| biome check 本次源码文件 | 通过 |
| pnpm test:webui | 721/721 通过（含新增 3 个） |
| pnpm test:gui | 3087/3095，8 个失败在基线 main @ 4eb6a4a8 上复测同样失败，与本次改动无关 |
| pnpm check:fast | Shared UI boundaries 项失败，报的 3 个文件本次未改动，是基线已有问题 |

## 已知边界

- 若当前是一个空白草稿会话，点选另一工作空间的会话时，工作空间先切换，`ChatPage` 里那条"空草稿跟随当前工作空间"的 effect 会把旧草稿的 workdir 也改过去。和用户直接点项目行时的行为一致，搜索路径同样如此，没有额外处理。
- 归档项目的会话不会在侧栏渲染，所以不会经这条路径把归档项目激活回来。

## 待办

- 用户在客户端验收后推送分支、开 PR 关联 #787。
