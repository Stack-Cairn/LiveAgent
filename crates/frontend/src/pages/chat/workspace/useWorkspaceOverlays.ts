import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceCodeEditorOpenRequest } from "../../../components/workspace-editor/WorkspaceCodeEditorOverlay";
import type { WorkspaceFilePreviewOpenRequest } from "../../../components/workspace-editor/WorkspaceFilePreviewOverlay";
import type { WorkspaceSshTerminalOpenRequest } from "../../../components/workspace-editor/WorkspaceSshTerminalOverlay";
import { isWorkspacePreviewPath } from "../../../components/workspace-editor/workspaceImagePreview";
import type { TerminalSession } from "../../../lib/terminal/types";

type UseWorkspaceOverlaysParams = {
  terminalProjectPath: string;
  terminalProjectPathKey: string;
  rightDockFileTreeOpen: boolean;
};

/**
 * State machine for the three full-window workspace overlays (code editor,
 * file preview, SSH terminal): mount/open/request state, mutual exclusion on
 * open, and the cleanup pass when the right-dock file tree tab closes.
 */
export function useWorkspaceOverlays(params: UseWorkspaceOverlaysParams) {
  const { terminalProjectPath, terminalProjectPathKey, rightDockFileTreeOpen } = params;
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
    (path: string, imagePaths?: string[]) => {
      if (!terminalProjectPath || !terminalProjectPathKey) return;
      const request = {
        projectPathKey: terminalProjectPathKey,
        workdir: terminalProjectPath,
        path,
        imagePaths,
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
      const openRequest = {
        id: workspaceSshTerminalRequestIdRef.current,
        sessionId: session.id,
        kind,
      };
      openWorkspaceSshTerminalRequest(openRequest);
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

  return {
    workspaceEditorMounted,
    setWorkspaceEditorMounted,
    workspaceEditorOpen,
    setWorkspaceEditorOpen,
    workspaceEditorCleanupPending,
    setWorkspaceEditorCleanupPending,
    workspaceEditorOpenRequest,
    setWorkspaceEditorOpenRequest,
    workspaceEditorCloseRequestId,
    setWorkspaceEditorCloseRequestId,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    setWorkspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
    openWorkspaceSshTerminalRequest,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    handleOpenWorkspaceFile,
    handleOpenSshTerminal,
    requestWorkspaceFilePreviewClose,
    handleWorkspaceFilePreviewClosed,
  };
}
