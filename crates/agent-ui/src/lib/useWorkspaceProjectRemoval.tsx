import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import { useCallback } from "react";
import type { WorkspaceProjectRemoveOptions } from "../components/chat/ChatHistorySidebar";
import { Terminal } from "../components/IconSet";
import type { ConfirmDialogOptions } from "../components/ui/confirm-dialog";
import type { GitClient } from "./git/types";
import { errorMessageWithFallback } from "./shared/value";
import type { TerminalClient, TerminalSession } from "./terminal/types";
import { useWorkspaceProjectSettingsActions } from "./workspaceProjectRemoval";
import { getDefaultWorkspaceProjectPath } from "./workspaceProjects";

type UseWorkspaceProjectRemovalParams = {
  settings: AppSettings;
  setSettings: (updater: (previousSettings: AppSettings) => AppSettings) => void;
  t: (key: string) => string;
  requestConfirmDialog: (options: ConfirmDialogOptions) => Promise<boolean>;
  setErrorMessage: (message: string | null) => void;
  workspaceProjects: readonly WorkspaceProject[];
  archivedWorkspaceProjectPathKeys: ReadonlySet<string>;
  activeWorkspaceProject: WorkspaceProject | undefined;
  activateWorkspaceProject: (project: WorkspaceProject) => void;
  setActiveWorkspaceProjectId: (updater: (current: string) => string) => void;
  setProjectRenamingId: (updater: (current: string | null) => string | null) => void;
  setProjectRenameDraft: (value: string) => void;
  gitClient: Pick<GitClient, "removeWorktree"> | null | undefined;
  terminalClient?: Pick<TerminalClient, "list" | "closeProject"> | null;
  shouldInspectTerminalSessions?: boolean;
  isWorkspaceProjectRunning: (pathKey: string) => boolean;
  onPruneTerminalSessions: (pathKey: string) => void;
  onCloseRightDockProject: (pathKey: string) => void;
  getDisplayedConversationWorkdir: () => string;
  startNewConversation: (options?: { workdir?: string }) => void;
  onWorktreeRemoved?: () => void;
};

type WorkspaceProjectDeletionParams = Pick<
  UseWorkspaceProjectRemovalParams,
  | "settings"
  | "t"
  | "requestConfirmDialog"
  | "setErrorMessage"
  | "gitClient"
  | "terminalClient"
  | "shouldInspectTerminalSessions"
  | "isWorkspaceProjectRunning"
  | "onPruneTerminalSessions"
  | "onCloseRightDockProject"
  | "getDisplayedConversationWorkdir"
  | "startNewConversation"
  | "onWorktreeRemoved"
> & {
  removeWorkspaceProjectFromSettings: (project: WorkspaceProject) => void;
};

function RunningTerminalWarning(props: { count: number; t: (key: string) => string }) {
  const { count, t } = props;
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300">
        <Terminal className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">
            {t("chat.exitConfirmRunningLabel")}
          </span>
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-semibold text-amber-700 dark:text-amber-300">
            {count}
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
          {t("chat.workspaceDeleteWorktreeTerminalDescription")}
        </p>
      </div>
    </div>
  );
}

