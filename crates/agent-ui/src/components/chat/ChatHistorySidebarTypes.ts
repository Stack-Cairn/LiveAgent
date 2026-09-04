import type { WorkspaceProject } from "@liveagent/app/lib/settings";
import type {
  SidebarBatchDeleteOptions,
  SidebarBatchDeleteResult,
} from "@liveagent/ui/lib/sidebar/batchDelete";
import type { ReactNode } from "react";
import type { SidebarConversation } from "../../lib/sidebar/types";
import type { WorkspaceProjectGroup } from "../../lib/workspaceProjectTypes";

export type ChatHistorySidebarListStatus = "initial" | "loading" | "syncing" | "ready";

export type ChatHistorySidebarMutationKind = "rename" | "pin" | "move" | "delete";

export type WorkspaceProjectRemoveOptions = {
  deleteWorktree?: boolean;
  deleteBranch?: boolean;
};

export type WorkspaceFolderDropHandlers = {
  onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
};

export type ChatHistorySidebarProps = {
  items: readonly SidebarConversation[];
  currentConversationId: string;
  // Per-row in-flight mutations: only that row's menu/inputs disable.
  busyConversationIds: ReadonlyMap<string, ChatHistorySidebarMutationKind>;
  runningConversationIds: ReadonlySet<string>;
  /** Conversations currently blocked on an explicit tool approval. */
  approvalConversationIds?: ReadonlySet<string>;
  listStatus: ChatHistorySidebarListStatus;
  // Identity of the current list scope (workspace/text mode). A change
  // remounts the list content with a soft enter transition and resets scroll.
  scopeKey?: string;
  totalItems: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  // Only the current recent-conversation list read state drives the count Tag.
  errorMessage: string | null;
  // Mutation/project-operation failures have a separate surface so they are
  // never mislabeled as "failed to read history" by the count Tag.
  actionErrorMessage?: string | null;
  onDismissActionError?: () => void;
  // Disables the workspace + recent-conversation sections as one block while
  // either the browser transport or desktop Agent is unavailable; the top
  // sidebar actions stay usable.
  sectionsDisabled?: boolean;
  renamingId: string | null;
  renameDraft: string;
  isOpen: boolean;
  fontScale?: number;
  /** Incremented by the desktop host when its configured search shortcut fires. */
  conversationSearchRequestKey?: number;
  /** Display label for the enabled desktop shortcut (for example, ⌘⇧K). */
  conversationSearchShortcutLabel?: string;
  activeView?: "chat" | "skills-hub" | "mcp-hub";
  showProjects?: boolean;
  // Pre-sorted by the container (pinned/running/activity); rendered as-is.
  projects?: WorkspaceProject[];
  // Sidebar project groups; worktree projects are auto-grouped under their
  // source repository project.
  workspaceProjectGroups?: WorkspaceProjectGroup[];
  activeProjectId?: string;
  missingProjectPathKeys: ReadonlySet<string>;
  runningProjectPathKeys: ReadonlySet<string>;
  projectsCollapsed?: boolean;
  workspaceFolderDropActive?: boolean;
  /**
   * Web 端把 DOM 拖放事件接到工作空间分区（桌面端走 Tauri 原生事件与坐标
   * 命中，不传此项）。四个回调整体可选，由宿主决定拖入行为。
   */
  workspaceFolderDropHandlers?: WorkspaceFolderDropHandlers;
  recentCollapsed?: boolean;
  onProjectsCollapsedChange?: (collapsed: boolean) => void;
  onRecentCollapsedChange?: (collapsed: boolean) => void;
  onCreateProject?: () => void;
  onCreateWorkspaceGroup?: (name: string) => void;
  onRenameWorkspaceGroup?: (groupId: string, name: string) => void;
  onDeleteWorkspaceGroup?: (groupId: string) => void;
  onMoveProjectToGroup?: (projectPath: string, groupId: string | null) => void;
  onToggleWorkspaceGroupCollapsed?: (groupId: string) => void;
  onSelectProject?: (project: WorkspaceProject) => void;
  onNewConversationForProject?: (project: WorkspaceProject) => void;
  onBrowseProjectInFileTree?: (project: WorkspaceProject) => void;
  onConfigureProject?: (project: WorkspaceProject) => void;
  onBrowseProjectInSystemFileManager?: (project: WorkspaceProject) => void;
  onSetProjectPinned?: (project: WorkspaceProject, isPinned: boolean) => void;
  onRemoveProject?: (project: WorkspaceProject, options?: WorkspaceProjectRemoveOptions) => void;
  onArchiveProject?: (project: WorkspaceProject) => void;
  onUnarchiveProject?: (project: WorkspaceProject) => void;
  // Path keys of archived workspaces; those rows render disabled in a
  // collapsed group at the end of the list.
  archivedProjectPathKeys?: ReadonlySet<string>;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  /** Workbench drag intent from a conversation row title (desktop pointer). */
  onConversationWorkbenchDragIntent?: (
    item: SidebarConversation,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** Menu alternative to dragging: open a conversation in a split pane. */
  onConversationOpenInWorkbenchSplit?: (item: SidebarConversation) => void;
  /** Workbench drag intent from a project row title (creates a conversation). */
  onProjectWorkbenchDragIntent?: (
    project: WorkspaceProject,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  onStartRenaming: (item: SidebarConversation) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSetPinned: (id: string, isPinned: boolean) => void;
  onMoveToWorkspace: (id: string, cwd: string) => void;
  onMoveConversationsToWorkspace: (
    ids: readonly string[],
    cwd: string,
  ) => Promise<readonly string[]>;
  canShareConversations: boolean;
  sharedConversationCount: number;
  onShareConversation: (item: SidebarConversation) => void;
  onOpenSharedConversations: () => void;
  onDeleteConversation: (id: string) => void;
  onDeleteConversations: (
    ids: readonly string[],
    options?: SidebarBatchDeleteOptions,
  ) => Promise<SidebarBatchDeleteResult>;
  onLoadMore: () => void;
  onCloseSidebar: () => void;
  onOpenSettings: () => void;
  onOpenSkillsHub?: () => void;
  onOpenMcpHub?: () => void;
  headerTop?: ReactNode;
  brand?: ReactNode;
  hideCloseButton?: boolean;
  footerTrailing?: ReactNode;
};

export type ChatHistorySidebarWorkspaceSource = Pick<
  ChatHistorySidebarProps,
  | "showProjects"
  | "workspaceProjectGroups"
  | "activeProjectId"
  | "missingProjectPathKeys"
  | "projectsCollapsed"
  | "workspaceFolderDropActive"
  | "workspaceFolderDropHandlers"
  | "recentCollapsed"
  | "onProjectsCollapsedChange"
  | "onRecentCollapsedChange"
  | "onCreateProject"
  | "onCreateWorkspaceGroup"
  | "onRenameWorkspaceGroup"
  | "onDeleteWorkspaceGroup"
  | "onMoveProjectToGroup"
  | "onToggleWorkspaceGroupCollapsed"
  | "onSelectProject"
  | "onNewConversationForProject"
  | "onBrowseProjectInFileTree"
  | "onBrowseProjectInSystemFileManager"
  | "onConfigureProject"
  | "onSetProjectPinned"
  | "onRemoveProject"
  | "onArchiveProject"
  | "onUnarchiveProject"
  | "archivedProjectPathKeys"
>;

type OptionalWorkspaceSourceKey =
  | "workspaceProjectGroups"
  | "workspaceFolderDropActive"
  | "workspaceFolderDropHandlers"
  | "onCreateWorkspaceGroup"
  | "onRenameWorkspaceGroup"
  | "onDeleteWorkspaceGroup"
  | "onMoveProjectToGroup"
  | "onToggleWorkspaceGroupCollapsed"
  | "onBrowseProjectInSystemFileManager"
  | "archivedProjectPathKeys";

export type ChatHistorySidebarContainerSource = Required<
  Pick<
    ChatHistorySidebarWorkspaceSource,
    Exclude<keyof ChatHistorySidebarWorkspaceSource, OptionalWorkspaceSourceKey>
  >
> &
  Pick<ChatHistorySidebarWorkspaceSource, OptionalWorkspaceSourceKey> &
  Pick<
    ChatHistorySidebarProps,
    | "currentConversationId"
    | "isOpen"
    | "fontScale"
    | "conversationSearchRequestKey"
    | "conversationSearchShortcutLabel"
    | "onNewConversation"
    | "onSelectConversation"
    | "canShareConversations"
    | "sharedConversationCount"
    | "onShareConversation"
    | "onOpenSharedConversations"
    | "onCloseSidebar"
    | "onOpenSettings"
  > &
  Required<Pick<ChatHistorySidebarProps, "activeView" | "onOpenSkillsHub" | "onOpenMcpHub">> & {
    projects: WorkspaceProject[];
  };

type ChatHistorySidebarConversationSource = Pick<
  ChatHistorySidebarContainerSource,
  | "onNewConversation"
  | "onSelectConversation"
  | "canShareConversations"
  | "sharedConversationCount"
  | "onShareConversation"
  | "onOpenSharedConversations"
  | "onCloseSidebar"
  | "onOpenSettings"
  | "onOpenSkillsHub"
  | "onOpenMcpHub"
>;

type ChatHistorySidebarConversationHandlers = Pick<
  ChatHistorySidebarProps,
  | "onStartRenaming"
  | "onRenameDraftChange"
  | "onCommitRename"
  | "onCancelRename"
  | "onSetPinned"
  | "onMoveToWorkspace"
  | "onMoveConversationsToWorkspace"
  | "onDeleteConversation"
  | "onDeleteConversations"
  | "onLoadMore"
>;

type ChatHistorySidebarBaseState = Pick<
  ChatHistorySidebarProps,
  | "items"
  | "runningConversationIds"
  | "busyConversationIds"
  | "scopeKey"
  | "errorMessage"
  | "actionErrorMessage"
  | "onDismissActionError"
  | "sectionsDisabled"
  | "renamingId"
  | "renameDraft"
> & {
  listState: {
    status: ChatHistorySidebarListStatus;
    totalCount: number;
    hasMore: boolean;
    isLoadingMore: boolean;
  };
};

export function buildChatHistorySidebarBaseProps(
  source: Pick<
    ChatHistorySidebarContainerSource,
    | "currentConversationId"
    | "isOpen"
    | "fontScale"
    | "conversationSearchRequestKey"
    | "conversationSearchShortcutLabel"
    | "activeView"
  >,
  state: ChatHistorySidebarBaseState,
) {
  return {
    items: state.items,
    currentConversationId: source.currentConversationId,
    runningConversationIds: state.runningConversationIds,
    busyConversationIds: state.busyConversationIds,
    listStatus: state.listState.status,
    scopeKey: state.scopeKey,
    totalItems: state.listState.totalCount,
    hasMore: state.listState.hasMore,
    isLoadingMore: state.listState.isLoadingMore,
    errorMessage: state.errorMessage,
    actionErrorMessage: state.actionErrorMessage,
    onDismissActionError: state.onDismissActionError,
    sectionsDisabled: state.sectionsDisabled,
    renamingId: state.renamingId,
    renameDraft: state.renameDraft,
    isOpen: source.isOpen,
    fontScale: source.fontScale,
    conversationSearchRequestKey: source.conversationSearchRequestKey,
    conversationSearchShortcutLabel: source.conversationSearchShortcutLabel,
    activeView: source.activeView,
  };
}

export function buildChatHistorySidebarConversationProps(
  source: ChatHistorySidebarConversationSource,
  handlers: ChatHistorySidebarConversationHandlers,
) {
  return {
    onNewConversation: source.onNewConversation,
    onSelectConversation: source.onSelectConversation,
    ...handlers,
    canShareConversations: source.canShareConversations,
    sharedConversationCount: source.sharedConversationCount,
    onShareConversation: source.onShareConversation,
    onOpenSharedConversations: source.onOpenSharedConversations,
    onCloseSidebar: source.onCloseSidebar,
    onOpenSettings: source.onOpenSettings,
    onOpenSkillsHub: source.onOpenSkillsHub,
    onOpenMcpHub: source.onOpenMcpHub,
  };
}

export function buildChatHistorySidebarWorkspaceProps(
  source: ChatHistorySidebarWorkspaceSource,
  projects: WorkspaceProject[],
  runningProjectPathKeys: ReadonlySet<string>,
) {
  return {
    showProjects: source.showProjects,
    projects,
    workspaceProjectGroups: source.workspaceProjectGroups,
    activeProjectId: source.activeProjectId,
    missingProjectPathKeys: source.missingProjectPathKeys,
    runningProjectPathKeys,
    projectsCollapsed: source.projectsCollapsed,
    workspaceFolderDropActive: source.workspaceFolderDropActive,
    workspaceFolderDropHandlers: source.workspaceFolderDropHandlers,
    recentCollapsed: source.recentCollapsed,
    onProjectsCollapsedChange: source.onProjectsCollapsedChange,
    onRecentCollapsedChange: source.onRecentCollapsedChange,
    onCreateProject: source.onCreateProject,
    onCreateWorkspaceGroup: source.onCreateWorkspaceGroup,
    onRenameWorkspaceGroup: source.onRenameWorkspaceGroup,
    onDeleteWorkspaceGroup: source.onDeleteWorkspaceGroup,
    onMoveProjectToGroup: source.onMoveProjectToGroup,
    onToggleWorkspaceGroupCollapsed: source.onToggleWorkspaceGroupCollapsed,
    onSelectProject: source.onSelectProject,
    onNewConversationForProject: source.onNewConversationForProject,
    onBrowseProjectInFileTree: source.onBrowseProjectInFileTree,
    onBrowseProjectInSystemFileManager: source.onBrowseProjectInSystemFileManager,
    onConfigureProject: source.onConfigureProject,
    onSetProjectPinned: source.onSetProjectPinned,
    onRemoveProject: source.onRemoveProject,
    onArchiveProject: source.onArchiveProject,
    onUnarchiveProject: source.onUnarchiveProject,
    archivedProjectPathKeys: source.archivedProjectPathKeys,
  };
}
