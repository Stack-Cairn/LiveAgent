import { useCallback, useEffect, useMemo, useState } from "react";
import {
  openRightDockToolTabState,
  type RightDockProjectState,
  rightDockToolKindForTabId,
} from "../../lib/settings";
import type { TerminalSession } from "../../lib/terminal/types";
import {
  BACKGROUND_TASKS_TAB_ID,
  closeRightDockToolTabState,
  getCurrentRightDockActiveTab,
  getRightDockVisibleTabs,
  orderRightDockVisibleTabs,
  type RightDockSingletonTabKind,
  resolveEffectiveActiveTabId,
  rightDockNeighborTabId,
  rightDockSingletonTabId,
  sameStringArray,
} from "./rightDockModel";

type UseRightDockProjectTabsOptions = {
  backgroundTasksVisible: boolean;
  localSessions: TerminalSession[];
  projectPathKey: string;
  projectState: RightDockProjectState;
  sessionsLoaded: boolean;
  tunnelAvailable: boolean;
  onProjectStateChange: (
    updater: (current: RightDockProjectState) => RightDockProjectState,
  ) => void;
};

export function useRightDockProjectTabs(options: UseRightDockProjectTabsOptions) {
  const {
    backgroundTasksVisible,
    localSessions,
    onProjectStateChange,
    projectPathKey,
    projectState,
    sessionsLoaded,
    tunnelAvailable,
  } = options;
  const [draftTabOrder, setDraftTabOrder] = useState<string[] | null>(null);
  const fileTreeInitialized = Boolean(projectPathKey && projectState.tools.fileTree);
  const gitReviewInitialized = Boolean(projectPathKey && projectState.tools.gitReview);
  const tunnelInitialized = Boolean(projectState.tools.tunnel && tunnelAvailable);
  const sshTunnelInitialized = Boolean(projectPathKey && projectState.tools.sshTunnel);
  const visibleTabs = useMemo(
    () =>
      getRightDockVisibleTabs({
        backgroundTasksVisible,
        localSessions,
        projectPathKey,
        projectState,
        tunnelAvailable,
      }),
    [backgroundTasksVisible, localSessions, projectPathKey, projectState, tunnelAvailable],
  );
  const effectiveTabOrder = draftTabOrder ?? projectState.tabOrder;
  const orderedProjectTabs = useMemo(
    () => orderRightDockVisibleTabs(visibleTabs, effectiveTabOrder),
    [effectiveTabOrder, visibleTabs],
  );
  const orderedProjectTabIds = useMemo(
    () => orderedProjectTabs.map((tab) => tab.id),
    [orderedProjectTabs],
  );
  const effectiveActiveTabId = resolveEffectiveActiveTabId(
    projectState.activeTabId,
    orderedProjectTabIds,
    sessionsLoaded,
  );
  const currentActiveTab = getCurrentRightDockActiveTab(effectiveActiveTabId, visibleTabs);

  useEffect(() => {
    if (!draftTabOrder) return;
    if (sameStringArray(draftTabOrder, projectState.tabOrder)) {
      setDraftTabOrder(null);
    }
  }, [draftTabOrder, projectState.tabOrder]);

  const activateTab = useCallback(
    (tabId: string) => {
      if (!tabId) return;
      onProjectStateChange((current) =>
        current.activeTabId === tabId
          ? current
          : {
              ...current,
              activeTabId: tabId,
              tabOrder: current.tabOrder.includes(tabId)
                ? current.tabOrder
                : [...current.tabOrder, tabId],
            },
      );
    },
    [onProjectStateChange],
  );

  const openSingletonTab = useCallback(
    (kind: RightDockSingletonTabKind) => {
      onProjectStateChange((current) => openRightDockToolTabState(current, kind));
    },
    [onProjectStateChange],
  );

  const closeToolTab = useCallback(
    (kind: RightDockSingletonTabKind) => {
      const fallback = rightDockNeighborTabId(orderedProjectTabIds, rightDockSingletonTabId(kind));
      onProjectStateChange((current) => closeRightDockToolTabState(current, kind, fallback));
    },
    [onProjectStateChange, orderedProjectTabIds],
  );

  // Reorders are user gestures, so they double as the lazy GC point for dead
  // session ids — but only once the session list is actually known.
  const commitTabOrder = useCallback(
    (nextOrder: string[]) => {
      const liveSessionIds = new Set(localSessions.map((session) => session.id));
      onProjectStateChange((current) => {
        const keepsId = (id: string) => {
          const toolKind = rightDockToolKindForTabId(id);
          if (toolKind) return Boolean(current.tools[toolKind]);
          if (id === BACKGROUND_TASKS_TAB_ID) return backgroundTasksVisible;
          return liveSessionIds.has(id) || !sessionsLoaded;
        };
        const ordered: string[] = [];
        const push = (id: string) => {
          if (id && keepsId(id) && !ordered.includes(id)) ordered.push(id);
        };
        for (const id of nextOrder) push(id);
        for (const id of current.tabOrder) push(id);
        if (sameStringArray(current.tabOrder, ordered)) return current;
        return { ...current, tabOrder: ordered };
      });
    },
    [backgroundTasksVisible, localSessions, onProjectStateChange, sessionsLoaded],
  );

  return {
    activateTab,
    canReorderTabs: orderedProjectTabIds.length > 1,
    closeToolTab,
    commitTabOrder,
    currentActiveTab,
    effectiveActiveTabId,
    fileTreeInitialized,
    gitReviewInitialized,
    openSingletonTab,
    orderedProjectTabIds,
    orderedProjectTabs,
    setDraftTabOrder,
    sshTunnelInitialized,
    tunnelInitialized,
  };
}