export function useWorkspaceProjectDeletion(params: WorkspaceProjectDeletionParams) {
  const {
    settings,
    t,
    requestConfirmDialog,
    setErrorMessage,
    removeWorkspaceProjectFromSettings,
    gitClient,
    terminalClient,
    shouldInspectTerminalSessions = true,
    isWorkspaceProjectRunning,
    onPruneTerminalSessions,
    onCloseRightDockProject,
    getDisplayedConversationWorkdir,
    startNewConversation,
    onWorktreeRemoved,
  } = params;

  const handleRemoveWorkspaceProject = useCallback(
    (project: WorkspaceProject, options: WorkspaceProjectRemoveOptions = {}) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;

      const path = project.path.trim();
      const pathKey = workspaceProjectPathKey(path);
      if (pathKey && isWorkspaceProjectRunning(pathKey)) {
        setErrorMessage(t("chat.workspaceRemoveRunning"));
        return;
      }

      if (options.deleteWorktree !== true) {
        setErrorMessage(null);
        removeWorkspaceProjectFromSettings(project);
        return;
      }

      void (async () => {
        const repositoryPath = project.worktree?.repositoryPath.trim() || "";
        if (!path || !pathKey || !repositoryPath) {
          setErrorMessage(t("chat.workspaceDeleteWorktreeMetadataMissing"));
          return;
        }
        if (!gitClient?.removeWorktree) {
          setErrorMessage(t("chat.workspaceDeleteWorktreeUnavailable"));
          return;
        }

        setErrorMessage(null);
        try {
          let terminalSessions: TerminalSession[] = [];
          if (terminalClient && shouldInspectTerminalSessions) {
            terminalSessions = await terminalClient.list(pathKey);
          }
          const runningTerminalCount = terminalSessions.filter((session) => session.running).length;
          if (runningTerminalCount > 0) {
            const confirmed = await requestConfirmDialog({
              title: t("chat.workspaceDeleteWorktreeConfirm").replace("{name}", project.name),
              subtitle: t("chat.workspaceDeleteWorktreeDescription"),
              description: <RunningTerminalWarning count={runningTerminalCount} t={t} />,
              confirmLabel: t("chat.workspaceDeleteWorktree"),
              cancelLabel: t("chat.cancel"),
              closeLabel: t("chat.workspaceDeleteWorktreeConfirmClose"),
              tone: "warning",
            });
            if (!confirmed) return;
            if (terminalClient) {
              await terminalClient.closeProject(pathKey);
              onPruneTerminalSessions(pathKey);
            }
          }

          const response = await gitClient.removeWorktree(repositoryPath, path, {
            deleteBranch: options.deleteBranch === true,
          });
          if (!response.worktreeRemoved) {
            setErrorMessage(response.message || response.stderr || t("chat.workspaceDeleteFailed"));
            return;
          }

          if (terminalSessions.length > 0 && runningTerminalCount === 0 && terminalClient) {
            await terminalClient.closeProject(pathKey);
            onPruneTerminalSessions(pathKey);
          }
          onCloseRightDockProject(pathKey);

          const shouldResetVisibleConversation =
            workspaceProjectPathKey(getDisplayedConversationWorkdir()) === pathKey;
          removeWorkspaceProjectFromSettings(project);
          if (shouldResetVisibleConversation) {
            startNewConversation({
              workdir: getDefaultWorkspaceProjectPath(settings.system) || undefined,
            });
          }
          onWorktreeRemoved?.();
          if (!response.ok) {
            setErrorMessage(response.message || response.stderr || t("chat.workspaceDeleteFailed"));
          }
        } catch (error) {
          setErrorMessage(errorMessageWithFallback(error, t("chat.workspaceDeleteFailed")));
        }
      })();
    },
    [
      getDisplayedConversationWorkdir,
      gitClient,
      isWorkspaceProjectRunning,
      onCloseRightDockProject,
      onPruneTerminalSessions,
      onWorktreeRemoved,
      removeWorkspaceProjectFromSettings,
      requestConfirmDialog,
      settings.system,
      shouldInspectTerminalSessions,
      startNewConversation,
      t,
      terminalClient,
    ],
  );

  return handleRemoveWorkspaceProject;
}

export function useWorkspaceProjectRemoval(params: UseWorkspaceProjectRemovalParams) {
  const {
    removeWorkspaceProjectFromSettings,
    handleArchiveWorkspaceProject,
    handleUnarchiveWorkspaceProject,
    handleWorktreeRemoved,
  } = useWorkspaceProjectSettingsActions(params);
  const handleRemoveWorkspaceProject = useWorkspaceProjectDeletion({
    ...params,
    removeWorkspaceProjectFromSettings,
  });

  return {
    removeWorkspaceProjectFromSettings,
    handleRemoveWorkspaceProject,
    handleArchiveWorkspaceProject,
    handleUnarchiveWorkspaceProject,
    handleWorktreeRemoved,
  };
}
