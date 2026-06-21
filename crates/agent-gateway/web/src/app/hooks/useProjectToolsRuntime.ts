import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkspaceCodeEditorOpenRequest } from "@/components/workspace-editor/WorkspaceCodeEditorOverlay";
import type { WorkspaceFilePreviewOpenRequest } from "@/components/workspace-editor/WorkspaceFilePreviewOverlay";
import type { WorkspaceSshTerminalOpenRequest } from "@/components/workspace-editor/WorkspaceSshTerminalOverlay";
import { isWorkspacePreviewPath } from "@/components/workspace-editor/workspaceImagePreview";
import {
  applyTerminalEventToSessions,
  replaceTerminalSessionsForProject,
  sortTerminalSessions,
  terminalSessionBelongsToProject,
} from "@/lib/terminal/sessionStore";
import type { TerminalClient, TerminalSession } from "@/lib/terminal/types";

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

  const previousRightDockFileTreeOpenRef = useRef(false);
  const [workspaceEditorMounted, setWorkspaceEditorMounted] = useState(false);
  const [workspaceEditorOpen, setWorkspaceEditorOpen] = useState(false);
  const [workspaceEditorCleanupPending, setWorkspaceEditorCleanupPending] = useState(false);
  const [workspaceEditorOpenRequest, setWorkspaceEditorOpenRequest] =
    useState<WorkspaceCodeEditorOpenRequest | null>(null);
  const [workspaceEditorCloseRequestId, setWorkspaceEditorCloseRequestId] = useState(0);
  const workspaceEditorRequestIdRef = useRef(0);
  const [workspaceFilePreviewMounted, setWorkspaceFilePreviewMounted] = useState(false);
  const [workspaceFilePreviewOpen, setWorkspaceFilePreviewOpen] = useState(false);
  const [workspaceFilePreviewOpenRequest, setWorkspaceFilePreviewOpenRequest] =
    useState<WorkspaceFilePreviewOpenRequest | null>(null);
  const workspaceFilePreviewRequestIdRef = useRef(0);
  const [workspaceSshTerminalMounted, setWorkspaceSshTerminalMounted] = useState(false);
  const [workspaceSshTerminalOpen, setWorkspaceSshTerminalOpen] = useState(false);
  const [workspaceSshTerminalOpenRequest, setWorkspaceSshTerminalOpenRequest] =
    useState<WorkspaceSshTerminalOpenRequest | null>(null);
  const workspaceSshTerminalRequestIdRef = useRef(0);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const terminalSessionsVersionRef = useRef(0);
  const terminalStatusSessionIdRef = useRef("");

  const hideWorkspaceSshTerminalOverlay = useCallback(() => {
    setWorkspaceSshTerminalOpen(false);
  }, []);

  const openWorkspaceSshTerminalRequest = useCallback(
    (request: WorkspaceSshTerminalOpenRequest) => {
      setWorkspaceFilePreviewOpen(false);
      setWorkspaceEditorOpen(false);
      setWorkspaceSshTerminalMounted(true);
      setWorkspaceSshTerminalOpen(true);
      setWorkspaceSshTerminalOpenRequest(request);
    },
    [],
  );

  const requestWorkspaceEditorClose = useCallback(() => {
    setWorkspaceEditorCloseRequestId((current) => current + 1);
  }, []);

  const handleWorkspaceEditorHide = useCallback(() => {
    setWorkspaceEditorOpen(false);
  }, []);

  const handleWorkspaceEditorClosed = useCallback(() => {
    setWorkspaceEditorOpen(false);
    setWorkspaceEditorMounted(false);
    setWorkspaceEditorCleanupPending(false);
    setWorkspaceEditorOpenRequest(null);
    setWorkspaceEditorCloseRequestId(0);
  }, []);

  const openWorkspaceEditorFile = useCallback(
    (request: Omit<WorkspaceCodeEditorOpenRequest, "id">) => {
      hideWorkspaceSshTerminalOverlay();
      setWorkspaceFilePreviewOpen(false);
      workspaceEditorRequestIdRef.current += 1;
      setWorkspaceEditorCleanupPending(false);
      setWorkspaceEditorMounted(true);
      setWorkspaceEditorOpen(true);
      setWorkspaceEditorOpenRequest({
        id: workspaceEditorRequestIdRef.current,
        ...request,
      });
    },
    [hideWorkspaceSshTerminalOverlay],
  );

  const openWorkspaceFilePreview = useCallback(
    (request: Omit<WorkspaceFilePreviewOpenRequest, "id">) => {
      hideWorkspaceSshTerminalOverlay();
      setWorkspaceEditorOpen(false);
      workspaceFilePreviewRequestIdRef.current += 1;
      setWorkspaceFilePreviewMounted(true);
      setWorkspaceFilePreviewOpen(true);
      setWorkspaceFilePreviewOpenRequest({
        id: workspaceFilePreviewRequestIdRef.current,
        ...request,
      });
    },
    [hideWorkspaceSshTerminalOverlay],
  );

  const handleOpenWorkspaceFile = useCallback(
    (path: string) => {
      if (!terminalProjectPath || !terminalProjectPathKey) return;
      const request = {
        projectPathKey: terminalProjectPathKey,
        workdir: terminalProjectPath,
        path,
      };
      if (isWorkspacePreviewPath(path)) {
        openWorkspaceFilePreview(request);
        return;
      }
      openWorkspaceEditorFile(request);
    },
    [
      openWorkspaceEditorFile,
      openWorkspaceFilePreview,
      terminalProjectPath,
      terminalProjectPathKey,
    ],
  );

  const handleOpenSshTerminal = useCallback(
    (session: TerminalSession, kind: WorkspaceSshTerminalOpenRequest["kind"] = "bash") => {
      if (session.kind !== "ssh") return;
      workspaceSshTerminalRequestIdRef.current += 1;
      openWorkspaceSshTerminalRequest({
        id: workspaceSshTerminalRequestIdRef.current,
        sessionId: session.id,
        kind,
      });
    },
    [openWorkspaceSshTerminalRequest],
  );

  const requestWorkspaceFilePreviewClose = useCallback(() => {
    setWorkspaceFilePreviewOpen(false);
  }, []);

  const handleWorkspaceFilePreviewClosed = useCallback(() => {
    setWorkspaceFilePreviewOpen(false);
    setWorkspaceFilePreviewMounted(false);
    setWorkspaceFilePreviewOpenRequest(null);
  }, []);

  useEffect(() => {
    const previousOpen = previousRightDockFileTreeOpenRef.current;
    previousRightDockFileTreeOpenRef.current = rightDockFileTreeOpen;
    if (rightDockFileTreeOpen && workspaceEditorCleanupPending) {
      setWorkspaceEditorCleanupPending(false);
    }
    if (previousOpen && !rightDockFileTreeOpen && workspaceEditorMounted) {
      setWorkspaceEditorCleanupPending(true);
      setWorkspaceEditorOpen(true);
      requestWorkspaceEditorClose();
    }
    if (previousOpen && !rightDockFileTreeOpen && workspaceFilePreviewMounted) {
      requestWorkspaceFilePreviewClose();
    }
  }, [
    rightDockFileTreeOpen,
    requestWorkspaceEditorClose,
    requestWorkspaceFilePreviewClose,
    workspaceEditorCleanupPending,
    workspaceEditorMounted,
    workspaceFilePreviewMounted,
  ]);

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

  useEffect(() => {
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
      .catch(() => undefined);
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
    if (!terminalClient) return;
    if (!settingsSyncReady) return;
    if (!isAgentMode || !webTerminalSessionsEnabled || statusOnline !== true) return;
    if (!rightDockSshTunnelOpen || !terminalProjectPathKey) return;

    let cancelled = false;
    let refreshSeq = 0;
    const refreshProjectTerminalSessions = () => {
      const seq = ++refreshSeq;
      void terminalClient
        .list(terminalProjectPathKey)
        .then((sessions) => {
          if (cancelled || seq !== refreshSeq) return;
          terminalSessionsVersionRef.current += 1;
          setTerminalSessions((current) =>
            replaceTerminalSessionsForProject(current, terminalProjectPathKey, sessions),
          );
        })
        .catch(() => undefined);
    };

    refreshProjectTerminalSessions();
    const timer = window.setInterval(refreshProjectTerminalSessions, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
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
  }, []);

  return {
    workspaceEditorMounted,
    workspaceEditorOpen,
    workspaceEditorCleanupPending,
    workspaceEditorOpenRequest,
    workspaceEditorCloseRequestId,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
    terminalSessions,
    setTerminalSessions,
    terminalSessionsVersionRef,
    terminalStatusSessionIdRef,
    projectTerminalSessions,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    handleWorkspaceEditorHide,
    handleWorkspaceEditorClosed,
    requestWorkspaceFilePreviewClose,
    handleWorkspaceFilePreviewClosed,
    handleOpenWorkspaceFile,
    handleOpenSshTerminal,
    handleProjectTerminalSessionsChange,
    resetTerminalSessions,
    hideWorkspaceSshTerminalOverlay,
  };
}
