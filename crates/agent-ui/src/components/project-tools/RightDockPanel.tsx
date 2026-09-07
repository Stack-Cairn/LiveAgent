import {
  closeRightDockBackgroundTasksTabState,
  openRightDockBackgroundTasksTabState,
  type RightDockBackgroundTasksState,
  type RightDockFileTreeState,
  type RightDockFileTreeStatePatch,
  type RightDockProjectState,
  type SshHostConfig,
  type WorkspaceProject,
} from "@liveagent/app/lib/settings";
import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { X } from "@liveagent/ui/components/IconSet";
import type {
  GitCommitContextPayload,
  GitFileContextPayload,
} from "@liveagent/ui/components/project-tools/git-review/index";
import type { WorkspaceProjectRootClient } from "@liveagent/ui/contracts/workspaceProjectRoots";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import {
  type CSSProperties,
  memo,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectToolTextGenerationClient } from "../../lib/ai/projectToolTextGeneration";
import { ensureManagedProcessInit, useManagedProcesses } from "../../lib/managed-process/store";
import { cn } from "../../lib/shared/utils";
import type { TerminalClient, TerminalSession } from "../../lib/terminal/types";
import type { WorkspaceActivityClient } from "../../lib/workspace-activity/types";
import { Button } from "../ui/button";
import { useFileTreeExternalRoots } from "./file-tree/useFileTreeExternalRoots";
import type { LocalTunnelClient } from "./LocalTunnelPanel";
import { RightDockContent } from "./RightDockContent";
import {
  type GitReviewFocusRequest,
  RightDockToolContext,
  type RightDockToolContextValue,
} from "./RightDockContext";
import { RightDockChooser, RightDockCreateMenu } from "./RightDockLauncher";
import { RightDockTabStrip } from "./RightDockTabStrip";
import {
  dirname,
  expandedPathsForFileTreePath,
  formatTerminalSessionTitle,
  NO_LEASED_RIGHT_DOCK_TOOLS,
  type RightDockLeasedToolKind,
  type RightDockSingletonTabKind,
  rightDockTabRequiresProject,
} from "./rightDockModel";
import { useRightDockPanelWidth } from "./useRightDockPanelWidth";
import { useRightDockProjectTabs } from "./useRightDockProjectTabs";
import { useRightDockSessions } from "./useRightDockSessions";
import { useRightDockTabReorder } from "./useRightDockTabReorder";

