// Container between the sidebar store and the GUI sidebar view. Owns every
// rendering subscription to the store (so sidebar commits never re-render
// ChatPage), the conversation-rename UI state, the delete flow, and the
// error-code → i18n mapping. NOT mirrored — the web end has its own container.

import { ChatHistorySidebar } from "@liveagent/ui/components/chat/ChatHistorySidebar";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { SidebarBatchDeleteOptions } from "@liveagent/ui/lib/sidebar/batchDelete";
import { deleteSidebarConversations } from "@liveagent/ui/lib/sidebar/batchDelete";
import {
  selectConversations,
  selectListState,
  selectProjectActivityInputs,
  selectRunningConversationIds,
  sidebarShallowEqual,
} from "@liveagent/ui/lib/sidebar/selectors";
import type { SidebarSnapshot, SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
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
import type { WorkspaceProject } from "../../../lib/settings";

type ChatSidebarContainerProps = {
  store: SidebarStore;
  currentConversationId: string;
  isOpen: boolean;
  fontScale?: number;
  activeView: "chat" | "skills-hub" | "mcp-hub";
  showProjects: boolean;
  // Merged (settings ∪ history workdirs) but unsorted — the container sorts
  // with the store's activity/running inputs.
  projects: WorkspaceProject[];
  activeProjectId?: string;
  missingProjectPathKeys: ReadonlySet<string>;
  projectRenamingId: string | null;
  projectRenameDraft: string;
  projectsCollapsed: boolean;
  recentCollapsed: boolean;
  onProjectsCollapsedChange: (collapsed: boolean) => void;
  onRecentCollapsedChange: (collapsed: boolean) => void;
  onCreateProject: () => void;
  onSelectProject: (project: WorkspaceProject) => void;
  onNewConversationForProject: (project: WorkspaceProject) => void;
  onBrowseProjectInFileTree: (project: WorkspaceProject) => void;
  onBrowseProjectInSystemFileManager: (project: WorkspaceProject) => void;
  onConfigureProjectResources: (project: WorkspaceProject) => void;
  onStartRenamingProject: (project: WorkspaceProject) => void;
  onProjectRenameDraftChange: (value: string) => void;
  onCommitProjectRename: () => void;
  onCancelProjectRename: () => void;
  onSetProjectPinned: (project: WorkspaceProject, isPinned: boolean) => void;
  onRemoveProject: (project: WorkspaceProject) => void;
  onArchiveProject: (project: WorkspaceProject) => void;
  onUnarchiveProject: (project: WorkspaceProject) => void;
  archivedProjectPathKeys?: ReadonlySet<string>;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  // Invoked after the store confirmed a deletion; ChatPage cleans artifacts
  // and replaces the current conversation when needed.
  onConversationDeleted: (id: string) => void;
  canShareConversations: boolean;
  sharedConversationCount: number;
  onShareConversation: (item: SidebarConversation) => void;
  onOpenSharedConversations: () => void;
  onCloseSidebar: () => void;
  onOpenSettings: () => void;
  appUpdate?: AppUpdateController;
  onOpenSkillsHub: () => void;
  onOpenMcpHub: () => void;
};

function selectMutations(snapshot: SidebarSnapshot) {
  return snapshot.mutations;
}

function selectMutationErrors(snapshot: SidebarSnapshot) {
  return snapshot.mutationErrors;
}

export function ChatSidebarContainer(props: ChatSidebarContainerProps) {
  const { store, projects, onConversationDeleted } = props;
  const { t } = useLocale();

  const items = useSidebarSelector(store, selectConversations);
  const listState = useSidebarSelector(store, selectListState, sidebarShallowEqual);
  const scopeKey = useSidebarSelector(store, (snapshot) => snapshot.scopeKey);
  const runningConversationIds = useSidebarSelector(store, selectRunningConversationIds);
  const busyConversationIds = useSidebarSelector(store, selectMutations);
  const mutationErrors = useSidebarSelector(store, selectMutationErrors);
  const projectActivityInputs = useSidebarSelector(
    store,
    selectProjectActivityInputs,
    sidebarShallowEqual,
  );

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
      items={items}
      currentConversationId={props.currentConversationId}
      runningConversationIds={runningConversationIds}
      busyConversationIds={busyConversationIds}
      listStatus={listState.status}
      scopeKey={scopeKey}
      totalItems={listState.totalCount}
      hasMore={listState.hasMore}
      isLoadingMore={listState.isLoadingMore}
      errorMessage={errorMessage}
      actionErrorMessage={actionErrorMessage}
      onDismissActionError={handleDismissActionError}
      renamingId={renamingId}
      renameDraft={renameDraft}
      isOpen={props.isOpen}
      fontScale={props.fontScale}
      activeView={props.activeView}
      showProjects={props.showProjects}
      projects={sortedProjects}
      activeProjectId={props.activeProjectId}
      missingProjectPathKeys={props.missingProjectPathKeys}
      runningProjectPathKeys={projectActivityInputs.runningWorkdirPathKeys}
      projectRenamingId={props.projectRenamingId}
      projectRenameDraft={props.projectRenameDraft}
      projectsCollapsed={props.projectsCollapsed}
      recentCollapsed={props.recentCollapsed}
      onProjectsCollapsedChange={props.onProjectsCollapsedChange}
      onRecentCollapsedChange={props.onRecentCollapsedChange}
      onCreateProject={props.onCreateProject}
      onSelectProject={props.onSelectProject}
      onNewConversationForProject={props.onNewConversationForProject}
      onBrowseProjectInFileTree={props.onBrowseProjectInFileTree}
      onBrowseProjectInSystemFileManager={props.onBrowseProjectInSystemFileManager}
      onConfigureProjectResources={props.onConfigureProjectResources}
      onStartRenamingProject={props.onStartRenamingProject}
      onProjectRenameDraftChange={props.onProjectRenameDraftChange}
      onCommitProjectRename={props.onCommitProjectRename}
      onCancelProjectRename={props.onCancelProjectRename}
      onSetProjectPinned={props.onSetProjectPinned}
      onRemoveProject={props.onRemoveProject}
      onArchiveProject={props.onArchiveProject}
      onUnarchiveProject={props.onUnarchiveProject}
      archivedProjectPathKeys={props.archivedProjectPathKeys}
      onNewConversation={props.onNewConversation}
      onSelectConversation={props.onSelectConversation}
      onStartRenaming={handleStartRenaming}
      onRenameDraftChange={setRenameDraft}
      onCommitRename={handleCommitRename}
      onCancelRename={handleCancelRename}
      onSetPinned={handleSetPinned}
      canShareConversations={props.canShareConversations}
      sharedConversationCount={props.sharedConversationCount}
      onShareConversation={props.onShareConversation}
      onOpenSharedConversations={props.onOpenSharedConversations}
      onDeleteConversation={handleDeleteConversation}
      onDeleteConversations={handleDeleteConversations}
      onLoadMore={handleLoadMore}
      onCloseSidebar={props.onCloseSidebar}
      onOpenSettings={props.onOpenSettings}
      onOpenSkillsHub={props.onOpenSkillsHub}
      onOpenMcpHub={props.onOpenMcpHub}
      headerTop={<DesktopSidebarTitleBar />}
      brand={<DesktopSidebarBrand />}
      hideCloseButton={hideDesktopSidebarCloseButton()}
      footerTrailing={<DesktopSidebarUpdate appUpdate={props.appUpdate} />}
    />
  );
}
