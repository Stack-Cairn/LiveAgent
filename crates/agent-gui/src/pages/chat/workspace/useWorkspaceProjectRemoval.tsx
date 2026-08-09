import type { ConfirmDialogOptions } from "@liveagent/ui/components/ui/confirm-dialog";
import { memoryDeleteProject } from "@liveagent/ui/lib/memory/api";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { terminalSessionBelongsToProject } from "@liveagent/ui/lib/terminal/sessionStore";
import type { TerminalSession } from "@liveagent/ui/lib/terminal/types";
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from "react";
import { Terminal } from "../../../components/icons";
import {
  type ConversationPersistenceCursor,
  deleteChatHistory,
} from "../../../lib/chat/history/chatHistory";
import {
  type AppSettings,
  DEFAULT_WORKSPACE_PROJECT_ID,
  removeRightDockProjectState,
  resetWorkspaceResourceSettings,
  resolveWorkspaceProjects,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "../../../lib/settings";
import { tauriTerminalClient } from "../../../lib/terminal/tauriTerminalClient";
import { asErrorMessage } from "../chatPageUtils";
import type { ConversationRuntimeEntry } from "../runtime/chatPageRuntime";
import {
  getDefaultWorkspaceProjectPath,
  listChatHistoryIdsForProjectPath,
} from "./workspaceProjectsModel";

type UseWorkspaceProjectRemovalParams = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
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
  ) => void;
  setActiveWorkspaceProjectId: Dispatch<SetStateAction<string>>;
  setProjectRenamingId: Dispatch<SetStateAction<string | null>>;
  setProjectRenameDraft: Dispatch<SetStateAction<string>>;
  isConversationRunning: (conversationId: string) => boolean;
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  conversationPersistenceCursorRef: MutableRefObject<Map<string, ConversationPersistenceCursor>>;
  locallySyncedHistoryUpdatedAtRef: MutableRefObject<Map<string, number>>;
  deleteConversationLocalCaches: (conversationId: string) => void;
  disposeSubagentsForConversation: (conversationId: string) => void;
  removeSharedHistoryItems: (ids: Iterable<string>) => void;
  terminalProjectPathKey: string;
  setTerminalSessions: Dispatch<SetStateAction<TerminalSession[]>>;
  setRightDockOpen: Dispatch<SetStateAction<boolean>>;
  displayedConversationWorkdir: string;
  startNewConversationActionRef: MutableRefObject<(options?: { workdir?: string }) => void>;
};

/**
 * Destructive workspace-project actions: full removal (conversations,
 * terminals, memory, settings) plus archive/unarchive. Split from
 * useWorkspaceProjects because removal needs the conversation/terminal cache
 * plumbing that only exists later in ChatPage's wiring order.
 */