type RightDockPanelProps = {
  isOpen: boolean;
  collapseImmediately?: boolean;
  fontScale?: number;
  projectPathKey: string;
  cwd: string;
  workspaceProject?: WorkspaceProject;
  workspaceProjectRootClient?: WorkspaceProjectRootClient;
  workspaceRootRevision?: number;
  sessions?: TerminalSession[];
  sessionsLoaded?: boolean;
  /**
   * 被工作台 Pane 租用的会话:tab 保留并标记,视口换成"聚焦面板"占位。
   * 视口互斥(绝不同时挂两个 XTermViewport)是这里唯一的硬不变量。
   */
  leasedSessionIds?: ReadonlySet<string>;
  /**
   * 被工作台 Pane 租用的项目工具(文件树/审查/内网穿透/SSH/后台任务):
   * dock 不再挂其 tab、内容与新建入口;Pane 关闭后自动回归。
   */
  leasedTools?: ReadonlySet<RightDockLeasedToolKind>;
  width: number;
  theme: "light" | "dark";
  disabledMessage?: string;
  terminalDisabledMessage?: string;
  projectState: RightDockProjectState;
  fileTreeState: RightDockFileTreeState;
  sshHosts?: SshHostConfig[];
  associatedSshHostIds?: string[];
  client: TerminalClient;
  gitClient?: GitClient | null;
  gitWriteEnabled?: boolean;
  gitDisabledMessage?: string;
  textGenerationClient?: ProjectToolTextGenerationClient | null;
  tunnelClient?: LocalTunnelClient | null;
  tunnelEnabled?: boolean;
  tunnelDisabledMessage?: string;
  tunnelPublicBaseUrl: string;
  workspaceActivityClient?: WorkspaceActivityClient | null;
  onWidthChange: (width: number) => void;
  onProjectStateChange: (
    updater: (current: RightDockProjectState) => RightDockProjectState,
  ) => void;
  onFileTreeStateChange: (patch: RightDockFileTreeStatePatch) => void;
  onSshProjectHostIdsChange?: (hostIds: string[]) => void;
  onOpenSshSession?: (session: TerminalSession, kind?: "bash" | "sftp") => void;
  onSessionsChange?: (sessions: TerminalSession[]) => void;
  /** 存在时终端 tab 可拖出 dock(工作台宿主);默认无行为。 */
  onTerminalTabDragStart?: (
    session: TerminalSession,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** 存在时空态"新建终端"入口可拖出到工作台画板;点击行为不变。 */
  onNewTerminalDragStart?: (event: {
    pointerId: number;
    clientX: number;
    clientY: number;
    currentTarget?: EventTarget | null;
  }) => void;
  /** 终端 tab 右键菜单「在工作台打开」;省略时菜单不出现(拖拽仍可用)。 */
  onOpenTerminalInWorkbench?: (session: TerminalSession) => void;
  /** 项目工具 tab / 空态入口拖出到 Workbench(落点打开该工具 Pane)。 */
  onToolDragStart?: (
    kind: RightDockLeasedToolKind,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** 项目工具 tab 菜单式“在分屏中打开”。 */
  onOpenToolInWorkbench?: (kind: RightDockLeasedToolKind) => void;
  /** 新建菜单「在分屏中新建终端」;与拖拽 newTerminal 走同一提交语义。 */
  onOpenNewTerminalInWorkbench?: () => void;
  /**
   * dock 视口报错时上抛 sessionId,由宿主按后端权威列表校验:会话确认
   * 消失(幽灵记录)则整表刷新,坏 tab 自动退场;仍存活的瞬时错误不动列表。
   */
  onSessionGhost?: (sessionId: string) => void;
  onInsertFileMention?: (path: string, kind: "file" | "dir") => void;
  onOpenFile?: (path: string, imagePaths?: string[]) => void;
  onInsertCodeReviewSkill?: () => void;
  onInsertCommitMention?: (commit: GitCommitContextPayload) => void;
  onInsertGitFileMention?: (file: GitFileContextPayload) => void;
  gitReviewFocusRequest?: GitReviewFocusRequest | null;
  onGitReviewFocusRequestHandled?: (nonce: number) => void;
  onClose?: () => void;
};

type RightDockTabsScrollbarState = {
  visible: boolean;
  thumbLeft: number;
  thumbWidth: number;
};

type RightDockTabsScrollbarDragState = {
  pointerId: number;
  startScrollLeft: number;
  startX: number;
};

const RIGHT_DOCK_TABS_SCROLLBAR_MIN_THUMB_WIDTH = 28;

// Stable fallbacks for optional array props: fresh `[]` defaults would defeat
// both the panel memo and the context useMemo below.
const NO_SSH_HOSTS: SshHostConfig[] = [];
const NO_ASSOCIATED_SSH_HOST_IDS: string[] = [];

function RightDockTabsScrollbar(props: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const { scrollRef } = props;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<RightDockTabsScrollbarDragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scrollbar, setScrollbar] = useState<RightDockTabsScrollbarState>({
    visible: false,
    thumbLeft: 0,
    thumbWidth: RIGHT_DOCK_TABS_SCROLLBAR_MIN_THUMB_WIDTH,
  });

  const updateScrollbar = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      setScrollbar((current) =>
        current.visible
          ? {
              visible: false,
              thumbLeft: 0,
              thumbWidth: RIGHT_DOCK_TABS_SCROLLBAR_MIN_THUMB_WIDTH,
            }
          : current,
      );
      return;
    }

    const maxScrollLeft = element.scrollWidth - element.clientWidth;
    if (maxScrollLeft <= 1 || element.clientWidth <= 0 || element.scrollWidth <= 0) {
      setScrollbar((current) =>
        current.visible
          ? {
              visible: false,
              thumbLeft: 0,
              thumbWidth: RIGHT_DOCK_TABS_SCROLLBAR_MIN_THUMB_WIDTH,
            }
          : current,
      );
      return;
    }

    const trackWidth = element.clientWidth;
    const thumbWidth = Math.min(
      trackWidth,
      Math.max(
        RIGHT_DOCK_TABS_SCROLLBAR_MIN_THUMB_WIDTH,
        (element.clientWidth / element.scrollWidth) * trackWidth,
      ),
    );
    const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
    const thumbLeft = maxScrollLeft > 0 ? (element.scrollLeft / maxScrollLeft) * maxThumbLeft : 0;
    const nextScrollbar = {
      visible: true,
      thumbLeft,
      thumbWidth,
    };

    setScrollbar((current) => {
      if (
        current.visible === nextScrollbar.visible &&
        Math.abs(current.thumbLeft - nextScrollbar.thumbLeft) < 0.5 &&
        Math.abs(current.thumbWidth - nextScrollbar.thumbWidth) < 0.5
      ) {
        return current;
      }
      return nextScrollbar;
    });
  }, [scrollRef]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      updateScrollbar();
      return;
    }

    let animationFrame = 0;
    const scheduleUpdate = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateScrollbar);
    };

    scheduleUpdate();
    element.addEventListener("scroll", updateScrollbar, { passive: true });
    window.addEventListener("resize", scheduleUpdate);

    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(element);
    for (const child of Array.from(element.children)) {
      resizeObserver.observe(child);
    }

    const mutationObserver = new MutationObserver(scheduleUpdate);
    mutationObserver.observe(element, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      element.removeEventListener("scroll", updateScrollbar);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [scrollRef, updateScrollbar]);

  const scrollToThumbLeft = useCallback(
    (thumbLeft: number) => {
      const element = scrollRef.current;
      const track = trackRef.current;
      if (!element || !track) return;

      const maxScrollLeft = element.scrollWidth - element.clientWidth;
      const maxThumbLeft = Math.max(0, track.clientWidth - scrollbar.thumbWidth);
      if (maxScrollLeft <= 0 || maxThumbLeft <= 0) return;

      element.scrollLeft = (thumbLeft / maxThumbLeft) * maxScrollLeft;
    },
    [scrollRef, scrollbar.thumbWidth],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!scrollbar.visible || event.button !== 0) return;

      const element = scrollRef.current;
      const track = trackRef.current;
      if (!element || !track) return;

      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);

      const target = event.target;
      const isThumb =
        target instanceof HTMLElement &&
        target.closest(".project-tools-panel-tabs-scrollbar-thumb") !== null;

      if (!isThumb) {
        const rect = track.getBoundingClientRect();
        const maxThumbLeft = Math.max(0, track.clientWidth - scrollbar.thumbWidth);
        const nextThumbLeft = Math.min(
          maxThumbLeft,
          Math.max(0, event.clientX - rect.left - scrollbar.thumbWidth / 2),
        );
        scrollToThumbLeft(nextThumbLeft);
      }

      dragStateRef.current = {
        pointerId: event.pointerId,
        startScrollLeft: element.scrollLeft,
        startX: event.clientX,
      };
      setDragging(true);
      updateScrollbar();
    },
    [scrollRef, scrollToThumbLeft, scrollbar.thumbWidth, scrollbar.visible, updateScrollbar],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      const element = scrollRef.current;
      const track = trackRef.current;
      if (!element || !track) return;

      event.preventDefault();
      const maxScrollLeft = element.scrollWidth - element.clientWidth;
      const maxThumbLeft = Math.max(1, track.clientWidth - scrollbar.thumbWidth);
      const scrollDelta = ((event.clientX - dragState.startX) / maxThumbLeft) * maxScrollLeft;
      element.scrollLeft = Math.min(
        maxScrollLeft,
        Math.max(0, dragState.startScrollLeft + scrollDelta),
      );
    },
    [scrollRef, scrollbar.thumbWidth],
  );

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  }, []);

  return (
    <div
      ref={trackRef}
      aria-hidden={!scrollbar.visible}
      className={cn(
        "project-tools-panel-tabs-scrollbar",
        scrollbar.visible && "project-tools-panel-tabs-scrollbar-visible",
        dragging && "project-tools-panel-tabs-scrollbar-dragging",
      )}
      onPointerCancel={finishDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
    >
      <div
        className="project-tools-panel-tabs-scrollbar-thumb"
        style={{
          transform: `translateX(${scrollbar.thumbLeft}px)`,
          width: `${scrollbar.thumbWidth}px`,
        }}
      />
    </div>
  );
}

