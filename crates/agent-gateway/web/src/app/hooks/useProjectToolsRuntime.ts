import { useWorkspaceOverlays } from "@liveagent/ui/components/workspace-editor/useWorkspaceOverlays";
import {
  applyTerminalEventToSessions,
  replaceTerminalSessionsForProject,
  sortTerminalSessions,
  terminalSessionBelongsToProject,
} from "@liveagent/ui/lib/terminal/sessionStore";
import type { TerminalClient, TerminalSession } from "@liveagent/ui/lib/terminal/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type UseProjectToolsRuntimeParams = {
  terminalClient: TerminalClient | null;
  settingsSyncReady: boolean;
  isAgentMode: boolean;
  webTerminalSessionsEnabled: boolean;
  statusOnline?: boolean;
  statusSessionId?: string | null;
  terminalProjectPath: string;
  terminalProjectPathKey: string;
  rightDockFileTreeOpen: boolean;
  rightDockSshTunnelOpen: boolean;
};

export function useProjectToolsRuntime(params: UseProjectToolsRuntimeParams) {
  const {
    terminalClient,
    settingsSyncReady,
    isAgentMode,
    webTerminalSessionsEnabled,
    statusOnline,
    statusSessionId,
    terminalProjectPath,
    terminalProjectPathKey,
    rightDockFileTreeOpen,
    rightDockSshTunnelOpen,
  } = params;

  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const [terminalSessionsLoaded, setTerminalSessionsLoaded] = useState(false);
  const terminalSessionsVersionRef = useRef(0);
  const terminalStatusSessionIdRef = useRef("");

  const workspaceOverlays = useWorkspaceOverlays({
    terminalProjectPath,
    terminalProjectPathKey,
    rightDockFileTreeOpen,
  });

  const projectTerminalSessions = useMemo(
    () =>
      terminalProjectPathKey
        ? terminalSessions.filter((session) =>
            terminalSessionBelongsToProject(session, terminalProjectPathKey),
          )
        : [],
    [terminalProjectPathKey, terminalSessions],
  );

  const handleProjectTerminalSessionsChange = useCallback((sessions: TerminalSession[]) => {
    terminalSessionsVersionRef.current += 1;
    setTerminalSessions(sortTerminalSessions(sessions));
  }, []);

  // 函数式变体:回调方按 React 当前值合并,而不是按 render 闭包里的快照。
  // 两个事件在一次重渲染之间到达(SSH 面板 snapshot 紧跟 reconcile)时,
  // 整表提交会让后者覆盖前者;这里与 dock 侧 `sessionsRef.current` 同口径。
  const updateProjectTerminalSessions = useCallback(
    (updater: (current: readonly TerminalSession[]) => readonly TerminalSession[]) => {
      terminalSessionsVersionRef.current += 1;
      setTerminalSessions((current) => sortTerminalSessions(updater(current)));
    },
    [],
  );

  useEffect(() => {
    // Loaded flips false whenever the gates or the gateway session identity
    // change, and true only once list() settles below — RightDockPanel uses it
    // to defer terminal-tab GC until the session list is actually known.
    setTerminalSessionsLoaded(false);
    if (!terminalClient) {
      terminalSessionsVersionRef.current += 1;
      setTerminalSessions([]);
      return;
    }
    if (!settingsSyncReady) {
      return;
    }
    if (!isAgentMode || !webTerminalSessionsEnabled || statusOnline === false) {
      terminalSessionsVersionRef.current += 1;
      setTerminalSessions([]);
      return;
    }
    if (statusOnline !== true) {
      return;
    }
    const normalizedStatusSessionId = statusSessionId?.trim() ?? "";
    if (
      normalizedStatusSessionId &&
      terminalStatusSessionIdRef.current !== normalizedStatusSessionId
    ) {
      const hadPreviousSession = terminalStatusSessionIdRef.current !== "";
      terminalStatusSessionIdRef.current = normalizedStatusSessionId;
      if (hadPreviousSession) {
        terminalSessionsVersionRef.current += 1;
        setTerminalSessions([]);
      }
    }
    let cancelled = false;
    const requestVersion = terminalSessionsVersionRef.current;
    void terminalClient
      .list()
      .then((sessions) => {
        if (!cancelled && terminalSessionsVersionRef.current === requestVersion) {
          setTerminalSessions(sortTerminalSessions(sessions));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setTerminalSessionsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    isAgentMode,
    settingsSyncReady,
    statusOnline,
    statusSessionId,
    terminalClient,
    webTerminalSessionsEnabled,
  ]);

  useEffect(() => {
    if (!terminalClient) return;
    return terminalClient.subscribe((event) => {
      if (event.kind === "output") return;
      terminalSessionsVersionRef.current += 1;
      setTerminalSessions((current) => applyTerminalEventToSessions(current, event));
    });
  }, [terminalClient]);

  useEffect(() => {
    // One catch-up fetch when the ssh-tunnel tab becomes usable (opened, agent
    // back online, gateway session ready). Ongoing freshness is event-driven:
    // the terminalClient.subscribe effect above applies created/updated/closed
    // broadcasts, and SshTunnelPanel's own active-gated reconcile feeds
    // list() results back through onSessionsReconcile -> onSessionsChange.
    // A parallel 5s poll here only duplicated that traffic.
    if (!terminalClient) return;
    if (!settingsSyncReady) return;
    if (!isAgentMode || !webTerminalSessionsEnabled || statusOnline !== true) return;
    if (!rightDockSshTunnelOpen || !terminalProjectPathKey) return;

    let cancelled = false;
    void terminalClient
      .list(terminalProjectPathKey)
      .then((sessions) => {
        if (cancelled) return;
        terminalSessionsVersionRef.current += 1;
        setTerminalSessions((current) =>
          replaceTerminalSessionsForProject(current, terminalProjectPathKey, sessions),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    isAgentMode,
    rightDockSshTunnelOpen,
    settingsSyncReady,
    statusOnline,
    terminalClient,
    terminalProjectPathKey,
    webTerminalSessionsEnabled,
  ]);

  const resetTerminalSessions = useCallback(() => {
    terminalSessionsVersionRef.current += 1;
    terminalStatusSessionIdRef.current = "";
    setTerminalSessions([]);
    setTerminalSessionsLoaded(false);
  }, []);

  return {
    ...workspaceOverlays,
    terminalSessions,
    terminalSessionsLoaded,
    setTerminalSessions,
    terminalSessionsVersionRef,
    terminalStatusSessionIdRef,
    projectTerminalSessions,
    handleProjectTerminalSessionsChange,
    updateProjectTerminalSessions,
    resetTerminalSessions,
  };
}
