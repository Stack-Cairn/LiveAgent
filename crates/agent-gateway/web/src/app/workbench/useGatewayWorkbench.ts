// Web 端 Session Workbench 编排：复用共享 useWindowWorkbench 布局 reducer，
// 把「聚焦 Pane 的会话」与页面的 displayedConversationId 保持一致（与桌面端
// ChatPage 的 selectWorkbenchConversation / syncCurrentConversation 同一语义）。
// 拖拽体系与桌面端共用同一状态机/拖拽会话 hook：侧栏会话与项目、Right Dock
// 终端 tab 与「新建终端」都可拖入画布,Pane 头部拖动重排。

import { WORKBENCH_CANVAS_DIVIDER_SIZE } from "@liveagent/ui/components/workbench/WorkbenchCanvas";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import type { TerminalClient, TerminalSession } from "@liveagent/ui/lib/terminal/types";
import {
  commitWorkspaceDropConversation,
  findAdjacentPaneId,
  findPaneIdBySurfaceKey,
  findParentSplitId,
  MIN_CONVERSATION_PANE_HEIGHT,
  MIN_CONVERSATION_PANE_WIDTH,
  type WorkbenchEdge,
  type WorkbenchGeometry,
  type WorkbenchOpenTarget,
  type WorkbenchRect,
} from "@liveagent/ui/lib/workbench/index";
import { commitTerminalDrop } from "@liveagent/ui/lib/workbench/terminalDropCommit";
import {
  createTerminalSurfaceId,
  findTerminalPaneForSession,
} from "@liveagent/ui/lib/workbench/terminalPaneRuntime";
import {
  type PaneRecord,
  type ProjectRef,
  surfaceIdentityKey,
  surfaceProjectRef,
} from "@liveagent/ui/lib/workbench/types";
import {
  useWindowWorkbench,
  type WindowWorkbench,
} from "@liveagent/ui/lib/workbench/useWindowWorkbench";
import {
  useWorkbenchDragSession,
  type WorkbenchDragState,
  type WorkbenchDragUnavailableReason,
  type WorkbenchDropCommit,
} from "@liveagent/ui/lib/workbench/useWorkbenchDragSession";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { type WorkspaceProject, workspaceProjectPathKey } from "@/lib/settings";
import {
  gatewayTerminalPaneAutoLaunch,
  gatewayTerminalPaneBindings,
  gatewayTerminalPaneLease,
} from "./terminalPaneRuntime";

/** 与桌面端 canSplitRectAtEdge 同口径：两半都必须保住会话 Pane 硬最小尺寸。 */
function canSplitRectAtEdge(rect: WorkbenchRect, edge: WorkbenchEdge): boolean {
  const horizontal = edge === "left" || edge === "right";
  const min = horizontal ? MIN_CONVERSATION_PANE_WIDTH : MIN_CONVERSATION_PANE_HEIGHT;
  const span = horizontal ? rect.width : rect.height;
  return span - WORKBENCH_CANVAS_DIVIDER_SIZE >= min * 2;
}

/** 桌面端窄画布自动停靠改走纵向的阈值（doc §22）。 */
const NARROW_CANVAS_WIDTH_FOR_AUTO_DOCK = 680;

function resolveWorkbenchPaneProject(
  projectPathKey: string | undefined,
  input: {
    workspaceProjects: readonly WorkspaceProject[];
    archivedProjectPathKeys: ReadonlySet<string>;
    missingProjectPathKeys: ReadonlySet<string>;
  },
): WorkspaceProject | null {
  if (!projectPathKey) return null;
  if (input.archivedProjectPathKeys.has(projectPathKey)) return null;
  if (input.missingProjectPathKeys.has(projectPathKey)) return null;
  return (
    input.workspaceProjects.find(
      (project) => workspaceProjectPathKey(project.path) === projectPathKey,
    ) ?? null
  );
}