export const RightDockPanel = memo(function RightDockPanel(props: RightDockPanelProps) {
  const {
    isOpen,
    collapseImmediately = false,
    fontScale = 1,
    projectPathKey,
    cwd,
    workspaceProject,
    workspaceProjectRootClient,
    workspaceRootRevision = 0,
    sessions: externalSessions,
    sessionsLoaded: externalSessionsLoaded,
    leasedSessionIds,
    leasedTools = NO_LEASED_RIGHT_DOCK_TOOLS,
    width,
    theme,
    disabledMessage,
    terminalDisabledMessage,
    projectState,
    fileTreeState,
    sshHosts = NO_SSH_HOSTS,
    associatedSshHostIds = NO_ASSOCIATED_SSH_HOST_IDS,
    client,
    gitClient,
    gitWriteEnabled = true,
    gitDisabledMessage,
    textGenerationClient,
    tunnelClient,
    tunnelEnabled = true,
    tunnelDisabledMessage,
    tunnelPublicBaseUrl,
    workspaceActivityClient,
    onWidthChange,
    onProjectStateChange,
    onFileTreeStateChange,
    onSshProjectHostIdsChange,
    onOpenSshSession,
    onSessionsChange,
    onTerminalTabDragStart,
    onNewTerminalDragStart,
    onOpenTerminalInWorkbench,
    onToolDragStart,
    onOpenToolInWorkbench,
    onOpenNewTerminalInWorkbench,
    onSessionGhost,
    onInsertFileMention,
    onOpenFile,
    onInsertCodeReviewSkill,
    onInsertCommitMention,
    onInsertGitFileMention,
    gitReviewFocusRequest,
    onGitReviewFocusRequestHandled,
    onClose,
  } = props;
  const { t } = useLocale();
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const { externalRoots: visibleExternalFileTreeRoots, refreshExternalRoots } =
    useFileTreeExternalRoots({
      workspaceProject,
      workspaceProjectRootClient,
      workspaceRootRevision,
    });
  const {
    effectiveShouldRenderContent,
    effectiveWidthCollapsed,
    handleResizeStart,
    isResizing,
    panelRef,
    panelStyle,
  } = useRightDockPanelWidth({
    collapseImmediately,
    isOpen,
    onWidthChange,
    width,
  });
  const projectReady = projectPathKey.trim() !== "" && cwd.trim() !== "" && !disabledMessage;
  const terminalReady = projectReady && !terminalDisabledMessage;
  const {
    activateTerminalSession,
    activeSession,
    clearPendingCloseSession,
    closeSession,
    closingSessionIds,
    createTerminal,
    creating,
    error,
    forgetTerminalSession,
    handleCloseRequest,
    handleInitialTerminalSnapshotConsumed,
    initialTerminalSnapshotsRef,
    loading,
    localSessions,
    pendingCloseSession,
    pendingCloseSessionId,
    reconcileSshSessions,
    rememberTerminalSnapshot,
    sessionsLoaded,
    shellOptions,
    sshSessions,
  } = useRightDockSessions({
    client,
    cwd,
    externalSessions,
    externalSessionsLoaded,
    leasedSessionIds,
    isOpen,
    onProjectStateChange,
    onSessionsChange,
    projectPathKey,
    projectState,
    terminalReady,
  });
  // Terminal stream errors are bucketed per session so one session's attach
  // failure or input backpressure never masks (or clears) another's; the
  // hook-level `error` stays reserved for list/create failures.
  const [terminalErrors, setTerminalErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const handleTerminalError = useCallback(
    (sessionId: string, message: string | null) => {
      setTerminalErrors((current) => {
        const existing = current.get(sessionId);
        if (message === null) {
          if (existing === undefined) return current;
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        }
        if (existing === message) return current;
        const next = new Map(current);
        next.set(sessionId, message);
        return next;
      });
      // attach 持续失败最常见的根因是幽灵会话(后端已丢、前端列表还在)。
      // 上抛给宿主做权威校验;瞬时错误在校验中会被识别为仍存活而不动列表。
      if (message) onSessionGhost?.(sessionId);
    },
    [onSessionGhost],
  );

  useEffect(() => {
    // Closed/forgotten sessions leave the live list; drop their error buckets.
    setTerminalErrors((current) => {
      if (current.size === 0) return current;
      const liveIds = new Set(localSessions.map((session) => session.id));
      let changed = false;
      const next = new Map<string, string>();
      for (const [sessionId, message] of current) {
        if (liveIds.has(sessionId)) {
          next.set(sessionId, message);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [localSessions]);

  const activeTerminalError = activeSession ? (terminalErrors.get(activeSession.id) ?? null) : null;

  const managedProcessState = useManagedProcesses();
  useEffect(() => {
    ensureManagedProcessInit().catch((error) => {
      console.error("managed process init failed", error);
    });
  }, []);
  // Visibility intent lives in the synced right-dock project state so that
  // opening/closing the tab on one client mirrors to the others. Closing is
  // hide-only — it snapshots the current task ids and touches no process
  // state; a task id outside that snapshot (a newly started one) re-derives
  // the tab everywhere. Without a project bucket to persist into (no
  // projectPathKey), a session-local fallback keeps the launcher working.
  const [localBackgroundTasks, setLocalBackgroundTasks] = useState<RightDockBackgroundTasksState>({
    opened: false,
    dismissedIds: [],
  });
  const backgroundTasksState = projectPathKey ? projectState.backgroundTasks : localBackgroundTasks;
  const backgroundTasksVisible =
    backgroundTasksState.opened ||
    managedProcessState.processes.some(
      (process) => !backgroundTasksState.dismissedIds.includes(process.id),
    );
  const backgroundTasksRunning = managedProcessState.processes.filter(
    (process) => process.running,
  ).length;

  const tunnelAvailable = Boolean(tunnelClient);
  const {
    activateTab,
    canReorderTabs,
    closeToolTab,
    commitTabOrder,
    currentActiveTab,
    fileTreeInitialized,
    gitReviewInitialized,
    openSingletonTab,
    orderedProjectTabIds,
    orderedProjectTabs,
    setDraftTabOrder,
    sshTunnelInitialized,
    tunnelInitialized,
  } = useRightDockProjectTabs({
    backgroundTasksVisible,
    leasedTools,
    localSessions,
    onProjectStateChange,
    projectPathKey,
    projectState,
    sessionsLoaded,
    tunnelAvailable,
  });

  const handleCreate = useCallback(() => {
    createTerminal();
  }, [createTerminal]);

  const openBackgroundTasks = useCallback(() => {
    if (projectPathKey) {
      onProjectStateChange(openRightDockBackgroundTasksTabState);
      return;
    }
    // No project bucket: persisted writes (including tab activation) are
    // no-ops, so only the session-local visibility flips.
    setLocalBackgroundTasks({ opened: true, dismissedIds: [] });
  }, [onProjectStateChange, projectPathKey]);

  const closeBackgroundTasks = useCallback(() => {
    // Hide-only; the persisted activeTabId falls back at render time.
    const visibleIds = managedProcessState.processes.map((process) => process.id);
    if (projectPathKey) {
      onProjectStateChange((current) => closeRightDockBackgroundTasksTabState(current, visibleIds));
      return;
    }
    setLocalBackgroundTasks({ opened: false, dismissedIds: visibleIds });
  }, [managedProcessState.processes, onProjectStateChange, projectPathKey]);

  const {
    consumeSuppressedTabClick,
    draggingTabId,
    getTabDragProps,
    getTabDragStyle,
    renderTabDragHandle,
    tabsScrollRef,
  } = useRightDockTabReorder({
    canReorderTabs,
    onCommitTabOrder: commitTabOrder,
    onDraftTabOrderChange: setDraftTabOrder,
    orderedTabIds: orderedProjectTabIds,
    projectPathKey,
    reorderHint: t("projectTools.reorderTabHint"),
    reorderLabel: t("projectTools.reorderTab"),
  });

  const handleTabsWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.deltaY === 0 ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      ) {
        return;
      }

      const element = tabsScrollRef.current;
      if (!element) return;

      const maxScrollLeft = element.scrollWidth - element.clientWidth;
      if (maxScrollLeft <= 0) return;

      const deltaScale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      const nextScrollLeft = Math.min(
        maxScrollLeft,
        Math.max(0, element.scrollLeft + event.deltaY * deltaScale),
      );
      if (Math.abs(nextScrollLeft - element.scrollLeft) < 0.5) return;

      event.preventDefault();
      element.scrollLeft = nextScrollLeft;
    },
    [tabsScrollRef],
  );

  const showDisabledMessage = Boolean(
    disabledMessage && !tunnelAvailable && !tunnelInitialized && !sshTunnelInitialized,
  );
  const showRightDockChooser =
    !showDisabledMessage &&
    (projectReady || tunnelAvailable) &&
    currentActiveTab === "terminal" &&
    !activeSession;

  const startToolTab = useCallback(
    (kind: RightDockSingletonTabKind) => {
      if (leasedTools.has(kind)) return;
      if (rightDockTabRequiresProject(kind)) {
        if (!projectReady) return;
      } else if (!tunnelClient) {
        return;
      }
      openSingletonTab(kind);
    },
    [leasedTools, openSingletonTab, projectReady, tunnelClient],
  );

  const setFileTreeInitialized = useCallback(
    (initialized: boolean) => {
      if (!projectPathKey) return;
      if (initialized) {
        startToolTab("fileTree");
      } else {
        closeToolTab("fileTree");
      }
    },
    [closeToolTab, projectPathKey, startToolTab],
  );

  const revealPathInFileTree = useCallback(
    (path: string) => {
      const normalizedPath = path
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      if (!projectReady) return;
      const selectedPath = normalizedPath.endsWith("/") ? dirname(normalizedPath) : normalizedPath;
      const expandedPaths = Array.from(
        new Set([...fileTreeState.expandedPaths, ...expandedPathsForFileTreePath(selectedPath)]),
      );
      startToolTab("fileTree");
      onFileTreeStateChange({
        query: "",
        selectedPath,
        expandedPaths,
        bumpRevision: true,
      });
    },
    [fileTreeState.expandedPaths, onFileTreeStateChange, projectReady, startToolTab],
  );

  const openExternal = useCallback((url: string) => {
    void openUrl(url);
  }, []);

  const toolContextValue = useMemo<RightDockToolContextValue>(
    () => ({
      projectPathKey,
      cwd,
      theme,
      clients: {
        terminal: client,
        git: gitClient,
        textGeneration: textGenerationClient,
        tunnel: tunnelClient,
        workspaceActivity: workspaceActivityClient,
      },
      capabilities: {
        projectReady,
        terminalReady,
        disabledMessage,
        terminalDisabledMessage,
        gitWriteEnabled,
        gitDisabledMessage,
        tunnelEnabled,
        tunnelDisabledMessage,
        tunnelPublicBaseUrl,
      },
      fileTree: {
        state: fileTreeState,
        initialized: fileTreeInitialized,
        externalRoots: visibleExternalFileTreeRoots,
        refreshExternalRoots,
        onInitializedChange: setFileTreeInitialized,
        onStateChange: onFileTreeStateChange,
        onInsertFileMention,
        onOpenFile,
        onRevealInFileTree: revealPathInFileTree,
      },
      git: {
        onInsertCodeReviewSkill,
        onInsertCommitMention,
        onInsertGitFileMention,
        focusRequest: gitReviewFocusRequest,
        onFocusRequestHandled: onGitReviewFocusRequestHandled,
      },
      ssh: {
        hosts: sshHosts,
        associatedHostIds: associatedSshHostIds,
        sessions: sshSessions,
        onOpenSession: onOpenSshSession,
        onAssociatedHostIdsChange: onSshProjectHostIdsChange,
        onSessionSnapshot: rememberTerminalSnapshot,
        onSessionClosed: forgetTerminalSession,
        onSessionsReconcile: reconcileSshSessions,
      },
      openExternal,
    }),
    [
      associatedSshHostIds,
      client,
      cwd,
      disabledMessage,
      visibleExternalFileTreeRoots,
      fileTreeInitialized,
      fileTreeState,
      forgetTerminalSession,
      gitClient,
      gitDisabledMessage,
      gitReviewFocusRequest,
      gitWriteEnabled,
      onFileTreeStateChange,
      onGitReviewFocusRequestHandled,
      onInsertCodeReviewSkill,
      onInsertCommitMention,
      onInsertFileMention,
      onInsertGitFileMention,
      onOpenFile,
      onOpenSshSession,
      onSshProjectHostIdsChange,
      openExternal,
      projectPathKey,
      projectReady,
      reconcileSshSessions,
      rememberTerminalSnapshot,
      refreshExternalRoots,
      revealPathInFileTree,
      setFileTreeInitialized,
      sshHosts,
      sshSessions,
      terminalDisabledMessage,
      terminalReady,
      textGenerationClient,
      theme,
      tunnelClient,
      tunnelDisabledMessage,
      tunnelEnabled,
      tunnelPublicBaseUrl,
      workspaceActivityClient,
    ],
  );

  const initializedTools = useMemo<Record<RightDockSingletonTabKind, boolean>>(
    () => ({
      fileTree: fileTreeInitialized,
      gitReview: gitReviewInitialized,
      tunnel: tunnelInitialized,
      sshTunnel: sshTunnelInitialized,
    }),
    [fileTreeInitialized, gitReviewInitialized, sshTunnelInitialized, tunnelInitialized],
  );

  return (
    <RightDockToolContext.Provider value={toolContextValue}>
      <aside
        ref={panelRef}
        aria-hidden={!isOpen}
        inert={!isOpen}
        data-app-frame-column="right-dock"
        data-state={isOpen ? "open" : "closed"}
        data-project-tools-resizing={isResizing ? "true" : undefined}
        className={cn(
          "project-tools-panel zone-font-scale fixed inset-x-0 bottom-0 z-40 flex h-[min(72vh,34rem)] min-h-0 w-full shrink-0 flex-col overflow-hidden bg-background shadow-2xl transition-[width,opacity,transform] duration-200 ease-out motion-reduce:transition-none md:relative md:inset-auto md:z-10 md:h-full md:overflow-visible md:shadow-none",
          isOpen
            ? "pointer-events-auto translate-y-0 border-t border-border opacity-100 md:w-[var(--project-tools-panel-width)] md:translate-x-0 md:border-l md:border-t-0"
            : "pointer-events-none translate-y-full border-t border-transparent opacity-0 md:translate-x-3 md:translate-y-0 md:border-l-0 md:border-t-0",
          effectiveWidthCollapsed ? "md:w-0" : "md:w-[var(--project-tools-panel-width)]",
          (isResizing || (collapseImmediately && !isOpen)) && "md:transition-none",
        )}
        style={{ ...panelStyle, "--zone-font-scale": fontScale } as CSSProperties}
      >
        <div
          className={cn(
            "project-tools-panel-inner flex h-full min-h-0 w-full flex-col transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none md:w-[var(--project-tools-panel-width)] md:min-w-[var(--project-tools-panel-width)]",
            isOpen
              ? "translate-y-0 opacity-100 md:translate-x-0"
              : "translate-y-3 opacity-0 md:translate-x-2 md:translate-y-0",
          )}
        >
          {effectiveShouldRenderContent ? (
            <>
              <div className="project-tools-panel-handle" aria-hidden="true" />
              <button
                type="button"
                aria-label={t("projectTools.resizePanel")}
                title={t("projectTools.resizePanel")}
                className={cn(
                  "group absolute inset-y-0 left-0 z-10 hidden w-3 cursor-col-resize touch-none items-center justify-center border-0 bg-transparent p-0 md:flex",
                  "focus-visible:outline-none",
                )}
                onMouseDown={handleResizeStart}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-10 w-0.5 rounded-full bg-muted-foreground/25 opacity-70 shadow-sm transition-[height,background-color,opacity]",
                    "group-hover:h-16 group-hover:bg-primary/60 group-hover:opacity-100 group-focus-visible:h-16 group-focus-visible:bg-primary group-focus-visible:opacity-100",
                    isResizing && "h-20 bg-primary opacity-100",
                  )}
                />
              </button>
              <div className="project-tools-panel-header flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
                <div
                  className="project-tools-panel-tabs-shell flex min-w-0 flex-1 flex-col justify-center gap-1"
                  onWheel={handleTabsWheel}
                >
                  <div
                    ref={tabsScrollRef}
                    className="project-tools-panel-tabs flex h-8 min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden"
                  >
                    <RightDockTabStrip
                      tabs={orderedProjectTabs}
                      currentActiveTab={currentActiveTab}
                      backgroundTasksRunning={backgroundTasksRunning}
                      onCloseBackgroundTasks={closeBackgroundTasks}
                      activeSession={activeSession}
                      pendingCloseSessionId={pendingCloseSessionId}
                      closingSessionIds={closingSessionIds}
                      draggingTabId={draggingTabId}
                      renderTabDragHandle={renderTabDragHandle}
                      getTabDragProps={getTabDragProps}
                      getTabDragStyle={getTabDragStyle}
                      consumeSuppressedTabClick={consumeSuppressedTabClick}
                      onActivateTab={activateTab}
                      onActivateTerminalSession={activateTerminalSession}
                      onCloseToolTab={closeToolTab}
                      onCloseTerminalRequest={handleCloseRequest}
                      onTerminalTabDragStart={onTerminalTabDragStart}
                      onOpenTerminalInWorkbench={onOpenTerminalInWorkbench}
                      onToolTabDragStart={onToolDragStart}
                      onOpenToolInWorkbench={onOpenToolInWorkbench}
                    />
                  </div>
                  <RightDockTabsScrollbar scrollRef={tabsScrollRef} />
                </div>
                <RightDockCreateMenu
                  leasedTools={leasedTools}
                  open={createMenuOpen}
                  onOpenChange={setCreateMenuOpen}
                  shellOptions={shellOptions}
                  terminalReady={terminalReady}
                  terminalDisabledMessage={terminalDisabledMessage}
                  projectReady={projectReady}
                  tunnelAvailable={tunnelAvailable}
                  creating={creating}
                  onCreateTerminal={createTerminal}
                  onOpenNewTerminalInWorkbench={onOpenNewTerminalInWorkbench}
                  onStartTool={startToolTab}
                  onOpenBackgroundTasks={openBackgroundTasks}
                />
                {onClose ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onClose}
                    title={t("projectTools.closePanel")}
                    className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground md:hidden"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>

              {pendingCloseSession ? (
                <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <span className="min-w-0 flex-1 truncate">
                    {t("projectTools.closeRunningTerminal").replace(
                      "{title}",
                      formatTerminalSessionTitle(
                        pendingCloseSession.title,
                        t("projectTools.terminalTitle"),
                      ),
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 px-2.5 text-xs"
                    onClick={clearPendingCloseSession}
                  >
                    {t("settings.cancel")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="h-7 shrink-0 px-2.5 text-xs"
                    disabled={closingSessionIds.has(pendingCloseSession.id)}
                    onClick={() => closeSession(pendingCloseSession)}
                  >
                    {t("projectTools.close")}
                  </Button>
                </div>
              ) : null}

              {showDisabledMessage ? (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                  {disabledMessage}
                </div>
              ) : showRightDockChooser ? (
                <RightDockChooser
                  leasedTools={leasedTools}
                  terminalReady={terminalReady}
                  terminalDisabledMessage={terminalDisabledMessage}
                  disabledMessage={disabledMessage}
                  projectReady={projectReady}
                  tunnelAvailable={tunnelAvailable}
                  creating={creating}
                  loading={loading}
                  error={error}
                  onCreateTerminal={createTerminal}
                  onStartTool={startToolTab}
                  onOpenBackgroundTasks={openBackgroundTasks}
                  onNewTerminalDragStart={onNewTerminalDragStart}
                  onToolDragStart={onToolDragStart}
                />
              ) : (
                <RightDockContent
                  currentActiveTab={currentActiveTab}
                  initializedTools={initializedTools}
                  localSessions={localSessions}
                  activeSession={activeSession}
                  initialTerminalSnapshotsRef={initialTerminalSnapshotsRef}
                  error={activeTerminalError ?? error}
                  creating={creating}
                  loading={loading}
                  onTerminalError={handleTerminalError}
                  onInitialTerminalSnapshotConsumed={handleInitialTerminalSnapshotConsumed}
                  onCreateTerminal={handleCreate}
                  leasedTools={leasedTools}
                />
              )}
            </>
          ) : null}
        </div>
      </aside>
    </RightDockToolContext.Provider>
  );
});
