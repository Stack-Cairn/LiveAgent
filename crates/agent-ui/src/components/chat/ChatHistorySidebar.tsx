import { getAssistantAvatarUrl } from "@liveagent/adapters/assistantAvatar";
import { type WorkspaceProject, workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import {
  AlertCircle,
  Blend,
  Cable,
  Check,
  ChevronRight,
  CirclePlus,
  Folder,
  FolderClosed,
  FolderOpen,
  ListChecks,
  Loader2,
  PanelLeftClose,
  Plus,
  Settings,
  Share2,
  Trash2,
  X,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type {
  SidebarBatchDeleteOptions,
  SidebarBatchDeleteResult,
} from "@liveagent/ui/lib/sidebar/batchDelete";
import {
  reconcileSidebarSelection,
  updateSidebarSelection,
} from "@liveagent/ui/lib/sidebar/selection";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  Fragment,
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SidebarConversation } from "../../lib/sidebar/types";
import {
  buildWorkspaceProjectSections,
  firstUnpinnedWorkspaceProjectIndex,
  sliceWorkspaceProjectSections,
} from "../../lib/workspaceProjects";
import type { WorkspaceProjectGroup } from "../../lib/workspaceProjectTypes";
import { HistoryRow, ProjectGroupHeader, ProjectRow } from "./ChatHistorySidebarRows";
import type {
  ChatHistorySidebarProps,
  WorkspaceProjectRemoveOptions,
} from "./ChatHistorySidebarTypes";

export type {
  ChatHistorySidebarContainerSource,
  ChatHistorySidebarListStatus,
  ChatHistorySidebarMutationKind,
  ChatHistorySidebarProps,
  ChatHistorySidebarWorkspaceSource,
  WorkspaceProjectRemoveOptions,
} from "./ChatHistorySidebarTypes";
export {
  buildChatHistorySidebarBaseProps,
  buildChatHistorySidebarConversationProps,
  buildChatHistorySidebarWorkspaceProps,
} from "./ChatHistorySidebarTypes";

type PendingWorkspaceProjectAction = {
  projectId: string;
  mode: "remove" | "deleteWorktree";
};

const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 820px)";
const HISTORY_ROW_ESTIMATED_HEIGHT = 30;
const HISTORY_ROW_GAP = 2;
const HISTORY_ROW_OVERSCAN_COUNT = 8;
const HISTORY_LOAD_MORE_THRESHOLD = 12;
const PROJECT_ICON_BUTTON_CLASS =
  "h-7 w-7 rounded-lg !bg-transparent text-muted-foreground transition-colors hover:!bg-transparent hover:!text-foreground active:!bg-transparent focus-visible:!bg-transparent data-[state=open]:!bg-transparent data-[state=open]:text-foreground data-[popup-open]:!bg-transparent data-[popup-open]:text-foreground";
const SIDEBAR_SECTION_ROWS_TRANSITION_CLASS =
  "transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none";
const SIDEBAR_PROJECT_MIN_BODY_HEIGHT = 96;
const SIDEBAR_RECENT_MIN_BODY_HEIGHT = 160;
// Default share of the available height the workspace (projects) section claims
// before the user drags the resize handle. Desktop splits evenly; on mobile the
// resize handle is hidden, so bias toward the recent-conversation list — the
// primary content of the drawer — by giving the workspace a smaller default
// share so the recent section sits a little higher and gets a little more room.
const SIDEBAR_PROJECTS_BODY_DEFAULT_RATIO = 0.5;
const SIDEBAR_MOBILE_PROJECTS_BODY_DEFAULT_RATIO = 0.4;
const PROJECT_LIST_COLLAPSED_MAX = 30;
const EMPTY_PROJECT_PATH_KEYS = new Set<string>();
const HISTORY_LOADING_SKELETON_ROWS = [
  { title: "w-36", meta: "w-20" },
  { title: "w-44", meta: "w-24" },
  { title: "w-32", meta: "w-16" },
  { title: "w-40", meta: "w-28" },
  { title: "w-28", meta: "w-20" },
] as const;

function clampSidebarSectionHeight(height: number, minHeight: number, maxHeight: number) {
  return Math.round(Math.min(Math.max(height, minHeight), Math.max(minHeight, maxHeight)));
}

function isMobileSidebarLayout() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY).matches;
}

function useStableEvent<Args extends unknown[], Return>(
  handler: (...args: Args) => Return,
): (...args: Args) => Return {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  return useCallback((...args: Args) => handlerRef.current(...args), []);
}

