// Container between the sidebar store and the GUI sidebar view. Owns every
// rendering subscription to the store (so sidebar commits never re-render
// ChatPage), the conversation-rename UI state, the delete flow, and the
// error-code → i18n mapping. NOT mirrored — the web end has its own container.

import {
  buildChatHistorySidebarBaseProps,
  buildChatHistorySidebarConversationProps,
  buildChatHistorySidebarWorkspaceProps,
  ChatHistorySidebar,
  type ChatHistorySidebarContainerSource,
} from "@liveagent/ui/components/chat/ChatHistorySidebar";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { SidebarBatchDeleteOptions } from "@liveagent/ui/lib/sidebar/batchDelete";
import { deleteSidebarConversations } from "@liveagent/ui/lib/sidebar/batchDelete";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import { useSidebarContainerState } from "@liveagent/ui/lib/sidebar/useSidebarContainerState";
import { sortWorkspaceProjectsByActivity } from "@liveagent/ui/lib/workspaceProjects";
import { useCallback, useMemo, useState } from "react";
import {
  DesktopSidebarBrand,
  DesktopSidebarTitleBar,
  DesktopSidebarUpdate,
  hideDesktopSidebarCloseButton,
} from "../../../agent-ui-adapters/sidebarChrome";
import type { AppUpdateController } from "../../../lib/appUpdates";
import { normalizeConversationTitle } from "../../../lib/chat/page/chatPageHelpers";
import type { WorkspaceProject, WorkspaceProjectGroup } from "../../../lib/settings";
import {
  moveConversationsToWorkspace,
  moveConversationToWorkspace,
} from "./conversationWorkspaceMove";

type ChatSidebarContainerProps = ChatHistorySidebarContainerSource & {
  store: SidebarStore;
  workspaceProjectGroups: WorkspaceProjectGroup[];
  onCreateWorkspaceGroup: (name: string) => void;
  onRenameWorkspaceGroup: (groupId: string, name: string) => void;
  onDeleteWorkspaceGroup: (groupId: string) => void;
  onMoveProjectToGroup: (projectPath: string, groupId: string | null) => void;
  onToggleWorkspaceGroupCollapsed: (groupId: string) => void;
  onBrowseProjectInSystemFileManager: (project: WorkspaceProject) => void;
  // Invoked after the store confirmed a deletion; ChatPage cleans artifacts
  // and replaces the current conversation when needed.
  onConversationDeleted: (id: string) => void;
  onConversationCwdChanged: (id: string, cwd: string) => void;
  onConversationWorkbenchDragIntent?: (
    item: SidebarConversation,
    event: { pointerId: number; clientX: number; clientY: number },
  ) => void;
  onConversationOpenInWorkbenchSplit?: (item: SidebarConversation) => void;
  onProjectWorkbenchDragIntent?: (
    project: WorkspaceProject,
    event: { pointerId: number; clientX: number; clientY: number },
  ) => void;
  appUpdate?: AppUpdateController;
};