export type UseGatewayWorkbenchParams = {
  enabled: boolean;
  displayedConversationId: string;
  sidebarStore: SidebarStore;
  workspaceProjects: readonly WorkspaceProject[];
  /** 归档项目不接受 workspace 拖拽落点（与桌面端同口径）。 */
  archivedProjectPathKeys: ReadonlySet<string>;
  /** 缺失项目不激活 Right Dock 跟随（与桌面端 blocked 判定同一键空间）。 */
  missingProjectPathKeys: ReadonlySet<string>;
  /** 聚焦 Pane 的项目上下文驱动 Right Dock（archived/missing 不切换）。 */
  activateWorkspaceProject: (project: WorkspaceProject) => void;
  /** 网关终端 client；未连接时终端拖拽入口不渲染，closed 联动停摆。 */
  terminalClient: TerminalClient | null;
  /** 全窗口终端会话列表（Right Dock 权威态）。 */
  terminalSessions: readonly TerminalSession[];
  /** Right Dock 当前项目路径；「新建终端」拖拽的 cwd 来源。 */
  terminalProjectPath: string;
  /** 拖拽幽灵上「新建终端」的标题文案（已本地化）。 */
  newTerminalTitle: string;
  /** 把页面当前会话切换到指定会话（走既有的侧栏选择通路）。 */
  selectConversation: (conversationId: string) => void;
  /** workspace 拖拽落点：走既有「项目新建会话」通路（目录检查 + 新草稿）。 */
  startConversationForProject: (project: WorkspaceProject) => Promise<string | null>;
  /** 草稿 workdir 权威查询：workspace 拖拽开 Pane 前校验落点身份。 */
  conversationWorkdirFor: (conversationId: string) => string | null;
  /** 自动停靠没有合法空间时的用户提示。 */
  onNoSpaceForSplit: () => void;
  /** 拖拽期间布局/几何已变化，事务无法安全重放。 */
  onDropStateChanged: () => void;
  /** 已在 Pane 中的会话再次从侧栏拖入时，明确说明聚焦语义。 */
  onConversationAlreadyOpen: () => void;
};

