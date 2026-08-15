import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalSession } from "../../lib/terminal/types";
import type { WorkspaceCodeEditorOpenRequest } from "./WorkspaceCodeEditorOverlay";
import type { WorkspaceFilePreviewOpenRequest } from "./WorkspaceFilePreviewOverlay";
import type { SftpOpenFileRequest } from "./WorkspaceSftpPanel";
import type { WorkspaceSshTerminalOpenRequest } from "./WorkspaceSshTerminalOverlay";
import { isWorkspacePreviewPath } from "./workspaceImagePreview";

type UseWorkspaceOverlaysParams = {
  terminalProjectPath: string;
  terminalProjectPathKey: string;
  rightDockFileTreeOpen: boolean;
};

export function useWorkspaceOverlays(params: UseWorkspaceOverlaysParams) {
  const { terminalProjectPath, terminalProjectPathKey, rightDockFileTreeOpen } = params;
  const previousRightDockFileTreeOpenRef = useRef(false);
  const [workspaceEditorMounted, setWorkspaceEditorMounted] = useState(false);
  const workspaceEditorMountedRef = useRef(false);
  workspaceEditorMountedRef.current = workspaceEditorMounted;
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
  // Editors/previews opened from the SFTP panel return to the SSH overlay on
  // close (the overlay stays mounted while hidden, so this is just re-show).
  const returnToSshTerminalRef = useRef(false);
  const workspaceSshTerminalMountedRef = useRef(false);
  workspaceSshTerminalMountedRef.current = workspaceSshTerminalMounted;

  const restoreSshTerminalIfRequested = useCallback(() => {
    if (!returnToSshTerminalRef.current) return;
    returnToSshTerminalRef.current = false;
    if (workspaceSshTerminalMountedRef.current) {
      setWorkspaceSshTerminalOpen(true);
    }
  }, []);

  const hideWorkspaceSshTerminalOverlay = useCallback(() => {
    setWorkspaceSshTerminalOpen(false);
  }, []);

  const openWorkspaceSshTerminalRequest = useCallback(
    (request: WorkspaceSshTerminalOpenRequest) => {
      returnToSshTerminalRef.current = false;
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
    restoreSshTerminalIfRequested();
  }, [restoreSshTerminalIfRequested]);

  const handleWorkspaceEditorClosed = useCallback(() => {
    setWorkspaceEditorOpen(false);
    setWorkspaceEditorMounted(false);
    setWorkspaceEditorCleanupPending(false);
    setWorkspaceEditorOpenRequest(null);
    setWorkspaceEditorCloseRequestId(0);
    restoreSshTerminalIfRequested();
  }, [restoreSshTerminalIfRequested]);

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
      returnToSshTerminalRef.current = false;
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

  // SFTP panel entry: local files reuse the workspace pipeline (the local
  // pane root is forced to equal the SSH session's project directory by
  // workdir_for_session on the Rust side), remote files open editor tabs
  // backed by the session's SFTP channel.
  const handleOpenSftpFile = useCallback(
    (session: TerminalSession, request: SftpOpenFileRequest) => {
      if (!terminalProjectPath || !terminalProjectPathKey) return;
      if (request.side === "local") {
        handleOpenWorkspaceFile(request.path);
        returnToSshTerminalRef.current = true;
        return;
      }
      openWorkspaceEditorFile({
        projectPathKey: terminalProjectPathKey,
        workdir: terminalProjectPath,
        path: request.path,
        remote: { sessionId: session.id },
      });
      returnToSshTerminalRef.current = true;
    },
    [handleOpenWorkspaceFile, openWorkspaceEditorFile, terminalProjectPath, terminalProjectPathKey],
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
    // Only restore when the editor isn't taking over (preview -> editor
    // switch closes the preview while the editor stays in front).
    if (!workspaceEditorMountedRef.current) {
      restoreSshTerminalIfRequested();
    }
  }, [restoreSshTerminalIfRequested]);

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
    handleWorkspaceEditorHide,
    handleWorkspaceEditorClosed,
    handleOpenWorkspaceFile,
    handleOpenSftpFile,
    handleOpenSshTerminal,
    requestWorkspaceFilePreviewClose,
    handleWorkspaceFilePreviewClosed,
    hideWorkspaceSshTerminalOverlay,
  };
}
