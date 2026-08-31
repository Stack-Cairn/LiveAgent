import type { ConfirmDialogOptions } from "@liveagent/ui/components/ui/confirm-dialog";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { terminalSessionBelongsToProject } from "@liveagent/ui/lib/terminal/sessionStore";
import type { TerminalSession } from "@liveagent/ui/lib/terminal/types";
import { useWorkspaceProjectRemoval as useSharedWorkspaceProjectRemoval } from "@liveagent/ui/lib/useWorkspaceProjectRemoval";
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from "react";
import { tauriGitClient } from "../../../lib/git/tauriGitClient";
import type { AppSettings, WorkspaceProject } from "../../../lib/settings";
import { tauriTerminalClient } from "../../../lib/terminal/tauriTerminalClient";
import { revokeWorkspaceRootGrants } from "../../../lib/workspaceRootGrants";

type UseWorkspaceProjectRemovalParams = {
  settings: AppSettings;
  setSettings: (updater: (previousSettings: AppSettings) => AppSettings) => void;
  t: (key: string) => string;
  requestConfirmDialog: (options: ConfirmDialogOptions) => Promise<boolean>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  sidebarStore: SidebarStore;
  workspaceProjects: WorkspaceProject[];
  archivedWorkspaceProjectPathKeys: Set<string>;
  activeWorkspaceProject: WorkspaceProject | undefined;
  activateWorkspaceProject: (
    project: WorkspaceProject,
    options?: { startConversation?: boolean },
  ) => string | null;
  setActiveWorkspaceProjectId: Dispatch<SetStateAction<string>>;
  terminalProjectPathKey: string;
  setTerminalSessions: Dispatch<SetStateAction<TerminalSession[]>>;
  setRightDockOpen: Dispatch<SetStateAction<boolean>>;
  displayedConversationWorkdir: string;
  startNewConversationActionRef: MutableRefObject<(options?: { workdir?: string }) => string>;
};

export function useWorkspaceProjectRemoval(params: UseWorkspaceProjectRemovalParams) {
  const {
    sidebarStore,
    terminalProjectPathKey,
    setTerminalSessions,
    setRightDockOpen,
    displayedConversationWorkdir,
    startNewConversationActionRef,
  } = params;

  const isWorkspaceProjectRunning = useCallback(
    (pathKey: string) => sidebarStore.getSnapshot().runningWorkdirPathKeys.has(pathKey),
    [sidebarStore],
  );
  const onPruneTerminalSessions = useCallback(
    (pathKey: string) => {
      setTerminalSessions((current) =>
        current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
      );
    },
    [setTerminalSessions],
  );
  const onCloseRightDockProject = useCallback(
    (pathKey: string) => {
      if (terminalProjectPathKey === pathKey) {
        setRightDockOpen(false);
        onPruneTerminalSessions(pathKey);
      }
    },
    [onPruneTerminalSessions, setRightDockOpen, terminalProjectPathKey],
  );
  const getDisplayedConversationWorkdir = useCallback(
    () => displayedConversationWorkdir,
    [displayedConversationWorkdir],
  );
  const startNewConversation = useCallback(
    (options?: { workdir?: string }) => startNewConversationActionRef.current(options),
    [startNewConversationActionRef],
  );
  const beforeRemoveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => revokeWorkspaceRootGrants(project),
    [],
  );

  return useSharedWorkspaceProjectRemoval({
    ...params,
    gitClient: tauriGitClient,
    terminalClient: tauriTerminalClient,
    isWorkspaceProjectRunning,
    onPruneTerminalSessions,
    onCloseRightDockProject,
    getDisplayedConversationWorkdir,
    startNewConversation,
    beforeRemoveWorkspaceProject,
  });
}