export function useWorkspaceProjectRemoval(params: UseWorkspaceProjectRemovalParams) {
  const {
    settings,
    setSettings,
    t,
    requestConfirmDialog,
    setErrorMessage,
    sidebarStore,
    workspaceProjects,
    archivedWorkspaceProjectPathKeys,
    activeWorkspaceProject,
    activateWorkspaceProject,
    setActiveWorkspaceProjectId,
    setProjectRenamingId,
    setProjectRenameDraft,
    isConversationRunning,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    conversationPersistenceCursorRef,
    locallySyncedHistoryUpdatedAtRef,
    deleteConversationLocalCaches,
    disposeSubagentsForConversation,
    removeSharedHistoryItems,
    terminalProjectPathKey,
    setTerminalSessions,
    setRightDockOpen,
    displayedConversationWorkdir,
    startNewConversationActionRef,
  } = params;

  const removeWorkspaceProjectFromSettings = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;
      const path = project.path.trim();
      const pathKey = workspaceProjectPathKey(path);
      // Removing the last non-archived workspace would leave nothing usable;
      // the default project is unarchived alongside in that case. The merged
      // list (settings + history workdirs) is the authority on what remains.
      const hasOtherActiveProjects = workspaceProjects.some(
        (item) =>
          item.id !== project.id &&
          workspaceProjectPathKey(item.path) !== pathKey &&
          !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(item.path)),
      );
      setActiveWorkspaceProjectId((current) => {
        const currentProject = workspaceProjects.find((item) => item.id === current);
        if (
          current === project.id ||
          (pathKey && currentProject && workspaceProjectPathKey(currentProject.path) === pathKey)
        ) {
          return DEFAULT_WORKSPACE_PROJECT_ID;
        }
        return current;
      });
      setSettings((prev) => {
        const nextHidden =
          pathKey &&
          prev.system.hiddenWorkspaceProjectPaths.some(
            (item) => workspaceProjectPathKey(item) === pathKey,
          )
            ? prev.system.hiddenWorkspaceProjectPaths
            : path
              ? [...prev.system.hiddenWorkspaceProjectPaths, path]
              : prev.system.hiddenWorkspaceProjectPaths;
        const nextSettings = {
          ...prev,
          system: resolveWorkspaceProjects(
            {
              ...prev.system,
              workspaceProjects: prev.system.workspaceProjects.filter(
                (item) => item.id !== project.id && workspaceProjectPathKey(item.path) !== pathKey,
              ),
              hiddenWorkspaceProjectPaths: nextHidden,
              missingWorkspaceProjectPaths: prev.system.missingWorkspaceProjectPaths.filter(
                (item) => workspaceProjectPathKey(item) !== pathKey,
              ),
              archivedWorkspaceProjectPaths: prev.system.archivedWorkspaceProjectPaths.filter(
                (item) => {
                  const itemKey = workspaceProjectPathKey(item);
                  if (itemKey === pathKey) return false;
                  return (
                    hasOtherActiveProjects ||
                    itemKey !== workspaceProjectPathKey(getDefaultWorkspaceProjectPath(prev.system))
                  );
                },
              ),
            },
            getDefaultWorkspaceProjectPath(prev.system),
          ),
        };
        return removeRightDockProjectState(
          resetWorkspaceResourceSettings(nextSettings, pathKey),
          pathKey,
        );
      });
      setProjectRenamingId((current) => (current === project.id ? null : current));
      setProjectRenameDraft("");
    },
    [archivedWorkspaceProjectPathKeys, setSettings, workspaceProjects],
  );

  const handleRemoveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      if (project.id === DEFAULT_WORKSPACE_PROJECT_ID) return;

      void (async () => {
        const path = project.path.trim();
        const pathKey = workspaceProjectPathKey(path);
        const runningMessage = "项目中仍有后台任务运行，暂时不能删除该项目。";
        if (pathKey && sidebarStore.getSnapshot().runningWorkdirPathKeys.has(pathKey)) {
          setErrorMessage(runningMessage);
          return;
        }

        setErrorMessage(null);

        try {
          const conversationIds = await listChatHistoryIdsForProjectPath(path);
          const sidebarRunningIds = sidebarStore.getSnapshot().runningConversationIds;
          const runningConversationIdsInProject = conversationIds.filter((id) => {
            const key = id.trim();
            return key ? isConversationRunning(key) || sidebarRunningIds.has(key) : false;
          });
          if (runningConversationIdsInProject.length > 0) {
            setErrorMessage(runningMessage);
            return;
          }

          const terminalSessions = pathKey ? await tauriTerminalClient.list(pathKey) : [];
          const runningTerminalCount = terminalSessions.filter((session) => session.running).length;
          if (runningTerminalCount > 0) {
            const confirmed = await requestConfirmDialog({
              title: t("chat.workspaceRemoveConfirm").replace("{name}", project.name),
              subtitle: t("chat.workspaceRemoveDescription"),
              description: (
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
                        {runningTerminalCount}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                      {t("chat.workspaceRemoveTerminalDescription")}
                    </p>
                  </div>
                </div>
              ),
              confirmLabel: t("chat.workspaceRemoveConfirmContinue"),
              cancelLabel: t("chat.cancel"),
              closeLabel: t("chat.workspaceRemoveConfirmClose"),
              tone: "warning",
            });
            if (!confirmed) return;
          }

          for (const conversationId of conversationIds) {
            await deleteChatHistory(conversationId);
          }

          const deletedConversationIds = new Set(conversationIds);
          if (deletedConversationIds.size > 0) {
            for (const conversationId of deletedConversationIds) {
              sidebarStore.removeLocal(conversationId);
            }
            removeSharedHistoryItems(deletedConversationIds);
            for (const conversationId of deletedConversationIds) {
              conversationPersistenceCursorRef.current.delete(conversationId);
              conversationRuntimeCacheRef.current.delete(conversationId);
              locallySyncedHistoryUpdatedAtRef.current.delete(conversationId);
              deleteConversationLocalCaches(conversationId);
              disposeSubagentsForConversation(conversationId);
            }
          }
          if (terminalSessions.length > 0) {
            await tauriTerminalClient.closeProject(pathKey);
            setTerminalSessions((current) =>
              current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
            );
          }
          if (pathKey && terminalProjectPathKey === pathKey) {
            setRightDockOpen(false);
            setTerminalSessions((current) =>
              current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
            );
          }

          const visibleConversationId = currentConversationIdRef.current;
          const shouldResetVisibleConversation =
            Boolean(visibleConversationId && deletedConversationIds.has(visibleConversationId)) ||
            Boolean(pathKey && workspaceProjectPathKey(displayedConversationWorkdir) === pathKey);

          if (path) {
            await memoryDeleteProject({
              workdir: path,
              actor: "tool",
              reason: "workspace project removed",
            });
          }
          removeWorkspaceProjectFromSettings(project);
          if (shouldResetVisibleConversation) {
            startNewConversationActionRef.current({
              workdir: getDefaultWorkspaceProjectPath(settings.system) || undefined,
            });
          }
        } catch (error) {
          setErrorMessage(asErrorMessage(error, "删除项目失败"));
        }
      })();
    },
    [
      deleteConversationLocalCaches,
      displayedConversationWorkdir,
      isConversationRunning,
      removeWorkspaceProjectFromSettings,
      settings.system,
      sidebarStore,
      terminalProjectPathKey,
    ],
  );

  const handleArchiveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey || archivedWorkspaceProjectPathKeys.has(pathKey)) return;
      const fallbackProject = workspaceProjects.find(
        (item) =>
          item.id !== project.id &&
          workspaceProjectPathKey(item.path) !== pathKey &&
          !archivedWorkspaceProjectPathKeys.has(workspaceProjectPathKey(item.path)),
      );
      // Archiving is only offered while another active workspace remains.
      if (!fallbackProject) return;
      if (
        activeWorkspaceProject &&
        (activeWorkspaceProject.id === project.id ||
          workspaceProjectPathKey(activeWorkspaceProject.path) === pathKey)
      ) {
        activateWorkspaceProject(fallbackProject);
      }
      setSettings((prev) =>
        prev.system.archivedWorkspaceProjectPaths.some(
          (path) => workspaceProjectPathKey(path) === pathKey,
        )
          ? prev
          : {
              ...prev,
              system: {
                ...prev.system,
                archivedWorkspaceProjectPaths: [
                  ...prev.system.archivedWorkspaceProjectPaths,
                  project.path.trim(),
                ],
              },
            },
      );
    },
    [
      activateWorkspaceProject,
      activeWorkspaceProject,
      archivedWorkspaceProjectPathKeys,
      setSettings,
      workspaceProjects,
    ],
  );

  const handleUnarchiveWorkspaceProject = useCallback(
    (project: WorkspaceProject) => {
      const pathKey = workspaceProjectPathKey(project.path);
      if (!pathKey) return;
      setSettings((prev) => {
        const next = prev.system.archivedWorkspaceProjectPaths.filter(
          (path) => workspaceProjectPathKey(path) !== pathKey,
        );
        if (next.length === prev.system.archivedWorkspaceProjectPaths.length) {
          return prev;
        }
        return {
          ...prev,
          system: {
            ...prev.system,
            archivedWorkspaceProjectPaths: next,
          },
        };
      });
    },
    [setSettings],
  );

  return {
    handleRemoveWorkspaceProject,
    handleArchiveWorkspaceProject,
    handleUnarchiveWorkspaceProject,
  };
}