export type GatewayWorkbenchController = {
  workbench: WindowWorkbench;
  geometryRef: React.MutableRefObject<WorkbenchGeometry | null>;
  handleGeometryChange: (geometry: WorkbenchGeometry) => void;
  handleFocusPane: (paneId: string) => void;
  handleClosePane: (paneId: string) => void;
  /** 侧栏菜单「在分屏中打开」：聚焦既有 Pane，否则贴着聚焦 Pane 自动停靠。 */
  handleOpenConversationInSplit: (item: SidebarConversation) => boolean;
  /** Right Dock 菜单「在分屏中打开」：同一 drop 事务的无拖拽入口。 */
  handleOpenTerminalInSplit: (session: TerminalSession) => void;
  handleOpenFileTreeInSplit: () => void;
  /** Right Dock 新建菜单「在分屏中新建终端」。 */
  handleOpenNewTerminalInSplit: () => void;
  /** SSH overlay「已在画板中打开」占位的「前往 Pane」聚焦通路。 */
  focusTerminalPaneForSession: (sessionId: string) => void;
  /** 会话从权威索引消失（删除等）：关闭对应 Pane，不做选中迁移。 */
  closePanesForRemovedConversations: (ids: readonly string[]) => void;
  /** 登录/Agent 作用域切换：清空布局和终端 surface 绑定。 */
  clearWorkbench: () => void;
  projectRefForConversation: (item: { id: string; cwd?: string | null }) => ProjectRef;
  /** 拖拽 overlay 模型（幽灵 + 落点预览）；idle 时为 null。 */
  dragState: WorkbenchDragState | null;
  /** Pane 头部拖动把手（pointer-down 发起）。 */
  beginPaneDrag: (
    pane: PaneRecord,
    title: string,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** 侧栏会话行拖拽发起。 */
  handleConversationDragIntent: (
    item: SidebarConversation,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** 侧栏项目行拖拽发起（落点新建会话）。 */
  handleProjectDragIntent: (
    project: WorkspaceProject,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** Right Dock 终端 tab 拖拽发起（既有会话入画布）。 */
  handleTerminalTabDragIntent: (
    session: TerminalSession,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** Right Dock「新建终端」按钮拖拽发起（落点新建终端 Pane）。 */
  handleNewTerminalDragIntent: (event: {
    pointerId: number;
    clientX: number;
    clientY: number;
    currentTarget?: EventTarget | null;
  }) => void;
  handleFileTreeTabDragIntent: (event: {
    pointerId: number;
    clientX: number;
    clientY: number;
    currentTarget?: EventTarget | null;
  }) => void;
  /** 被画布 Pane 租用的会话（Right Dock 终端 tab 互斥隐藏用）。 */
  leasedDockSessionIds: readonly string[];
};

export function useGatewayWorkbench(params: UseGatewayWorkbenchParams): GatewayWorkbenchController {
  const {
    enabled,
    displayedConversationId,
    sidebarStore,
    workspaceProjects,
    archivedProjectPathKeys,
    missingProjectPathKeys,
    activateWorkspaceProject,
    terminalClient,
    terminalSessions,
    terminalProjectPath,
    newTerminalTitle,
    selectConversation,
    startConversationForProject,
    conversationWorkdirFor,
    onNoSpaceForSplit,
    onDropStateChanged,
    onConversationAlreadyOpen,
  } = params;

  const projectRefForConversation = useCallback(
    (item: { id: string; cwd?: string | null }): ProjectRef => {
      const cwd = item.cwd?.trim() || "";
      const pathKey = cwd ? workspaceProjectPathKey(cwd) : "";
      const project = pathKey
        ? workspaceProjects.find((entry) => workspaceProjectPathKey(entry.path) === pathKey)
        : undefined;
      return {
        projectId: project?.id ?? `conversation:${item.id}`,
        projectPathKey: pathKey || `conversation:${item.id}`,
      };
    },
    [workspaceProjects],
  );

  const projectRefForConversationRef = useRef(projectRefForConversation);
  projectRefForConversationRef.current = projectRefForConversation;

  const sidebarProjectRef = useCallback(
    (conversationId: string): ProjectRef =>
      projectRefForConversationRef.current({
        id: conversationId,
        cwd: sidebarStore.peek(conversationId)?.cwd ?? null,
      }),
    [sidebarStore],
  );

  const geometryRef = useRef<WorkbenchGeometry | null>(null);
  const handleGeometryChange = useCallback((geometry: WorkbenchGeometry) => {
    geometryRef.current = geometry;
  }, []);

  // 冷启动单 Root Pane（与桌面端一致，不做布局持久化）。
  const initialRef = useRef<{ conversationId: string; project: ProjectRef } | null>(null);
  if (initialRef.current === null) {
    initialRef.current = {
      conversationId: displayedConversationId,
      project: sidebarProjectRef(displayedConversationId),
    };
  }

  const workbench = useWindowWorkbench({
    initialConversationId: initialRef.current.conversationId,
    initialProject: initialRef.current.project,
    geometryRef,
    dividerSize: WORKBENCH_CANVAS_DIVIDER_SIZE,
    // Web 每次打开都从当前会话的单 Pane 首页开始。Desktop 仍使用共享
    // Hook 的默认持久化，以保留其窗口布局恢复能力。
    persistence: false,
    onCommandError: (error) => {
      if (error.code === "insufficient-space") onNoSpaceForSplit();
    },
  });

  const selectConversationRef = useRef(selectConversation);
  selectConversationRef.current = selectConversation;
  // Pane 点击会异步走页面选中管线；在 displayedConversationId 落地前，
  // syncCurrentConversation 不得把聚焦 Pane 重绑回旧会话（桌面端
  // workbenchPendingSelectRef 同口径）。
  const pendingSelectRef = useRef<string | null>(null);
  const selectWorkbenchConversation = useCallback((conversationId: string) => {
    const key = conversationId.trim();
    if (!key) return;
    pendingSelectRef.current = key;
    selectConversationRef.current(key);
  }, []);
  const startConversationForProjectRef = useRef(startConversationForProject);
  startConversationForProjectRef.current = startConversationForProject;
  const conversationWorkdirForRef = useRef(conversationWorkdirFor);
  conversationWorkdirForRef.current = conversationWorkdirFor;
  const terminalSessionsRef = useRef(terminalSessions);
  terminalSessionsRef.current = terminalSessions;
  const workspaceProjectsRef = useRef(workspaceProjects);
  workspaceProjectsRef.current = workspaceProjects;

  // Workspace drop awaits the exact draft id. While directory validation and
  // draft creation are in flight, the current-conversation sync must not
  // rebind the focused pane underneath the explicit drop transaction.
  const workspaceDropSequenceRef = useRef(0);
  const pendingWorkspaceDropRef = useRef<{
    operationId: number;
    projectPathKey: string;
  } | null>(null);

  const activatePaneProject = useCallback(
    (projectPathKey?: string) => {
      const project = resolveWorkbenchPaneProject(projectPathKey, {
        workspaceProjects,
        archivedProjectPathKeys,
        missingProjectPathKeys,
      });
      if (project) activateWorkspaceProject(project);
    },
    [activateWorkspaceProject, archivedProjectPathKeys, missingProjectPathKeys, workspaceProjects],
  );

  // 页面当前会话变化（侧栏选择、新会话、草稿转正）→ 聚焦 Pane 跟随；
  // 会话已在其它 Pane 时聚焦挪过去，维持「一个会话最多一个 Pane」。
  const lastSyncedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const key = displayedConversationId.trim();
    if (!key) return;
    const pending = pendingSelectRef.current;
    if (pending && pending !== key && lastSyncedConversationRef.current === key) {
      return;
    }
    pendingSelectRef.current = null;
    const previousSynced = lastSyncedConversationRef.current;
    lastSyncedConversationRef.current = key;

    const pendingDrop = pendingWorkspaceDropRef.current;
    if (pendingDrop && previousSynced !== key) {
      const workdir = conversationWorkdirForRef.current(key)?.trim() || "";
      if (workdir && workspaceProjectPathKey(workdir) === pendingDrop.projectPathKey) {
        return;
      }
    }
    workbench.syncCurrentConversation(key, sidebarProjectRef(key));
  }, [enabled, displayedConversationId, sidebarProjectRef, workbench]);

  const handleFocusPane = useCallback(
    (paneId: string) => {
      const pane = workbench.focusPane(paneId);
      if (!pane) return;
      // 终端/不支持的 surface 不驱动页面当前会话，只把 Right Dock 跟到该
      // Pane 的项目（archived/missing 不切换）。
      if (pane.surface.kind !== "conversation") {
        activatePaneProject(surfaceProjectRef(pane.surface)?.projectPathKey);
        return;
      }
      const conversationId = pane.surface.conversationId;
      if (conversationId && conversationId !== displayedConversationId) {
        selectWorkbenchConversation(conversationId);
      }
      activatePaneProject(pane.surface.project.projectPathKey);
    },
    [activatePaneProject, displayedConversationId, selectWorkbenchConversation, workbench],
  );

  const handleClosePane = useCallback(
    (paneId: string) => {
      const pane = workbench.layoutRef.current.panes[paneId];
      const result = workbench.closePane(paneId);
      // 终端 Pane 的关闭是 Detach:进程保留,租约随宿主卸载释放,会话回到
      // Right Dock;绑定一并回收,再次拖入走全新 surface 身份。
      if (pane?.surface.kind === "localTerminal" || pane?.surface.kind === "sshTerminal") {
        gatewayTerminalPaneBindings.delete(pane.surface.surfaceId);
      }
      if (
        result.closedFocused &&
        result.nextConversationId &&
        result.nextConversationId !== displayedConversationId
      ) {
        selectWorkbenchConversation(result.nextConversationId);
      }
    },
    [displayedConversationId, selectWorkbenchConversation, workbench],
  );

  const handleClosePaneRef = useRef(handleClosePane);
  handleClosePaneRef.current = handleClosePane;

  // Right Dock 是终止进程的唯一入口(Detach-first 裁决):会话被显式关闭
  // (`closed` 事件)时,持有它的 Pane 一并关闭。按绑定而非租约查找,覆盖
  // 宿主取得租约前的 connecting 窗口。
  useEffect(() => {
    if (!enabled || !terminalClient) return;
    return terminalClient.subscribe((event) => {
      if (event.kind !== "closed") return;
      const closedSessionId = event.sessionId?.trim() || event.session?.id || "";
      if (!closedSessionId) return;
      const paneId = findTerminalPaneForSession(closedSessionId, {
        bindings: gatewayTerminalPaneBindings,
        layout: workbench.layoutRef.current,
      });
      if (paneId) handleClosePaneRef.current(paneId);
    });
  }, [enabled, terminalClient, workbench]);

  // 与桌面端同口径的键盘命令,全部挂在 Meta/Ctrl+Alt:
  // 方向键聚焦相邻 Pane,Shift+方向键把聚焦 Pane 挪到那边,W 关闭,=/+ 均分。
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const layout = workbench.layoutRef.current;
      const focusedPaneId = layout.focusedPaneId;
      if (!focusedPaneId || Object.keys(layout.panes).length < 2) return;

      const direction =
        event.key === "ArrowLeft"
          ? ("left" as const)
          : event.key === "ArrowRight"
            ? ("right" as const)
            : event.key === "ArrowUp"
              ? ("top" as const)
              : event.key === "ArrowDown"
                ? ("bottom" as const)
                : null;
      if (direction) {
        const geometry = geometryRef.current;
        if (!geometry) return;
        const nextPaneId = findAdjacentPaneId(geometry, focusedPaneId, direction);
        if (!nextPaneId) return;
        event.preventDefault();
        if (event.shiftKey) {
          workbench.movePane(focusedPaneId, {
            kind: "pane-edge",
            paneId: nextPaneId,
            edge: direction,
          });
          return;
        }
        handleFocusPane(nextPaneId);
        return;
      }

      if (event.shiftKey) return;
      if (event.key === "w" || event.key === "W") {
        event.preventDefault();
        handleClosePane(focusedPaneId);
        return;
      }
      if (event.key === "=" || event.key === "+") {
        const splitId = findParentSplitId(layout, focusedPaneId);
        if (!splitId) return;
        event.preventDefault();
        workbench.equalizeSplit(splitId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, handleClosePane, handleFocusPane, workbench]);

  // 与桌面端 resolveWorkbenchAutoDockTarget 同口径：优先右侧（窄画布优先
  // 下方），两个方向都放不下时明确拒绝。
  const resolveAutoDockTarget = useCallback((): WorkbenchOpenTarget | null => {
    const layout = workbench.layoutRef.current;
    if (!layout.focusedPaneId) return { kind: "canvas-empty" };
    const geometry = geometryRef.current;
    const focusedRect = geometry?.panes.find((pane) => pane.paneId === layout.focusedPaneId)?.rect;
    if (!geometry || !focusedRect) return null;
    const preferVertical = geometry.canvas.width < NARROW_CANVAS_WIDTH_FOR_AUTO_DOCK;
    const edges = preferVertical ? (["bottom", "right"] as const) : (["right", "bottom"] as const);
    for (const edge of edges) {
      if (canSplitRectAtEdge(focusedRect, edge)) {
        return { kind: "pane-edge", paneId: layout.focusedPaneId, edge };
      }
    }
    return null;
  }, [workbench]);

  const handleOpenConversationInSplit = useCallback(
    (item: SidebarConversation): boolean => {
      const existingPaneId = workbench.paneIdForConversation(item.id);
      if (existingPaneId) {
        handleFocusPane(existingPaneId);
        return true;
      }
      const target = resolveAutoDockTarget();
      if (!target) {
        onNoSpaceForSplit();
        return false;
      }
      const project = projectRefForConversationRef.current(item);
      const opened = workbench.openConversation({ conversationId: item.id, project }, target);
      if (opened && item.id !== displayedConversationId) {
        selectWorkbenchConversation(item.id);
      }
      return opened !== null;
    },
    [
      displayedConversationId,
      handleFocusPane,
      onNoSpaceForSplit,
      resolveAutoDockTarget,
      selectWorkbenchConversation,
      workbench,
    ],
  );

  /** 终端 drop 事务的公共依赖(拖拽提交与菜单入口共用)。 */
  const terminalDropDeps = useCallback(
    () => ({
      layout: workbench.layoutRef.current,
      sessions: terminalSessionsRef.current,
      lease: gatewayTerminalPaneLease,
      bindings: gatewayTerminalPaneBindings,
      resolveProjectPath: (project: ProjectRef) =>
        workspaceProjectsRef.current.find((entry) => entry.id === project.projectId)?.path ??
        workspaceProjectsRef.current.find(
          (entry) => workspaceProjectPathKey(entry.path) === project.projectPathKey,
        )?.path ??
        null,
      createSurfaceId: createTerminalSurfaceId,
      authorizeAutoLaunch: gatewayTerminalPaneAutoLaunch.authorize,
      openTerminalSurface: workbench.openTerminalSurface,
      movePane: workbench.movePane,
      focusPane: handleFocusPane,
    }),
    [handleFocusPane, workbench],
  );

  const handleDropCommit = useCallback(
    (commit: WorkbenchDropCommit) => {
      // 布局修订号在拖拽期间变了(聚焦/结构变化):取消事务而不是按陈旧
      // 几何重放。
      if (commit.revision !== workbench.layoutRef.current.revision) {
        onDropStateChanged();
        return;
      }
      const { payload, target } = commit;
      if (payload.kind === "workspace") {
        if (target.kind === "pane-center") return;
        const pathKey = workspaceProjectPathKey(payload.projectPath);
        if (archivedProjectPathKeys.has(pathKey)) return;
        const project = workspaceProjectsRef.current.find(
          (entry) => workspaceProjectPathKey(entry.path) === pathKey,
        );
        if (!project) return;
        const operationId = workspaceDropSequenceRef.current + 1;
        workspaceDropSequenceRef.current = operationId;
        pendingWorkspaceDropRef.current = { operationId, projectPathKey: pathKey };
        void commitWorkspaceDropConversation({
          revision: commit.revision,
          target,
          project: { projectId: project.id, projectPathKey: pathKey },
          startConversation: () => startConversationForProjectRef.current(project),
          currentRevision: () => workbench.layoutRef.current.revision,
          conversationMatchesProject: (conversationId) => {
            const workdir = conversationWorkdirForRef.current(conversationId)?.trim() || "";
            return Boolean(workdir) && workspaceProjectPathKey(workdir) === pathKey;
          },
          paneIdForConversation: workbench.paneIdForConversation,
          openConversation: workbench.openConversation,
        }).then((result) => {
          if (pendingWorkspaceDropRef.current?.operationId === operationId) {
            pendingWorkspaceDropRef.current = null;
          }
          if (result.kind === "opened" || result.kind === "not-created") return;
          if (result.kind === "already-open") {
            const paneId = workbench.paneIdForConversation(result.conversationId);
            if (paneId) handleFocusPane(paneId);
            return;
          }
          workbench.syncCurrentConversation(result.conversationId, {
            projectId: project.id,
            projectPathKey: pathKey,
          });
          if (result.kind !== "rejected") onDropStateChanged();
        });
        return;
      }
      if (payload.kind === "conversation") {
        const existingPaneId = workbench.paneIdForConversation(payload.conversationId);
        if (target.kind === "pane-center") {
          // 拖拽会话已归一化:pane-center 只可能是会话自己的 Pane,语义是聚焦。
          if (existingPaneId && target.paneId === existingPaneId) {
            handleFocusPane(existingPaneId);
            onConversationAlreadyOpen();
          }
          return;
        }
        if (existingPaneId) {
          if (target.kind === "canvas-empty") return;
          if (
            workbench.movePane(existingPaneId, target) &&
            payload.conversationId !== displayedConversationId
          ) {
            selectWorkbenchConversation(payload.conversationId);
          }
          return;
        }
        const opened = workbench.openConversation(
          { conversationId: payload.conversationId, project: payload.project },
          target,
        );
        if (opened && payload.conversationId !== displayedConversationId) {
          selectWorkbenchConversation(payload.conversationId);
        }
        return;
      }
      if (payload.kind === "terminalSession" || payload.kind === "newTerminal") {
        commitTerminalDrop(payload, target, terminalDropDeps());
        return;
      }
      if (payload.kind === "fileTree") {
        const existingPaneId = findPaneIdBySurfaceKey(
          workbench.layoutRef.current,
          `fileTree:${payload.project.projectPathKey}`,
        );
        if (target.kind === "pane-center") {
          if (existingPaneId && target.paneId === existingPaneId) handleFocusPane(existingPaneId);
          return;
        }
        if (existingPaneId) {
          if (target.kind !== "canvas-empty") workbench.movePane(existingPaneId, target);
          return;
        }
        workbench.openFileTreeSurface({ kind: "fileTree", project: payload.project }, target);
        return;
      }
      // Pane 头部拖动重排。
      if (target.kind === "canvas-empty") return;
      if (target.kind === "pane-center" && target.paneId === payload.paneId) return;
      if (workbench.movePane(payload.paneId, target)) {
        const pane = workbench.layoutRef.current.panes[payload.paneId];
        // 只有会话 Pane 驱动页面当前会话;终端 Pane 移动不改选中。
        if (
          pane?.surface.kind === "conversation" &&
          pane.surface.conversationId !== displayedConversationId
        ) {
          selectWorkbenchConversation(pane.surface.conversationId);
        }
      }
    },
    [
      archivedProjectPathKeys,
      displayedConversationId,
      handleFocusPane,
      onConversationAlreadyOpen,
      onDropStateChanged,
      selectWorkbenchConversation,
      terminalDropDeps,
      workbench,
    ],
  );

  const { dragState, beginDrag } = useWorkbenchDragSession({
    enabled,
    layoutRef: workbench.layoutRef,
    geometryRef,
    onCommit: handleDropCommit,
    onUnavailable: (reason: WorkbenchDragUnavailableReason) => {
      if (reason === "geometry-unavailable") onDropStateChanged();
      else onNoSpaceForSplit();
    },
  });

  const beginPaneDrag = useCallback(
    (
      pane: PaneRecord,
      title: string,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      beginDrag(
        {
          kind: "pane",
          paneId: pane.paneId,
          surfaceKey: surfaceIdentityKey(pane.surface),
          title,
        },
        event,
      );
    },
    [beginDrag],
  );

  const handleConversationDragIntent = useCallback(
    (
      item: SidebarConversation,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      beginDrag(
        {
          kind: "conversation",
          conversationId: item.id,
          project: projectRefForConversationRef.current(item),
          title: item.title,
        },
        event,
      );
    },
    [beginDrag],
  );

  const handleProjectDragIntent = useCallback(
    (
      project: WorkspaceProject,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      beginDrag(
        {
          kind: "workspace",
          projectId: project.id,
          projectPath: project.path,
          title: project.name,
        },
        event,
      );
    },
    [beginDrag],
  );

  // Right Dock 终端 tab 拖出:既有会话进入画布。
  const handleTerminalTabDragIntent = useCallback(
    (
      session: TerminalSession,
      event: {
        pointerId: number;
        clientX: number;
        clientY: number;
        currentTarget?: EventTarget | null;
      },
    ) => {
      const projectPathKey = session.projectPathKey || workspaceProjectPathKey(session.cwd);
      const project = workspaceProjectsRef.current.find(
        (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
      );
      beginDrag(
        {
          kind: "terminalSession",
          sessionId: session.id,
          project: {
            projectId: project?.id ?? `terminal:${session.id}`,
            projectPathKey,
          },
          title: session.title || session.shell || "Terminal",
        },
        event,
      );
    },
    [beginDrag],
  );

  // 「新建终端」按钮拖出:落点新建终端 Pane(几何先行,PTY 由宿主异步建)。
  const handleNewTerminalDragIntent = useCallback(
    (event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    }) => {
      const path = terminalProjectPath.trim();
      if (!path) return;
      const pathKey = workspaceProjectPathKey(path);
      const project = workspaceProjectsRef.current.find(
        (entry) => workspaceProjectPathKey(entry.path) === pathKey,
      );
      beginDrag(
        {
          kind: "newTerminal",
          project: {
            projectId: project?.id ?? `project:${pathKey}`,
            projectPathKey: pathKey,
          },
          title: newTerminalTitle,
        },
        event,
      );
    },
    [beginDrag, newTerminalTitle, terminalProjectPath],
  );

  const fileTreeProjectRef = useCallback((): ProjectRef | null => {
    const path = terminalProjectPath.trim();
    if (!path) return null;
    const projectPathKey = workspaceProjectPathKey(path);
    const project = workspaceProjectsRef.current.find(
      (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
    );
    return {
      projectId: project?.id ?? `project:${projectPathKey}`,
      projectPathKey,
    };
  }, [terminalProjectPath]);

  const handleFileTreeTabDragIntent = useCallback(
    (event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    }) => {
      const project = fileTreeProjectRef();
      if (!project) return;
      beginDrag({ kind: "fileTree", project, title: "File Tree" }, event);
    },
    [beginDrag, fileTreeProjectRef],
  );

  // 同一提交通路的菜单入口:终端 tab 无需拖拽也能进工作台。已租用的会话
  // 由 commitTerminalDrop 自己走「移动既有 Pane」,不会二次开 Pane。
  const handleOpenTerminalInSplit = useCallback(
    (session: TerminalSession) => {
      const target = resolveAutoDockTarget();
      if (!target) {
        onNoSpaceForSplit();
        return;
      }
      const projectPathKey = session.projectPathKey || workspaceProjectPathKey(session.cwd);
      const project = workspaceProjectsRef.current.find(
        (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
      );
      commitTerminalDrop(
        {
          kind: "terminalSession",
          sessionId: session.id,
          project: {
            projectId: project?.id ?? `terminal:${session.id}`,
            projectPathKey,
          },
          title: session.title || session.shell || "Terminal",
        },
        target,
        terminalDropDeps(),
      );
    },
    [onNoSpaceForSplit, resolveAutoDockTarget, terminalDropDeps],
  );

  const handleOpenFileTreeInSplit = useCallback(() => {
    const project = fileTreeProjectRef();
    if (!project) return;
    const existingPaneId = findPaneIdBySurfaceKey(
      workbench.layoutRef.current,
      `fileTree:${project.projectPathKey}`,
    );
    if (existingPaneId) {
      handleFocusPane(existingPaneId);
      return;
    }
    const target = resolveAutoDockTarget();
    if (!target) {
      onNoSpaceForSplit();
      return;
    }
    workbench.openFileTreeSurface({ kind: "fileTree", project }, target);
  }, [fileTreeProjectRef, handleFocusPane, onNoSpaceForSplit, resolveAutoDockTarget, workbench]);

  const handleOpenNewTerminalInSplit = useCallback(() => {
    const target = resolveAutoDockTarget();
    if (!target) {
      onNoSpaceForSplit();
      return;
    }
    const path = terminalProjectPath.trim();
    if (!path) return;
    const projectPathKey = workspaceProjectPathKey(path);
    const project = workspaceProjectsRef.current.find(
      (entry) => workspaceProjectPathKey(entry.path) === projectPathKey,
    );
    commitTerminalDrop(
      {
        kind: "newTerminal",
        project: {
          projectId: project?.id ?? `project:${projectPathKey}`,
          projectPathKey,
        },
        title: newTerminalTitle,
      },
      target,
      terminalDropDeps(),
    );
  }, [
    newTerminalTitle,
    onNoSpaceForSplit,
    resolveAutoDockTarget,
    terminalDropDeps,
    terminalProjectPath,
  ]);

  // 画板 Pane 持有租约的会话:overlay/占位的「前往 Pane」聚焦通路。
  const focusTerminalPaneForSession = useCallback(
    (sessionId: string) => {
      const paneId = gatewayTerminalPaneLease.paneIdFor(sessionId);
      if (paneId && workbench.layoutRef.current.panes[paneId]) {
        handleFocusPane(paneId);
      }
    },
    [handleFocusPane, workbench],
  );

  // 被画布 Pane 租用的会话从 Right Dock 的终端 tab 中隐藏(终端任一时刻只
  // 出现在一个宿主里);Pane 关闭(Detach)释放租约后自动回归 dock。
  const leasedDockSessionIds = useSyncExternalStore(
    gatewayTerminalPaneLease.subscribe,
    gatewayTerminalPaneLease.leasedSessionIds,
  );

  // 会话被删除：只收布局，不迁移选中（displayed 选中迁移由既有移除通路负责，
  // 之后 syncCurrentConversation 会把聚焦 Pane 重新绑定到新的当前会话）。
  const closePanesForRemovedConversations = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) {
        const paneId = workbench.paneIdForConversation(id);
        if (paneId) workbench.closePane(paneId);
      }
    },
    [workbench],
  );

  const clearWorkbench = useCallback(() => {
    for (const pane of Object.values(workbench.layoutRef.current.panes)) {
      if (pane.surface.kind === "localTerminal" || pane.surface.kind === "sshTerminal") {
        gatewayTerminalPaneBindings.delete(pane.surface.surfaceId);
      }
    }
    workbench.clear();
  }, [workbench]);

  return useMemo(
    () => ({
      workbench,
      geometryRef,
      handleGeometryChange,
      handleFocusPane,
      handleClosePane,
      handleOpenConversationInSplit,
      handleOpenTerminalInSplit,
      handleOpenFileTreeInSplit,
      handleOpenNewTerminalInSplit,
      focusTerminalPaneForSession,
      closePanesForRemovedConversations,
      clearWorkbench,
      projectRefForConversation,
      dragState,
      beginPaneDrag,
      handleConversationDragIntent,
      handleProjectDragIntent,
      handleTerminalTabDragIntent,
      handleNewTerminalDragIntent,
      handleFileTreeTabDragIntent,
      leasedDockSessionIds,
    }),
    [
      workbench,
      handleGeometryChange,
      handleFocusPane,
      handleClosePane,
      handleOpenConversationInSplit,
      handleOpenTerminalInSplit,
      handleOpenFileTreeInSplit,
      handleOpenNewTerminalInSplit,
      focusTerminalPaneForSession,
      closePanesForRemovedConversations,
      clearWorkbench,
      projectRefForConversation,
      dragState,
      beginPaneDrag,
      handleConversationDragIntent,
      handleProjectDragIntent,
      handleTerminalTabDragIntent,
      handleNewTerminalDragIntent,
      handleFileTreeTabDragIntent,
      leasedDockSessionIds,
    ],
  );
}