export function ChatSidebarContainer(props: ChatSidebarContainerProps) {
  const { store, projects, onConversationDeleted, onConversationCwdChanged } = props;
  const { t } = useLocale();

  const {
    items,
    listState,
    scopeKey,
    runningConversationIds,
    mutations: busyConversationIds,
    mutationErrors,
    projectActivityInputs,
  } = useSidebarContainerState(store);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const sortedProjects = useMemo(
    () =>
      sortWorkspaceProjectsByActivity(projects, {
        projectActivityUpdatedAts: projectActivityInputs.workdirActivity,
        runningProjectPathKeys: projectActivityInputs.runningWorkdirPathKeys,
      }),
    [projectActivityInputs.runningWorkdirPathKeys, projectActivityInputs.workdirActivity, projects],
  );

  const handleStartRenaming = useCallback(
    (item: SidebarConversation) => {
      store.clearMutationError(item.id);
      setRenamingId(item.id);
      setRenameDraft(item.title);
    },
    [store],
  );

  const handleCommitRename = () => {
    const id = renamingId;
    setRenamingId(null);
    setRenameDraft("");
    if (!id) {
      return;
    }
    const title = normalizeConversationTitle(renameDraft);
    const current = store.peek(id);
    if (!title || !current || title === current.title) {
      return;
    }
    void store.rename(id, title);
  };

  const handleCancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameDraft("");
  }, []);

  const handleSetPinned = useCallback(
    (id: string, isPinned: boolean) => {
      store.clearMutationError(id);
      void store.setPinned(id, isPinned);
    },
    [store],
  );

  const handleMoveToWorkspace = useCallback(
    (id: string, cwd: string) => {
      void moveConversationToWorkspace(store, id, cwd, onConversationCwdChanged);
    },
    [onConversationCwdChanged, store],
  );

  const handleMoveConversationsToWorkspace = useCallback(
    async (ids: readonly string[], cwd: string) => {
      return moveConversationsToWorkspace(store, ids, cwd, onConversationCwdChanged);
    },
    [onConversationCwdChanged, store],
  );

  const handleDeleteConversation = useCallback(
    (id: string) => {
      store.clearMutationError(id);
      void store.remove(id).then((removed) => {
        if (removed) {
          onConversationDeleted(id);
        }
      });
    },
    [onConversationDeleted, store],
  );

  const handleDeleteConversations = useCallback(
    async (ids: readonly string[], options?: SidebarBatchDeleteOptions) => {
      const result = await deleteSidebarConversations(
        ids,
        async (id) => {
          store.clearMutationError(id);
          return store.remove(id);
        },
        options,
      );
      for (const id of result.deletedIds) {
        onConversationDeleted(id);
      }
      return result;
    },
    [onConversationDeleted, store],
  );

  const handleLoadMore = useCallback(() => {
    void store.loadMore();
  }, [store]);

  // A per-row mutation error is more actionable (and dismissable) than the
  // list error, so it takes the banner slot when both exist.
  const firstMutationError = mutationErrors.entries().next();
  let errorMessage: string | null = null;
  let actionErrorMessage: string | null = null;
  let handleDismissActionError: (() => void) | undefined;
  if (!firstMutationError.done) {
    const [errorConversationId, errorCode] = firstMutationError.value;
    actionErrorMessage = t(`chat.history.${errorCode}`);
    handleDismissActionError = () => store.clearMutationError(errorConversationId);
  } else if (listState.error) {
    errorMessage = listState.errorDetail?.trim() || t(`chat.history.${listState.error}`);
  }

  return (
    <ChatHistorySidebar
      {...buildChatHistorySidebarBaseProps(props, {
        items,
        runningConversationIds,
        busyConversationIds,
        listState,
        scopeKey,
        errorMessage,
        actionErrorMessage,
        onDismissActionError: handleDismissActionError,
        renamingId,
        renameDraft,
      })}
      {...buildChatHistorySidebarWorkspaceProps(
        props,
        sortedProjects,
        projectActivityInputs.runningWorkdirPathKeys,
      )}
      {...buildChatHistorySidebarConversationProps(props, {
        onStartRenaming: handleStartRenaming,
        onRenameDraftChange: setRenameDraft,
        onCommitRename: handleCommitRename,
        onCancelRename: handleCancelRename,
        onSetPinned: handleSetPinned,
        onMoveToWorkspace: handleMoveToWorkspace,
        onMoveConversationsToWorkspace: handleMoveConversationsToWorkspace,
        onDeleteConversation: handleDeleteConversation,
        onDeleteConversations: handleDeleteConversations,
        onLoadMore: handleLoadMore,
      })}
      onConversationWorkbenchDragIntent={props.onConversationWorkbenchDragIntent}
      onConversationOpenInWorkbenchSplit={props.onConversationOpenInWorkbenchSplit}
      onProjectWorkbenchDragIntent={props.onProjectWorkbenchDragIntent}
      headerTop={<DesktopSidebarTitleBar />}
      brand={<DesktopSidebarBrand />}
      hideCloseButton={hideDesktopSidebarCloseButton()}
      footerTrailing={<DesktopSidebarUpdate appUpdate={props.appUpdate} />}
    />
  );
}