function HistoryListLoadingSkeleton() {
  const { t } = useLocale();

  return (
    <div
      className="space-y-1.5 pt-1"
      role="status"
      aria-live="polite"
      aria-label={t("sidebar.readingHistory")}
    >
      <div className="flex items-center gap-2 px-2 pb-1 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground/75">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/35 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary/70" />
        </span>
        <span>{t("sidebar.readingHistory")}</span>
      </div>
      {HISTORY_LOADING_SKELETON_ROWS.map((row) => (
        <div key={`${row.title}-${row.meta}`} className="rounded-lg px-2 py-2.5">
          <div className="flex items-start gap-2">
            <div className="skills-skeleton-shimmer mt-1 h-3.5 w-3.5 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className={cn("skills-skeleton-shimmer h-3.5 rounded", row.title)} />
              <div className={cn("skills-skeleton-shimmer h-2.5 rounded", row.meta)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export const ChatHistorySidebar = memo(function ChatHistorySidebar(props: ChatHistorySidebarProps) {
  const {
    items,
    currentConversationId,
    busyConversationIds,
    runningConversationIds,
    listStatus,
    scopeKey = "",
    hasMore,
    isLoadingMore,
    errorMessage,
    actionErrorMessage = null,
    onDismissActionError,
    sectionsDisabled = false,
    renamingId,
    renameDraft,
    isOpen,
    fontScale = 1,
    activeView = "chat",
    showProjects = false,
    projects = [],
    workspaceProjectGroups = [],
    activeProjectId,
    missingProjectPathKeys,
    runningProjectPathKeys,
    projectsCollapsed = false,
    workspaceFolderDropActive = false,
    workspaceFolderDropHandlers,
    recentCollapsed = false,
    onProjectsCollapsedChange,
    onRecentCollapsedChange,
    onCreateProject,
    onCreateWorkspaceGroup,
    onRenameWorkspaceGroup,
    onDeleteWorkspaceGroup,
    onMoveProjectToGroup,
    onToggleWorkspaceGroupCollapsed,
    onSelectProject,
    onBrowseProjectInFileTree,
    onConfigureProject,
    onBrowseProjectInSystemFileManager,
    onSetProjectPinned,
    onRemoveProject,
    onArchiveProject,
    onUnarchiveProject,
    archivedProjectPathKeys = EMPTY_PROJECT_PATH_KEYS,
    onNewConversation,
    onSelectConversation,
    onStartRenaming,
    onRenameDraftChange,
    onCommitRename,
    onCancelRename,
    onSetPinned,
    onMoveToWorkspace,
    onMoveConversationsToWorkspace,
    canShareConversations,
    sharedConversationCount,
    onShareConversation,
    onOpenSharedConversations,
    onDeleteConversation,
    onDeleteConversations,
    onLoadMore,
    onCloseSidebar,
    onOpenSettings,
    onOpenSkillsHub,
    onOpenMcpHub,
    headerTop,
    brand,
    hideCloseButton = false,
    footerTrailing,
  } = props;
  const { t } = useLocale();

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedConversationIds, setSelectedConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isBulkMoving, setIsBulkMoving] = useState(false);
  const [bulkMoveMenuOpen, setBulkMoveMenuOpen] = useState(false);
  const [pendingProjectAction, setPendingProjectAction] =
    useState<PendingWorkspaceProjectAction | null>(null);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [isMobileMenuLayout, setIsMobileMenuLayout] = useState(isMobileSidebarLayout);
  const [projectSectionHeight, setProjectSectionHeight] = useState<number | null>(null);
  const [isProjectSectionResizing, setIsProjectSectionResizing] = useState(false);
  const [sidebarSectionMetrics, setSidebarSectionMetrics] = useState({
    containerHeight: 0,
    projectsHeaderHeight: 0,
    recentHeaderHeight: 0,
    handleHeight: 0,
    projectsContentHeight: 0,
  });
  const sidebarSectionsRef = useRef<HTMLDivElement | null>(null);
  const projectsHeaderRef = useRef<HTMLDivElement | null>(null);
  const recentHeaderRef = useRef<HTMLDivElement | null>(null);
  const sectionResizeHandleRef = useRef<HTMLButtonElement | null>(null);
  const projectsBodyRef = useRef<HTMLDivElement | null>(null);
  const sidebarSectionLayoutRef = useRef({
    projectsBodyHeight: 0,
    resizeMinHeight: 0,
    resizeMaxHeight: 0,
  });
  const projectSectionResizeFrameRef = useRef<number | null>(null);
  const projectSectionResizeCleanupRef = useRef<(() => void) | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const bulkConfirmOpenRef = useRef(false);
  // Bumped to invalidate an in-flight bulk delete: its shouldStop callback
  // starts returning true and its continuation stops touching state.
  const bulkDeleteRunRef = useRef(0);
  const bulkMoveRunRef = useRef(0);
  const { confirm: requestBulkDeleteConfirm, dialog: bulkDeleteDialog } = useConfirmDialog();
  const orderedConversationIds = useMemo(() => items.map((item) => item.id), [items]);
  const selectableConversationIds = useMemo(
    () =>
      new Set(
        sectionsDisabled
          ? []
          : items
              .filter(
                (item) => !runningConversationIds.has(item.id) && !busyConversationIds.has(item.id),
              )
              .map((item) => item.id),
      ),
    [busyConversationIds, items, runningConversationIds, sectionsDisabled],
  );
  const handleSelectConversation = useStableEvent((id: string) => {
    if (!sectionsDisabled) {
      selectionAnchorRef.current = id;
      onSelectConversation(id);
    }
  });
  const handleStartRenaming = useStableEvent((item: SidebarConversation) => {
    if (!sectionsDisabled) {
      onStartRenaming(item);
    }
  });
  const handleRenameDraftChange = useStableEvent((value: string) => {
    if (!sectionsDisabled) {
      onRenameDraftChange(value);
    }
  });
  const handleCommitRename = useStableEvent(() => {
    if (!sectionsDisabled) {
      onCommitRename();
    }
  });
  const handleCancelRename = useStableEvent(onCancelRename);
  const handleSetPinned = useStableEvent((id: string, isPinned: boolean) => {
    if (!sectionsDisabled) {
      onSetPinned(id, isPinned);
    }
  });
  const handleMoveToWorkspace = useStableEvent((id: string, cwd: string) => {
    if (!sectionsDisabled) {
      onMoveToWorkspace(id, cwd);
    }
  });
  const handleMoveConversationsToWorkspace = useStableEvent(
    (ids: readonly string[], cwd: string) => {
      if (sectionsDisabled) {
        return Promise.resolve<readonly string[]>(ids);
      }
      return onMoveConversationsToWorkspace(ids, cwd);
    },
  );
  const handleShareConversation = useStableEvent((item: SidebarConversation) => {
    if (!sectionsDisabled) {
      onShareConversation(item);
    }
  });
  const handleOpenSharedConversations = useStableEvent(() => {
    if (!sectionsDisabled) {
      onOpenSharedConversations();
    }
  });
  const handleDeleteConversation = useStableEvent((id: string) => {
    if (!sectionsDisabled) {
      onDeleteConversation(id);
    }
  });
  const handleDeleteConversations = useStableEvent(
    (ids: readonly string[], options?: SidebarBatchDeleteOptions) => {
      if (sectionsDisabled) {
        return Promise.resolve<SidebarBatchDeleteResult>({
          deletedIds: [],
          failedIds: ids,
          skippedIds: [],
        });
      }
      return onDeleteConversations(ids, options);
    },
  );
  const handleLoadMore = useStableEvent(() => {
    if (!sectionsDisabled) {
      onLoadMore();
    }
  });
  const handleSetPendingDelete = useStableEvent((id: string | null) => {
    if (!sectionsDisabled || id === null) {
      setPendingDeleteId(id);
    }
  });
  const handleSetPendingProjectAction = useStableEvent(
    (action: PendingWorkspaceProjectAction | null) => {
      if (!sectionsDisabled || action === null) {
        setPendingProjectAction(action);
      }
    },
  );
  const handleProjectsCollapsedChange = useStableEvent(() => {
    if (!sectionsDisabled) {
      onProjectsCollapsedChange?.(!projectsCollapsed);
    }
  });
  const handleRecentCollapsedChange = useStableEvent(() => {
    if (!sectionsDisabled) {
      onRecentCollapsedChange?.(!recentCollapsed);
    }
  });
  const handleShowAllProjects = useStableEvent(() => {
    if (!sectionsDisabled) {
      setShowAllProjects((current) => !current);
    }
  });
  const handleSelectProject = useStableEvent((project: WorkspaceProject) => {
    if (!sectionsDisabled) {
      onSelectProject?.(project);
    }
  });
  const handleBrowseProjectInFileTree = useStableEvent((project: WorkspaceProject) => {
    if (!sectionsDisabled) {
      onBrowseProjectInFileTree?.(project);
    }
  });
  const handleConfigureProject = useStableEvent((project: WorkspaceProject) => {
    if (!sectionsDisabled) {
      onConfigureProject?.(project);
    }
  });
  const handleBrowseProjectInSystemFileManager = useStableEvent((project: WorkspaceProject) => {
    if (!sectionsDisabled) {
      onBrowseProjectInSystemFileManager?.(project);
    }
  });
  const handleSetProjectPinned = useStableEvent((project: WorkspaceProject, isPinned: boolean) => {
    if (!sectionsDisabled) {
      onSetProjectPinned?.(project, isPinned);
    }
  });
  const handleRemoveProject = useStableEvent(
    (project: WorkspaceProject, options?: WorkspaceProjectRemoveOptions) => {
      if (!sectionsDisabled) {
        onRemoveProject?.(project, options);
      }
    },
  );
  const handleArchiveProject = useStableEvent((project: WorkspaceProject) => {
    if (!sectionsDisabled) {
      onArchiveProject?.(project);
    }
  });
  const handleUnarchiveProject = useStableEvent((project: WorkspaceProject) => {
    if (!sectionsDisabled) {
      onUnarchiveProject?.(project);
    }
  });
  const exitSelectionMode = useCallback(() => {
    bulkDeleteRunRef.current += 1;
    bulkMoveRunRef.current += 1;
    setIsBulkDeleting(false);
    setIsBulkMoving(false);
    setBulkMoveMenuOpen(false);
    setSelectionMode(false);
    setSelectedConversationIds(new Set());
    selectionAnchorRef.current = null;
  }, []);
  const enterSelectionMode = useStableEvent((initialId?: string) => {
    if (sectionsDisabled) {
      return;
    }
    setPendingDeleteId(null);
    setOpenMenuId(null);
    handleCancelRename();
    onRecentCollapsedChange?.(false);
    setSelectionMode(true);
    if (initialId && selectableConversationIds.has(initialId)) {
      setSelectedConversationIds(new Set([initialId]));
      selectionAnchorRef.current = initialId;
    } else {
      setSelectedConversationIds(new Set());
      selectionAnchorRef.current = null;
    }
  });
  const handleSelectForBulk = useStableEvent(
    (id: string, modifiers: { shiftKey: boolean; toggleKey: boolean }) => {
      if (sectionsDisabled || !selectableConversationIds.has(id)) {
        return;
      }
      setPendingDeleteId(null);
      setOpenMenuId(null);
      handleCancelRename();
      setSelectionMode(true);
      setSelectedConversationIds((current) => {
        const next = updateSidebarSelection({
          orderedIds: orderedConversationIds,
          selectableIds: selectableConversationIds,
          selectedIds: current,
          anchorId: selectionAnchorRef.current,
          targetId: id,
          shiftKey: modifiers.shiftKey,
          toggleKey: modifiers.toggleKey,
        });
        selectionAnchorRef.current = next.anchorId;
        return next.selectedIds;
      });
    },
  );
  const handleBulkDelete = useStableEvent(async () => {
    const ids = orderedConversationIds.filter(
      (id) => selectedConversationIds.has(id) && selectableConversationIds.has(id),
    );
    if (ids.length === 0 || isBulkDeleting || sectionsDisabled) {
      return;
    }

    const count = String(ids.length);
    bulkConfirmOpenRef.current = true;
    const confirmed = await requestBulkDeleteConfirm({
      title: t(
        ids.length === 1
          ? "chat.conversationBulkDeleteConfirmOne"
          : "chat.conversationBulkDeleteConfirm",
      ).replace("{count}", count),
      description: t("chat.conversationBulkDeleteDescription"),
      confirmLabel: t("chat.conversationBulkDelete"),
      cancelLabel: t("chat.cancel"),
      closeLabel: t("chat.cancel"),
      tone: "destructive",
    }).finally(() => {
      bulkConfirmOpenRef.current = false;
    });
    if (!confirmed) {
      return;
    }

    const runId = bulkDeleteRunRef.current + 1;
    bulkDeleteRunRef.current = runId;
    setIsBulkDeleting(true);
    try {
      const result = await handleDeleteConversations(ids, {
        shouldStop: () => bulkDeleteRunRef.current !== runId,
      });
      if (bulkDeleteRunRef.current !== runId) {
        // Cancelled mid-batch: exitSelectionMode already reset the selection UI.
        return;
      }
      const orderedConversationIdSet = new Set(orderedConversationIds);
      const failedIds = result.failedIds.filter((id) => orderedConversationIdSet.has(id));
      setSelectedConversationIds(new Set(failedIds));
      selectionAnchorRef.current = failedIds[0] ?? null;
      if (failedIds.length === 0) {
        setSelectionMode(false);
      }
    } finally {
      if (bulkDeleteRunRef.current === runId) {
        setIsBulkDeleting(false);
      }
    }
  });
  const handleBulkMove = useStableEvent(async (cwd: string) => {
    const ids = orderedConversationIds.filter(
      (id) => selectedConversationIds.has(id) && selectableConversationIds.has(id),
    );
    if (ids.length === 0 || isBulkMoving || sectionsDisabled) {
      return;
    }

    const runId = bulkMoveRunRef.current + 1;
    bulkMoveRunRef.current = runId;
    setIsBulkMoving(true);
    try {
      const failedIds = await handleMoveConversationsToWorkspace(ids, cwd);
      if (bulkMoveRunRef.current !== runId) {
        return;
      }
      const orderedConversationIdSet = new Set(orderedConversationIds);
      const remainingFailedIds = failedIds.filter((id) => orderedConversationIdSet.has(id));
      setSelectedConversationIds(new Set(remainingFailedIds));
      selectionAnchorRef.current = remainingFailedIds[0] ?? null;
      if (remainingFailedIds.length === 0) {
        setSelectionMode(false);
      }
    } finally {
      if (bulkMoveRunRef.current === runId) {
        setIsBulkMoving(false);
      }
    }
  });
  // Archived rows are split into their own collapsed group at the list end;
  // the render cap only applies to the active rows.
  const activeProjects = useMemo(
    () =>
      projects.filter(
        (project) => !archivedProjectPathKeys.has(workspaceProjectPathKey(project.path)),
      ),
    [archivedProjectPathKeys, projects],
  );
  const archivedProjects = useMemo(
    () =>
      projects.filter((project) =>
        archivedProjectPathKeys.has(workspaceProjectPathKey(project.path)),
      ),
    [archivedProjectPathKeys, projects],
  );
  // Projects arrive pre-sorted from the container; the view organizes them
  // into group sections (worktree projects auto-grouped under their source
  // repository) plus the ungrouped remainder. The collapsed view slices by
  // section so a group is never split.
  const projectSections = useMemo(
    () => buildWorkspaceProjectSections(activeProjects, workspaceProjectGroups ?? []),
    [activeProjects, workspaceProjectGroups],
  );
  const slicedSections = useMemo(
    () =>
      showAllProjects
        ? { sections: projectSections, hiddenProjectCount: 0 }
        : sliceWorkspaceProjectSections(projectSections, PROJECT_LIST_COLLAPSED_MAX),
    [projectSections, showAllProjects],
  );
  const renderedSections = slicedSections.sections;
  const hiddenProjectCount = slicedSections.hiddenProjectCount;
  // Divider slot between the pinned block and the rest of the projects.
  // The first section's first member determines pinned placement; a pinned or
  // running member promotes its whole section via the earliest sorted index.
  const firstUnpinnedSectionIndex = useMemo(() => {
    const firstMember = renderedSections.grouped[0]?.projects[0] ?? renderedSections.ungrouped[0];
    if (firstMember?.isPinned !== true) {
      return -1;
    }
    const groupedIndex = renderedSections.grouped.findIndex(
      (section) => section.projects[0]?.isPinned !== true,
    );
    if (groupedIndex > 0) return groupedIndex;
    if (renderedSections.ungrouped[0]?.isPinned === true) return -1;
    return renderedSections.grouped.length;
  }, [renderedSections]);
  const firstUnpinnedUngroupedIndex =
    renderedSections.grouped.length === 0
      ? firstUnpinnedWorkspaceProjectIndex(renderedSections.ungrouped)
      : -1;
  // Archiving must always leave at least one active workspace behind.
  const canArchiveProjects = Boolean(onArchiveProject) && activeProjects.length > 1;
  const [archivedGroupOpen, setArchivedGroupOpen] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupDraft, setGroupDraft] = useState("");
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [groupRenameDraft, setGroupRenameDraft] = useState("");
  const { confirm: requestGroupDeleteConfirm, dialog: groupDeleteDialog } = useConfirmDialog();

  const commitNewGroup = useCallback(() => {
    const name = groupDraft.trim();
    if (name) onCreateWorkspaceGroup?.(name);
    setCreatingGroup(false);
    setGroupDraft("");
  }, [groupDraft, onCreateWorkspaceGroup]);

  const cancelNewGroup = useCallback(() => {
    setCreatingGroup(false);
    setGroupDraft("");
  }, []);

  const commitGroupRename = useCallback(() => {
    const name = groupRenameDraft.trim();
    if (renamingGroupId && name) onRenameWorkspaceGroup?.(renamingGroupId, name);
    setRenamingGroupId(null);
    setGroupRenameDraft("");
  }, [groupRenameDraft, onRenameWorkspaceGroup, renamingGroupId]);

  const cancelGroupRename = useCallback(() => {
    setRenamingGroupId(null);
    setGroupRenameDraft("");
  }, []);

  const requestDeleteGroup = useCallback(
    async (group: WorkspaceProjectGroup) => {
      const confirmed = await requestGroupDeleteConfirm({
        title: t("chat.workspaceGroupDeleteConfirmTitle").replace("{name}", group.name),
        description: t("chat.workspaceGroupDeleteConfirmDescription"),
        confirmLabel: t("chat.workspaceGroupDelete"),
        cancelLabel: t("chat.cancel"),
        tone: "destructive",
      });
      if (confirmed) onDeleteWorkspaceGroup?.(group.id);
    },
    [onDeleteWorkspaceGroup, requestGroupDeleteConfirm, t],
  );
  const sidebarSectionLayout = useMemo(() => {
    const {
      containerHeight,
      projectsHeaderHeight,
      recentHeaderHeight,
      handleHeight,
      projectsContentHeight,
    } = sidebarSectionMetrics;
    const measured = containerHeight > 0;
    const available = Math.max(
      0,
      containerHeight - projectsHeaderHeight - recentHeaderHeight - handleHeight,
    );
    const projectMinBodyHeight = Math.min(SIDEBAR_PROJECT_MIN_BODY_HEIGHT, available);
    const recentMinBodyHeight = Math.min(
      SIDEBAR_RECENT_MIN_BODY_HEIGHT,
      Math.max(0, available - projectMinBodyHeight),
    );
    const resizeMaxHeight = Math.max(0, available - recentMinBodyHeight);
    const resizeMinHeight = Math.max(
      0,
      Math.min(projectsContentHeight, projectMinBodyHeight, resizeMaxHeight),
    );
    const projectsBodyDefaultRatio = isMobileMenuLayout
      ? SIDEBAR_MOBILE_PROJECTS_BODY_DEFAULT_RATIO
      : SIDEBAR_PROJECTS_BODY_DEFAULT_RATIO;
    const defaultProjectsBodyHeight = clampSidebarSectionHeight(
      Math.min(projectsContentHeight, Math.floor(available * projectsBodyDefaultRatio)),
      resizeMinHeight,
      resizeMaxHeight,
    );

    let projectsBodyHeight = 0;
    if (showProjects && !projectsCollapsed) {
      if (recentCollapsed) {
        projectsBodyHeight = available;
      } else if (projectSectionHeight !== null) {
        projectsBodyHeight = clampSidebarSectionHeight(
          projectSectionHeight,
          resizeMinHeight,
          resizeMaxHeight,
        );
      } else {
        projectsBodyHeight = defaultProjectsBodyHeight;
      }
    }
    const recentBodyHeight = recentCollapsed ? 0 : Math.max(0, available - projectsBodyHeight);

    const projectsBodyTrack =
      !showProjects || projectsCollapsed
        ? "0px"
        : measured
          ? `${projectsBodyHeight}px`
          : "min-content";
    const recentBodyTrack = recentCollapsed
      ? "0px"
      : measured
        ? `${recentBodyHeight}px`
        : "minmax(0, 1fr)";
    const gridTemplateRows = showProjects
      ? `auto ${projectsBodyTrack} auto auto ${recentBodyTrack}`
      : `auto ${recentBodyTrack}`;

    return { projectsBodyHeight, resizeMinHeight, resizeMaxHeight, gridTemplateRows };
  }, [
    isMobileMenuLayout,
    projectSectionHeight,
    projectsCollapsed,
    recentCollapsed,
    showProjects,
    sidebarSectionMetrics,
  ]);
  const canResizeProjectSections =
    !sectionsDisabled &&
    showProjects &&
    !projectsCollapsed &&
    !recentCollapsed &&
    sidebarSectionLayout.resizeMaxHeight > sidebarSectionLayout.resizeMinHeight;
  sidebarSectionLayoutRef.current = {
    projectsBodyHeight: sidebarSectionLayout.projectsBodyHeight,
    resizeMinHeight: sidebarSectionLayout.resizeMinHeight,
    resizeMaxHeight: sidebarSectionLayout.resizeMaxHeight,
  };
  const handleMenuOpenChange = useStableEvent((id: string, open: boolean) => {
    if (open && sectionsDisabled) {
      return;
    }
    setOpenMenuId((current) => {
      if (open) {
        return id;
      }
      return current === id ? null : current;
    });
  });
  const handleProjectMenuOpenChange = useStableEvent((projectId: string, open: boolean) => {
    if (open && sectionsDisabled) {
      return;
    }
    setOpenProjectMenuId((current) => {
      if (open) {
        return projectId;
      }
      return current === projectId ? null : current;
    });
  });
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQueryList = window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY);
    const syncMobileLayout = () => setIsMobileMenuLayout(mediaQueryList.matches);

    syncMobileLayout();
    mediaQueryList.addEventListener("change", syncMobileLayout);
    return () => mediaQueryList.removeEventListener("change", syncMobileLayout);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setOpenMenuId(null);
      setOpenProjectMenuId(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!sectionsDisabled) {
      return;
    }

    setOpenMenuId(null);
    setOpenProjectMenuId(null);
    setPendingDeleteId(null);
    setPendingProjectAction(null);
    exitSelectionMode();
    handleCancelRename();
    projectSectionResizeCleanupRef.current?.();
    if (projectSectionResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(projectSectionResizeFrameRef.current);
      projectSectionResizeFrameRef.current = null;
    }
    setIsProjectSectionResizing(false);
  }, [exitSelectionMode, handleCancelRename, sectionsDisabled]);

  useEffect(() => {
    if (!pendingProjectAction) {
      return;
    }
    if (!projects.some((project) => project.id === pendingProjectAction.projectId)) {
      setPendingProjectAction(null);
    }
  }, [pendingProjectAction, projects]);

  useEffect(() => {
    if (pendingDeleteId !== null || renamingId !== null) {
      setOpenMenuId(null);
    }
  }, [pendingDeleteId, renamingId]);

  useEffect(() => {
    if (selectionMode) {
      setOpenMenuId(null);
    }
  }, [selectionMode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: selection cannot cross sidebar scopes
  useEffect(() => {
    exitSelectionMode();
  }, [exitSelectionMode, scopeKey]);

  useEffect(() => {
    setSelectedConversationIds((current) => {
      const next = reconcileSidebarSelection({
        orderedIds: orderedConversationIds,
        selectableIds: selectableConversationIds,
        selectedIds: current,
        anchorId: selectionAnchorRef.current,
      });
      selectionAnchorRef.current = next.anchorId;
      return next.selectedIds;
    });
  }, [orderedConversationIds, selectableConversationIds]);

  useEffect(() => {
    if (!selectionMode) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || bulkConfirmOpenRef.current) {
        return;
      }
      // Escape inside the composer or any text field belongs to that editor,
      // not to the sidebar selection.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      exitSelectionMode();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [exitSelectionMode, selectionMode]);

  const menuSide = isMobileMenuLayout ? "bottom" : "right";
  const historyScrollRef = useRef<HTMLDivElement | null>(null);
  // Divider slot between the pinned block and the rest: index of the first
  // unpinned row, only when at least one pinned row sits above it.
  const firstUnpinnedHistoryIndex = useMemo(() => {
    if (items[0]?.isPinned !== true) {
      return -1;
    }
    const index = items.findIndex((item) => item.isPinned !== true);
    return index > 0 ? index : -1;
  }, [items]);
  const getHistoryItemKey = useCallback((index: number) => items[index]?.id ?? index, [items]);
  const historyVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => historyScrollRef.current,
    estimateSize: () => HISTORY_ROW_ESTIMATED_HEIGHT + HISTORY_ROW_GAP,
    getItemKey: getHistoryItemKey,
    overscan: HISTORY_ROW_OVERSCAN_COUNT,
  });
  const virtualHistoryRows = historyVirtualizer.getVirtualItems();
  const lastVirtualHistoryIndex =
    virtualHistoryRows.length > 0 ? virtualHistoryRows[virtualHistoryRows.length - 1].index : -1;

  // Workspace switch: land the new scope at the top; the scope-keyed content
  // wrapper below replays the soft enter transition at the same time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope identity intentionally drives the reset
  useEffect(() => {
    historyScrollRef.current?.scrollTo({ top: 0 });
  }, [scopeKey]);

  useEffect(() => {
    if (
      sectionsDisabled ||
      !hasMore ||
      listStatus === "loading" ||
      listStatus === "initial" ||
      isLoadingMore ||
      recentCollapsed ||
      items.length === 0 ||
      lastVirtualHistoryIndex < items.length - HISTORY_LOAD_MORE_THRESHOLD
    ) {
      return;
    }
    handleLoadMore();
  }, [
    sectionsDisabled,
    hasMore,
    listStatus,
    isLoadingMore,
    items.length,
    lastVirtualHistoryIndex,
    handleLoadMore,
    recentCollapsed,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run to (re)observe section refs when sections mount/unmount or toggle
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const container = sidebarSectionsRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    let frameId = 0;
    const measure = () => {
      frameId = 0;
      setSidebarSectionMetrics((previous) => {
        const next = {
          containerHeight: container.clientHeight,
          projectsHeaderHeight: projectsHeaderRef.current?.offsetHeight ?? 0,
          recentHeaderHeight: recentHeaderRef.current?.offsetHeight ?? 0,
          handleHeight: sectionResizeHandleRef.current?.offsetHeight ?? 0,
          projectsContentHeight: projectsBodyRef.current?.offsetHeight ?? 0,
        };
        if (
          previous.containerHeight === next.containerHeight &&
          previous.projectsHeaderHeight === next.projectsHeaderHeight &&
          previous.recentHeaderHeight === next.recentHeaderHeight &&
          previous.handleHeight === next.handleHeight &&
          previous.projectsContentHeight === next.projectsContentHeight
        ) {
          return previous;
        }
        return next;
      });
    };
    const scheduleMeasure = () => {
      if (frameId !== 0) {
        return;
      }
      frameId = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    window.addEventListener("resize", scheduleMeasure);
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(container);
    const observedTargets = [
      projectsHeaderRef.current,
      recentHeaderRef.current,
      sectionResizeHandleRef.current,
      projectsBodyRef.current,
    ];
    for (const target of observedTargets) {
      if (target) {
        resizeObserver.observe(target);
      }
    }

    return () => {
      window.removeEventListener("resize", scheduleMeasure);
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver.disconnect();
    };
  }, [isOpen, projectsCollapsed, recentCollapsed, showProjects]);

  useEffect(() => {
    return () => {
      projectSectionResizeCleanupRef.current?.();
      if (projectSectionResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(projectSectionResizeFrameRef.current);
      }
    };
  }, []);

  const handleProjectSectionResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (sectionsDisabled || event.button !== 0 || !canResizeProjectSections) {
        return;
      }

      event.preventDefault();
      projectSectionResizeCleanupRef.current?.();

      const pointerId = event.pointerId;
      const resizeTarget = event.currentTarget;
      const startY = event.clientY;
      const layout = sidebarSectionLayoutRef.current;
      const startHeight = clampSidebarSectionHeight(
        layout.projectsBodyHeight,
        layout.resizeMinHeight,
        layout.resizeMaxHeight,
      );
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      setIsProjectSectionResizing(true);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      resizeTarget.setPointerCapture(pointerId);

      const scheduleProjectSectionHeight = (nextHeight: number) => {
        if (projectSectionResizeFrameRef.current !== null) {
          return;
        }
        projectSectionResizeFrameRef.current = window.requestAnimationFrame(() => {
          projectSectionResizeFrameRef.current = null;
          setProjectSectionHeight(nextHeight);
        });
      };

      const cleanupResize = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        window.removeEventListener("blur", handleBlur);
        if (resizeTarget.hasPointerCapture(pointerId)) {
          resizeTarget.releasePointerCapture(pointerId);
        }
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        projectSectionResizeCleanupRef.current = null;
      };

      const finishResize = () => {
        cleanupResize();
        if (projectSectionResizeFrameRef.current !== null) {
          window.cancelAnimationFrame(projectSectionResizeFrameRef.current);
          projectSectionResizeFrameRef.current = null;
        }
        setIsProjectSectionResizing(false);
      };

      const handleMove = (moveEvent: globalThis.PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) {
          return;
        }
        moveEvent.preventDefault();
        const liveLayout = sidebarSectionLayoutRef.current;
        scheduleProjectSectionHeight(
          clampSidebarSectionHeight(
            startHeight + moveEvent.clientY - startY,
            liveLayout.resizeMinHeight,
            liveLayout.resizeMaxHeight,
          ),
        );
      };

      const handleUp = (upEvent: globalThis.PointerEvent) => {
        if (upEvent.pointerId !== pointerId) {
          return;
        }
        finishResize();
      };

      const handleBlur = () => {
        finishResize();
      };

      projectSectionResizeCleanupRef.current = cleanupResize;
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
      window.addEventListener("blur", handleBlur);
    },
    [canResizeProjectSections, sectionsDisabled],
  );

  const renderHistoryRow = useCallback(
    (item: SidebarConversation) => (
      <HistoryRow
        key={item.id}
        item={item}
        isActive={currentConversationId === item.id}
        isBusy={busyConversationIds.has(item.id)}
        isRunning={runningConversationIds.has(item.id)}
        isDeleteDisabled={runningConversationIds.has(item.id)}
        canShareConversation={canShareConversations}
        isRenaming={renamingId === item.id}
        isPendingDelete={pendingDeleteId === item.id}
        isSelectionMode={selectionMode}
        isSelected={selectedConversationIds.has(item.id)}
        isSelectionDisabled={
          isBulkDeleting || isBulkMoving || !selectableConversationIds.has(item.id)
        }
        isInteractionDisabled={sectionsDisabled}
        isMobileMenuLayout={isMobileMenuLayout}
        renameDraft={renamingId === item.id ? renameDraft : ""}
        onSelectConversation={handleSelectConversation}
        onStartRenaming={handleStartRenaming}
        onRenameDraftChange={handleRenameDraftChange}
        onCommitRename={handleCommitRename}
        onCancelRename={handleCancelRename}
        onSetPinned={handleSetPinned}
        onMoveToWorkspace={handleMoveToWorkspace}
        moveWorkspaces={activeProjects}
        onShareConversation={handleShareConversation}
        onDeleteConversation={handleDeleteConversation}
        onSetPendingDelete={handleSetPendingDelete}
        onSelectForBulk={handleSelectForBulk}
        onEnterSelectionMode={enterSelectionMode}
        menuOpen={!sectionsDisabled && openMenuId === item.id}
        menuSide={menuSide}
        onMenuOpenChange={handleMenuOpenChange}
      />
    ),
    [
      currentConversationId,
      handleCancelRename,
      handleCommitRename,
      handleDeleteConversation,
      handleSelectForBulk,
      handleMenuOpenChange,
      handleRenameDraftChange,
      handleSelectConversation,
      handleMoveToWorkspace,
      handleSetPinned,
      handleSetPendingDelete,
      handleShareConversation,
      handleStartRenaming,
      busyConversationIds,
      canShareConversations,
      activeProjects,
      enterSelectionMode,
      isBulkDeleting,
      isBulkMoving,
      isMobileMenuLayout,
      menuSide,
      openMenuId,
      pendingDeleteId,
      renameDraft,
      renamingId,
      runningConversationIds,
      selectableConversationIds,
      selectedConversationIds,
      selectionMode,
      sectionsDisabled,
    ],
  );

  return (
    <aside
      aria-hidden={!isOpen}
      inert={!isOpen}
      data-state={isOpen ? "open" : "closed"}
      className={cn(
        "chat-history-sidebar zone-font-scale flex h-full shrink-0 flex-col overflow-hidden border-r border-border/50 bg-[hsl(var(--sidebar-bg))] transition-[width,opacity] duration-200 ease-out",
        isOpen ? "w-[272px] opacity-100" : "w-0 opacity-0",
      )}
      style={{ "--zone-font-scale": fontScale } as CSSProperties}
    >
      <div className="chat-history-sidebar-inner flex w-[272px] min-w-[272px] min-h-0 flex-1 flex-col">
        {headerTop}
        <div className="shrink-0 border-b border-border/50 px-2 pb-3 pt-3">
          <div className="flex items-center justify-between gap-2">
            {brand ?? (
              <div className="flex min-w-0 -translate-y-0.5 items-center gap-2">
                <img
                  src={getAssistantAvatarUrl()}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  className="h-8 w-8 shrink-0 select-none rounded-xl object-contain"
                />
                <div className="min-w-0">
                  <div className="truncate font-semibold tracking-tight">Live Agent</div>
                </div>
              </div>
            )}

            {!hideCloseButton ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onCloseSidebar}
                title={t("sidebar.closeSidebar")}
                className="h-9 w-9 shrink-0 rounded-2xl text-muted-foreground hover:text-foreground"
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            ) : null}
          </div>

          <div className="mt-3 flex flex-col gap-0.5">
            <Button
              type="button"
              variant="ghost"
              onClick={onNewConversation}
              className={cn(
                "chat-history-new-conversation-button h-[30px] w-full justify-start gap-3 rounded-lg px-3 text-[calc(14px*var(--zone-font-scale,1))] font-normal leading-5 shadow-none transition-colors",
                activeView === "chat"
                  ? "text-foreground/90 hover:bg-foreground/[0.08] hover:text-foreground active:bg-foreground/[0.1] active:text-foreground focus-visible:bg-foreground/[0.08]"
                  : "text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]",
              )}
            >
              <CirclePlus className="h-4 w-4 shrink-0 text-foreground/85" />
              <span className="chat-history-new-conversation-label">
                {t("chat.newConversation")}
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenSkillsHub?.()}
              className={cn(
                "sidebar-hub-menu-item h-[30px] w-full justify-start gap-3 rounded-lg px-3 text-[calc(14px*var(--zone-font-scale,1))] font-normal leading-5 shadow-none transition-colors",
                activeView === "skills-hub"
                  ? "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]"
                  : "text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]",
              )}
              title="Skills Hub"
            >
              <Blend
                className={cn(
                  "h-4 w-4 shrink-0",
                  activeView === "skills-hub" ? "text-amber-500" : "text-foreground/85",
                )}
              />
              <span className="truncate">Skills</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenMcpHub?.()}
              className={cn(
                "sidebar-hub-menu-item h-[30px] w-full justify-start gap-3 rounded-lg px-3 text-[calc(14px*var(--zone-font-scale,1))] font-normal leading-5 shadow-none transition-colors",
                activeView === "mcp-hub"
                  ? "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]"
                  : "text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]",
              )}
              title="MCP Hub"
            >
              <Cable
                className={cn(
                  "h-4 w-4 shrink-0",
                  activeView === "mcp-hub" ? "text-violet-500" : "text-foreground/85",
                )}
              />
              <span className="truncate">MCP</span>
            </Button>
          </div>
        </div>

        <div
          ref={sidebarSectionsRef}
          style={{ gridTemplateRows: sidebarSectionLayout.gridTemplateRows }}
          aria-disabled={sectionsDisabled || undefined}
          inert={sectionsDisabled}
          className={cn(
            "grid min-h-0 flex-1 content-start",
            isProjectSectionResizing ? undefined : SIDEBAR_SECTION_ROWS_TRANSITION_CLASS,
            sectionsDisabled && "pointer-events-none select-none opacity-50",
          )}
        >
          {showProjects ? (
            <>
              <div
                ref={projectsHeaderRef}
                data-workspace-folder-drop-zone=""
                {...workspaceFolderDropHandlers}
                className={cn(
                  "mx-1 flex items-center justify-between rounded-t-xl border-x border-t border-dashed border-transparent px-1 pb-1 pt-2 transition-colors",
                  workspaceFolderDropActive && "border-primary/40 bg-primary/[0.08]",
                )}
              >
                <button
                  type="button"
                  aria-expanded={!projectsCollapsed}
                  className="group flex min-w-0 items-center gap-1 rounded-md px-3 py-1 text-xs font-semibold text-muted-foreground outline-hidden"
                  onClick={handleProjectsCollapsedChange}
                  disabled={sectionsDisabled}
                >
                  <span className="truncate">
                    {workspaceFolderDropActive
                      ? t("chat.workspaceDropFolder")
                      : t("chat.workspaceSection")}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 opacity-0 transition-[opacity,transform] duration-300 ease-in-out group-hover:opacity-100"
                    style={{ transform: `rotate(${projectsCollapsed ? 0 : 90}deg)` }}
                  />
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(PROJECT_ICON_BUTTON_CLASS, "hover:!bg-transparent")}
                        title={t("chat.workspaceAdd")}
                        aria-label={t("chat.workspaceAdd")}
                        disabled={sectionsDisabled || (!onCreateProject && !onCreateWorkspaceGroup)}
                      />
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="right"
                    align="start"
                    sideOffset={6}
                    className="min-w-44"
                  >
                    <DropdownMenuItem
                      disabled={sectionsDisabled || !onCreateProject}
                      onSelect={() => onCreateProject?.()}
                      className="gap-2 text-xs"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>{t("chat.workspaceCreate")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={sectionsDisabled || !onCreateWorkspaceGroup}
                      onSelect={() => {
                        setCreatingGroup(true);
                        setGroupDraft("");
                      }}
                      className="gap-2 text-xs"
                    >
                      <Folder className="h-3.5 w-3.5" />
                      <span>{t("chat.workspaceGroupCreate")}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div
                aria-hidden={projectsCollapsed}
                inert={projectsCollapsed}
                data-workspace-folder-drop-zone=""
                {...workspaceFolderDropHandlers}
                className={cn(
                  "mx-1 min-h-0 overflow-y-auto overflow-x-hidden rounded-b-xl border-x border-b border-dashed border-transparent transition-[opacity,background-color,border-color] duration-300 ease-out motion-reduce:transition-none",
                  projectsCollapsed ? "opacity-0" : "opacity-100",
                  workspaceFolderDropActive && "border-primary/40 bg-primary/[0.045]",
                )}
              >
                <div ref={projectsBodyRef} className="space-y-0.5 px-2 pb-0.5">
                  {workspaceFolderDropActive ? (
                    <div
                      role="status"
                      aria-live="polite"
                      className="mb-1 flex items-center gap-2 rounded-lg border border-dashed border-primary/35 bg-primary/[0.06] px-2.5 py-2 text-[11px] leading-4 text-primary"
                    >
                      <FolderOpen className="h-4 w-4 shrink-0" />
                      <span>{t("chat.workspaceDropFolderDescription")}</span>
                    </div>
                  ) : null}
                  {creatingGroup ? (
                    <div className="flex h-[30px] items-center gap-1 rounded-lg pl-2 pr-1">
                      <Folder className="h-4 w-4 shrink-0 text-foreground/65" />
                      <Input
                        value={groupDraft}
                        onChange={(event) => setGroupDraft(event.currentTarget.value)}
                        onBlur={commitNewGroup}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitNewGroup();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            cancelNewGroup();
                          }
                        }}
                        placeholder={t("chat.workspaceGroupNamePlaceholder")}
                        className="h-7 min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[calc(13px*var(--zone-font-scale,1))] shadow-none outline-none focus-visible:border-0 focus-visible:bg-transparent"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={commitNewGroup}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-emerald-600 transition-colors hover:bg-emerald-500/10 dark:text-emerald-300"
                        aria-label={t("chat.workspaceGroupCreate")}
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={cancelNewGroup}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                        aria-label={t("chat.cancel")}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : null}
                  {renderedSections.grouped.map((section, sectionIndex) => {
                    const { group, projects: members } = section;
                    const collapsed = group.collapsed === true;
                    return (
                      <Fragment key={group.id}>
                        {sectionIndex === firstUnpinnedSectionIndex ? (
                          <div
                            aria-hidden="true"
                            className="mx-2 !my-1.5 h-px bg-gradient-to-r from-border/80 via-border/45 to-transparent"
                          />
                        ) : null}
                        <ProjectGroupHeader
                          group={group}
                          memberCount={members.length}
                          isRenaming={renamingGroupId === group.id}
                          renameDraft={groupRenameDraft}
                          onRenameDraftChange={setGroupRenameDraft}
                          onCommitRename={commitGroupRename}
                          onCancelRename={cancelGroupRename}
                          onToggleCollapsed={() => onToggleWorkspaceGroupCollapsed?.(group.id)}
                          onStartRename={() => {
                            setRenamingGroupId(group.id);
                            setGroupRenameDraft(group.name);
                          }}
                          onDelete={() => void requestDeleteGroup(group)}
                        />
                        {!collapsed
                          ? members.map((project) => {
                              const pathKey = workspaceProjectPathKey(project.path);
                              return (
                                <ProjectRow
                                  key={project.id}
                                  project={project}
                                  indented
                                  isActive={activeProjectId === project.id}
                                  isMissing={missingProjectPathKeys.has(pathKey)}
                                  isRunning={runningProjectPathKeys.has(pathKey)}
                                  pendingAction={
                                    pendingProjectAction?.projectId === project.id
                                      ? pendingProjectAction.mode
                                      : null
                                  }
                                  isInteractionDisabled={sectionsDisabled}
                                  onSelectProject={handleSelectProject}
                                  onBrowseProjectInFileTree={
                                    onBrowseProjectInFileTree
                                      ? handleBrowseProjectInFileTree
                                      : undefined
                                  }
                                  onBrowseProjectInSystemFileManager={
                                    onBrowseProjectInSystemFileManager
                                      ? handleBrowseProjectInSystemFileManager
                                      : undefined
                                  }
                                  onConfigureProject={handleConfigureProject}
                                  onSetProjectPinned={handleSetProjectPinned}
                                  onRemoveProject={handleRemoveProject}
                                  isArchived={false}
                                  canArchive={canArchiveProjects}
                                  onArchiveProject={handleArchiveProject}
                                  onUnarchiveProject={handleUnarchiveProject}
                                  onSetPendingAction={handleSetPendingProjectAction}
                                  workspaceProjectGroups={workspaceProjectGroups}
                                  onMoveProjectToGroup={onMoveProjectToGroup}
                                  menuOpen={!sectionsDisabled && openProjectMenuId === project.id}
                                  onMenuOpenChange={handleProjectMenuOpenChange}
                                />
                              );
                            })
                          : null}
                      </Fragment>
                    );
                  })}
                  {renderedSections.ungrouped.length > 0 ? (
                    <Fragment>
                      {firstUnpinnedSectionIndex === renderedSections.grouped.length &&
                      renderedSections.grouped.length > 0 ? (
                        <div
                          aria-hidden="true"
                          className="mx-2 !my-1.5 h-px bg-gradient-to-r from-border/80 via-border/45 to-transparent"
                        />
                      ) : null}
                      {renderedSections.grouped.length > 0 ? (
                        <div className="px-2 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                          {t("chat.workspaceUngrouped")}
                        </div>
                      ) : null}
                      {renderedSections.ungrouped.map((project, projectIndex) => {
                        const pathKey = workspaceProjectPathKey(project.path);
                        return (
                          <Fragment key={project.id}>
                            {projectIndex === firstUnpinnedUngroupedIndex ? (
                              <div
                                aria-hidden="true"
                                className="mx-2 !my-1.5 h-px bg-gradient-to-r from-border/80 via-border/45 to-transparent"
                              />
                            ) : null}
                            <ProjectRow
                              project={project}
                              isActive={activeProjectId === project.id}
                              isMissing={missingProjectPathKeys.has(pathKey)}
                              isRunning={runningProjectPathKeys.has(pathKey)}
                              pendingAction={
                                pendingProjectAction?.projectId === project.id
                                  ? pendingProjectAction.mode
                                  : null
                              }
                              isInteractionDisabled={sectionsDisabled}
                              onSelectProject={handleSelectProject}
                              onBrowseProjectInFileTree={
                                onBrowseProjectInFileTree
                                  ? handleBrowseProjectInFileTree
                                  : undefined
                              }
                              onBrowseProjectInSystemFileManager={
                                onBrowseProjectInSystemFileManager
                                  ? handleBrowseProjectInSystemFileManager
                                  : undefined
                              }
                              onConfigureProject={handleConfigureProject}
                              onSetProjectPinned={handleSetProjectPinned}
                              onRemoveProject={handleRemoveProject}
                              isArchived={false}
                              canArchive={canArchiveProjects}
                              onArchiveProject={handleArchiveProject}
                              onUnarchiveProject={handleUnarchiveProject}
                              onSetPendingAction={handleSetPendingProjectAction}
                              workspaceProjectGroups={workspaceProjectGroups}
                              onMoveProjectToGroup={onMoveProjectToGroup}
                              menuOpen={!sectionsDisabled && openProjectMenuId === project.id}
                              onMenuOpenChange={handleProjectMenuOpenChange}
                            />
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ) : null}
                  {hiddenProjectCount > 0 || showAllProjects ? (
                    <button
                      type="button"
                      className="flex w-full items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[calc(11.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground outline-hidden transition-colors hover:!bg-foreground/[0.06] hover:text-foreground active:!bg-foreground/[0.1] focus-visible:!bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={handleShowAllProjects}
                      disabled={sectionsDisabled}
                    >
                      {showAllProjects
                        ? t("chat.workspaceShowLessProjects")
                        : t("chat.workspaceShowAllProjects").replace(
                            "{count}",
                            String(activeProjects.length),
                          )}
                    </button>
                  ) : null}
                  {archivedProjects.length > 0 ? (
                    <div className="pt-0.5">
                      <button
                        type="button"
                        onClick={() => setArchivedGroupOpen((current) => !current)}
                        disabled={sectionsDisabled}
                        className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[calc(11.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground/80 outline-hidden transition-colors hover:!bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ChevronRight
                          className={cn(
                            "h-3 w-3 shrink-0 transition-transform duration-200",
                            archivedGroupOpen && "rotate-90",
                          )}
                        />
                        {t("chat.workspaceArchivedGroup").replace(
                          "{count}",
                          String(archivedProjects.length),
                        )}
                      </button>
                      {archivedGroupOpen
                        ? archivedProjects.map((project) => {
                            const pathKey = workspaceProjectPathKey(project.path);
                            return (
                              <ProjectRow
                                key={project.id}
                                project={project}
                                isActive={activeProjectId === project.id}
                                isMissing={missingProjectPathKeys.has(pathKey)}
                                isRunning={runningProjectPathKeys.has(pathKey)}
                                pendingAction={
                                  pendingProjectAction?.projectId === project.id
                                    ? pendingProjectAction.mode
                                    : null
                                }
                                isInteractionDisabled={sectionsDisabled}
                                onSelectProject={handleSelectProject}
                                onBrowseProjectInFileTree={
                                  onBrowseProjectInFileTree
                                    ? handleBrowseProjectInFileTree
                                    : undefined
                                }
                                onBrowseProjectInSystemFileManager={
                                  onBrowseProjectInSystemFileManager
                                    ? handleBrowseProjectInSystemFileManager
                                    : undefined
                                }
                                onConfigureProject={handleConfigureProject}
                                onSetProjectPinned={handleSetProjectPinned}
                                onRemoveProject={handleRemoveProject}
                                isArchived
                                canArchive={false}
                                onArchiveProject={handleArchiveProject}
                                onUnarchiveProject={handleUnarchiveProject}
                                onSetPendingAction={handleSetPendingProjectAction}
                                menuOpen={!sectionsDisabled && openProjectMenuId === project.id}
                                onMenuOpenChange={handleProjectMenuOpenChange}
                              />
                            );
                          })
                        : null}
                    </div>
                  ) : null}
                </div>
              </div>
              <button
                ref={sectionResizeHandleRef}
                type="button"
                aria-label={t("chat.resizeSidebarSections")}
                title={t("chat.resizeSidebarSections")}
                disabled={!canResizeProjectSections}
                onPointerDown={handleProjectSectionResizeStart}
                className={cn(
                  // Always render the handle as a grid item so it keeps occupying its
                  // grid-template-rows track. `hidden` (display:none) would drop it from
                  // the grid below `md`, auto-shifting the recent-conversation body out of
                  // its sized track and collapsing the list to ~0 height on mobile. The
                  // draggable handle only becomes visible from `md` upwards.
                  "group items-center justify-center border-0 bg-transparent p-0 focus-visible:outline-none",
                  canResizeProjectSections
                    ? "flex h-0 overflow-hidden cursor-row-resize touch-none md:h-2 md:overflow-visible"
                    : "flex h-0 overflow-hidden",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-0.5 w-10 rounded-full bg-muted-foreground/25 opacity-70 shadow-sm transition-[width,background-color,opacity]",
                    "group-hover:w-16 group-hover:bg-primary/60 group-hover:opacity-100 group-focus-visible:w-16 group-focus-visible:bg-primary group-focus-visible:opacity-100",
                    isProjectSectionResizing && "w-20 bg-primary opacity-100",
                    !canResizeProjectSections && "hidden",
                  )}
                />
              </button>
            </>
          ) : null}

          <div
            ref={recentHeaderRef}
            className={cn(
              "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 pb-2",
              showProjects ? "border-t border-border/35 pt-0.5" : "pt-3",
            )}
          >
            {selectionMode ? (
              <div
                role="status"
                aria-live="polite"
                className="flex min-w-0 items-center gap-1.5 px-3 py-1 text-xs font-semibold text-foreground/85"
              >
                <ListChecks className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">
                  {t("chat.conversationBulkSelectedCount").replace(
                    "{count}",
                    String(selectedConversationIds.size),
                  )}
                </span>
              </div>
            ) : (
              <button
                type="button"
                aria-expanded={!recentCollapsed}
                className="group flex min-w-0 items-center gap-1 rounded-md px-3 py-1 text-xs font-semibold text-muted-foreground outline-hidden"
                onClick={handleRecentCollapsedChange}
                disabled={sectionsDisabled}
              >
                <span className="min-w-0 truncate">{t("chat.recentConversation")}</span>
                <ChevronRight
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 opacity-0 transition-[opacity,transform] duration-300 ease-in-out group-hover:opacity-100"
                  style={{ transform: `rotate(${recentCollapsed ? 0 : 90}deg)` }}
                />
              </button>
            )}
            <div className="flex items-center gap-1.5">
              {selectionMode ? (
                <>
                  <DropdownMenu
                    open={bulkMoveMenuOpen}
                    onOpenChange={(open) => {
                      if (!sectionsDisabled || !open) {
                        setBulkMoveMenuOpen(open);
                      }
                    }}
                  >
                    <DropdownMenuTrigger
                      type="button"
                      disabled={
                        sectionsDisabled ||
                        selectedConversationIds.size === 0 ||
                        isBulkDeleting ||
                        isBulkMoving ||
                        activeProjects.length === 0
                      }
                      className={cn(
                        PROJECT_ICON_BUTTON_CLASS,
                        "inline-flex items-center justify-center",
                        "disabled:pointer-events-none disabled:opacity-50",
                      )}
                      title={t("chat.conversationMoveToWorkspace")}
                      aria-label={t("chat.conversationMoveToWorkspace")}
                    >
                      {isBulkMoving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Folder className="h-3.5 w-3.5" />
                      )}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      side="top"
                      align="start"
                      collisionPadding={12}
                      className="sidebar-context-menu max-h-[18rem] min-w-[12rem] overflow-y-auto rounded-xl border-border/60 bg-background/95 backdrop-blur-xl"
                    >
                      {activeProjects.map((workspace) => (
                        <DropdownMenuItem
                          key={workspace.id}
                          onSelect={() => void handleBulkMove(workspace.path)}
                          className="gap-2"
                        >
                          <FolderClosed className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{workspace.path}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={handleBulkDelete}
                    disabled={
                      sectionsDisabled ||
                      selectedConversationIds.size === 0 ||
                      isBulkDeleting ||
                      isBulkMoving
                    }
                    className={cn(PROJECT_ICON_BUTTON_CLASS, "text-destructive")}
                    title={t("chat.conversationBulkDelete")}
                    aria-label={t("chat.conversationBulkDelete")}
                  >
                    {isBulkDeleting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={exitSelectionMode}
                    className={PROJECT_ICON_BUTTON_CLASS}
                    title={t("chat.cancel")}
                    aria-label={t("chat.cancel")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  {listStatus === "syncing" ? (
                    <span
                      role="status"
                      aria-live="polite"
                      className="flex items-center gap-1 rounded-full border border-primary/20 bg-primary/[0.06] px-2 py-0.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium text-primary/80"
                    >
                      <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/35 opacity-75" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary/70" />
                      </span>
                      {t("chat.history.syncing")}
                    </span>
                  ) : null}
                  {errorMessage ? (
                    <span
                      role="status"
                      title={`${t("chat.historyReadFailed")}: ${errorMessage}`}
                      className="flex h-7 w-7 items-center justify-center text-destructive"
                    >
                      <AlertCircle
                        className="h-3.5 w-3.5 shrink-0"
                        aria-label={t("chat.historyReadFailed")}
                      />
                    </span>
                  ) : null}
                  {items.length > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => enterSelectionMode()}
                      disabled={sectionsDisabled || selectableConversationIds.size === 0}
                      className={PROJECT_ICON_BUTTON_CLASS}
                      title={t("chat.conversationBulkSelectHint")}
                      aria-label={t("chat.conversationBulkSelect")}
                    >
                      <ListChecks className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  {canShareConversations ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={handleOpenSharedConversations}
                      disabled={sectionsDisabled}
                      className={PROJECT_ICON_BUTTON_CLASS}
                      title={t("chat.manageSharedConversations").replace(
                        "{count}",
                        String(sharedConversationCount),
                      )}
                      aria-label={t("chat.manageSharedConversations").replace(
                        "{count}",
                        String(sharedConversationCount),
                      )}
                    >
                      <Share2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </div>

          <div
            aria-hidden={recentCollapsed}
            inert={recentCollapsed}
            className={cn(
              "flex min-h-0 flex-col transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
              recentCollapsed
                ? "pointer-events-none -translate-y-2 opacity-0"
                : "translate-y-0 opacity-100",
            )}
          >
            {/* Read failures surface as the red count badge in the section
                header. Mutation/project errors keep their own message surface
                and never replace or relabel the successfully loaded rows. */}
            {actionErrorMessage ? (
              <div className="shrink-0 px-2 pb-2">
                <div
                  role="alert"
                  title={actionErrorMessage}
                  className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-[calc(11px*var(--zone-font-scale,1))] leading-4 text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{actionErrorMessage}</span>
                  {onDismissActionError ? (
                    <button
                      type="button"
                      className="ml-auto shrink-0 rounded p-0.5 hover:bg-destructive/10"
                      onClick={onDismissActionError}
                      title={t("chat.cancel")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div
              ref={historyScrollRef}
              aria-busy={listStatus === "loading" || listStatus === "syncing" || isLoadingMore}
              className="chat-history-list min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3"
            >
              {items.length > 0 ? (
                <div
                  key={scopeKey || "scope"}
                  className="chat-history-scope-enter relative"
                  style={{ height: historyVirtualizer.getTotalSize() }}
                >
                  {virtualHistoryRows.map((virtualRow) => {
                    const item = items[virtualRow.index];
                    if (!item) return null;

                    return (
                      <div
                        key={virtualRow.key}
                        data-index={virtualRow.index}
                        ref={historyVirtualizer.measureElement}
                        className="absolute inset-x-0 top-0 pb-0.5"
                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                      >
                        {virtualRow.index === firstUnpinnedHistoryIndex ? (
                          <div
                            aria-hidden="true"
                            className="mx-2 mb-1.5 mt-1 h-px bg-gradient-to-r from-border/80 via-border/45 to-transparent"
                          />
                        ) : null}
                        {renderHistoryRow(item)}
                      </div>
                    );
                  })}
                </div>
              ) : listStatus === "loading" || listStatus === "initial" ? (
                <HistoryListLoadingSkeleton />
              ) : listStatus === "ready" && !errorMessage ? (
                <div className="chat-history-scope-enter flex items-center justify-center px-4 py-8 text-center">
                  <p className="text-xs font-medium text-muted-foreground/60">
                    {t("chat.emptyChatHistory")}
                  </p>
                </div>
              ) : null}
              {items.length > 0 && (hasMore || isLoadingMore) ? (
                <div className="px-2 pb-2 pt-1 text-center text-[calc(11px*var(--zone-font-scale,1))] leading-5 text-muted-foreground/70">
                  {isLoadingMore
                    ? t("sidebar.loadingMoreHistory")
                    : t("sidebar.continueLoadingHistory")}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-border/50 bg-[hsl(var(--sidebar-bg))] px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            onClick={onOpenSettings}
            className="h-8 w-full justify-start gap-2.5 rounded-lg px-2.5 text-[calc(13px*var(--zone-font-scale,1))] font-normal text-foreground/85 shadow-none hover:bg-foreground/[0.08] hover:text-foreground"
            title={t("tooltip.settings")}
          >
            <Settings className="h-4 w-4 shrink-0 text-foreground/75" />
            <span className="truncate">{t("tooltip.settings")}</span>
          </Button>
          {footerTrailing}
        </div>
      </div>
      {bulkDeleteDialog}
      {groupDeleteDialog}
    </aside>
  );
});
