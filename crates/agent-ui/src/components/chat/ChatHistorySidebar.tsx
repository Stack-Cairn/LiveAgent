import { type WorkspaceProject, workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import {
  AlertCircle,
  Blend,
  Brain,
  Cable,
  ChevronRight,
  CirclePlus,
  Clock3,
  Folder,
  FolderClosed,
  FolderOpen,
  ListChecks,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Search,
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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { normalizeSidebarShortcuts, SIDEBAR_SHORTCUTS } from "../../lib/settings/sidebarShortcuts";
import type { ConversationOpenOptions } from "../../lib/sidebar/openController";
import {
  buildSidebarPinnedEntries,
  reorderSidebarPinnedEntries,
  reorderSidebarProjects,
  sidebarConversationOrderKey,
  sidebarWorkspaceOrderKey,
} from "../../lib/sidebar/preferences";
import { WORKSPACE_HISTORY_PAGE_SIZE } from "../../lib/sidebar/store";
import type { SidebarConversation } from "../../lib/sidebar/types";
import { useSidebarReorderDrag } from "../../lib/sidebar/useSidebarReorderDrag";
import {
  buildWorkspaceProjectSections,
  sliceWorkspaceProjectSections,
} from "../../lib/workspaceProjects";
import type { WorkspaceProjectGroup } from "../../lib/workspaceProjectTypes";
import { HistoryRow, ProjectGroupHeader, ProjectRow } from "./ChatHistorySidebarRows";
import type {
  ChatHistorySidebarProps,
  WorkspaceProjectRemoveOptions,
} from "./ChatHistorySidebarTypes";
import { ConversationSearchDialog } from "./ConversationSearchDialog";

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
const PROJECT_ICON_BUTTON_CLASS =
  "h-7 w-7 rounded-lg !bg-transparent text-muted-foreground transition-colors hover:!bg-transparent hover:!text-foreground active:!bg-transparent focus-visible:!bg-transparent data-[state=open]:!bg-transparent data-[state=open]:text-foreground data-[popup-open]:!bg-transparent data-[popup-open]:text-foreground";
const PROJECT_LIST_COLLAPSED_MAX = 30;
const EMPTY_PROJECT_PATH_KEYS = new Set<string>();
const EMPTY_APPROVAL_CONVERSATION_IDS = new Set<string>();
const EMPTY_QUESTION_CONVERSATION_IDS = new Set<string>();
const HISTORY_LOADING_SKELETON_ROWS = [
  { title: "w-36", meta: "w-20" },
  { title: "w-44", meta: "w-24" },
  { title: "w-32", meta: "w-16" },
  { title: "w-40", meta: "w-28" },
  { title: "w-28", meta: "w-20" },
] as const;

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
    archivedConversations = [],
    onSetConversationArchived,
    onReorderProjects,
    pinnedOrder,
    onReorderPinned,
    workspaceHistory,
    onLoadWorkspaceHistory,
    currentConversationId,
    busyConversationIds,
    runningConversationIds,
    approvalConversationIds = EMPTY_APPROVAL_CONVERSATION_IDS,
    questionConversationIds = EMPTY_QUESTION_CONVERSATION_IDS,
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
    conversationSearchRequestKey,
    activeView = "chat",
    showProjects = false,
    projects = [],
    workspaceProjectGroups = [],
    activeProjectId,
    missingProjectPathKeys,
    runningProjectPathKeys,
    projectsCollapsed: persistedProjectsCollapsed = false,
    workspaceFolderDropActive = false,
    workspaceFolderDropHandlers,
    recentCollapsed: persistedRecentCollapsed = false,
    onProjectsCollapsedChange,
    onRecentCollapsedChange,
    onCreateProject,
    onRenameWorkspaceGroup,
    onDeleteWorkspaceGroup,
    onMoveProjectToGroup,
    onToggleWorkspaceGroupCollapsed,
    onSelectProject,
    onNewConversationForProject,
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
    onConversationWorkbenchDragIntent,
    onConversationOpenInWorkbenchSplit,
    onProjectWorkbenchDragIntent,
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
    sidebarShortcuts = normalizeSidebarShortcuts(undefined),
    onOpenSettings,
    onOpenResourceHub,
    headerTop,
    brand,
    hideCloseButton = false,
    footerTrailing,
  } = props;
  const { t } = useLocale();

  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [revealedSearchConversationId, setRevealedSearchConversationId] = useState<string | null>(
    null,
  );
  const pendingSearchScrollRef = useRef<string | null>(null);
  const workspaceTreeRef = useRef<HTMLDivElement | null>(null);
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const revealingSearch = revealedSearchConversationId === currentConversationId;
  const projectsCollapsed = revealingSearch ? false : persistedProjectsCollapsed;
  const recentCollapsed =
    revealedSearchConversationId === currentConversationId ? false : persistedRecentCollapsed;
  const lastConversationSearchRequestKeyRef = useRef(conversationSearchRequestKey);
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
  const archivedIds = useMemo(
    () => new Set(archivedConversations.map((item) => item.id)),
    [archivedConversations],
  );
  const sidebarSelectedProjectRef = useRef<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(activeProjectId ? [activeProjectId] : []),
  );
  useEffect(() => {
    // A title click already chose whether to expand or collapse this folder.
    // Selecting that workspace must not undo the same click's collapse.
    const selectedFromSidebar = sidebarSelectedProjectRef.current === activeProjectId;
    sidebarSelectedProjectRef.current = null;
    if (activeProjectId && !selectedFromSidebar) {
      setExpandedProjectIds((current) => new Set(current).add(activeProjectId));
    }
  }, [activeProjectId]);
  useEffect(() => {
    if (!showProjects || !isOpen || sectionsDisabled) return;
    for (const project of projects) {
      if (project.isPinned ? pinnedCollapsed : projectsCollapsed) continue;
      const history = workspaceHistory?.get(workspaceProjectPathKey(project.path));
      const archiveChanged =
        history &&
        (history.excludedIds.size !== archivedIds.size ||
          Array.from(archivedIds).some((id) => !history.excludedIds.has(id)));
      if (expandedProjectIds.has(project.id) && (!history || archiveChanged)) {
        void onLoadWorkspaceHistory?.(project.path, false, archivedIds);
      }
    }
  }, [
    expandedProjectIds,
    archivedIds,
    isOpen,
    onLoadWorkspaceHistory,
    projects,
    projectsCollapsed,
    pinnedCollapsed,
    sectionsDisabled,
    showProjects,
    workspaceHistory,
  ]);
  const toggleProjectExpanded = (project: WorkspaceProject) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(project.id)) next.delete(project.id);
      else next.add(project.id);
      return next;
    });
  };

  const [archivedConversationsOpen, setArchivedConversationsOpen] = useState(false);
  const unarchivedItems = useMemo(
    () => items.filter((item) => !archivedIds.has(item.id)),
    [archivedIds, items],
  );
  const pinnedConversations = useMemo(
    () => unarchivedItems.filter((item) => item.isPinned),
    [unarchivedItems],
  );
  const archivedItems = useMemo(
    () =>
      archivedConversations.map(
        (entry): SidebarConversation =>
          items.find((item) => item.id === entry.id) ?? {
            ...entry,
            providerId: "",
            model: "",
            createdAt: 0,
            updatedAt: 0,
          },
      ),
    [archivedConversations, items],
  );
  const handleSetConversationArchived = useStableEvent(
    (item: SidebarConversation, archived: boolean) => {
      if (
        sectionsDisabled ||
        busyConversationIds.has(item.id) ||
        runningConversationIds.has(item.id) ||
        item.isPending
      )
        return;
      setOpenMenuId(null);
      onSetConversationArchived?.(item, archived);
    },
  );

  const currentConversationWorkdir = useMemo(
    () => items.find((item) => item.id === currentConversationId)?.cwd,
    [currentConversationId, items],
  );

  useEffect(() => {
    if (!sectionsDisabled) return;
    setConversationSearchOpen(false);
  }, [sectionsDisabled]);

  useEffect(() => {
    if (
      conversationSearchRequestKey === undefined ||
      conversationSearchRequestKey === lastConversationSearchRequestKeyRef.current
    ) {
      return;
    }
    lastConversationSearchRequestKeyRef.current = conversationSearchRequestKey;
    if (!sectionsDisabled) {
      setConversationSearchOpen(true);
    }
  }, [conversationSearchRequestKey, sectionsDisabled]);
  const selectionAnchorRef = useRef<string | null>(null);
  const bulkConfirmOpenRef = useRef(false);
  // Bumped to invalidate an in-flight bulk delete: its shouldStop callback
  // starts returning true and its continuation stops touching state.
  const bulkDeleteRunRef = useRef(0);
  const bulkMoveRunRef = useRef(0);
  const { confirm: requestBulkDeleteConfirm, dialog: bulkDeleteDialog } = useConfirmDialog();
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
  const pinnedProjects = useMemo(
    () => activeProjects.filter((project) => project.isPinned),
    [activeProjects],
  );
  const pinnedEntries = useMemo(
    () => buildSidebarPinnedEntries(pinnedConversations, pinnedProjects, pinnedOrder),
    [pinnedConversations, pinnedProjects, pinnedOrder],
  );
  const projectSections = useMemo(
    () =>
      buildWorkspaceProjectSections(
        activeProjects.filter((project) => !project.isPinned),
        workspaceProjectGroups ?? [],
      ),
    [activeProjects, workspaceProjectGroups],
  );
  const slicedSections = useMemo(
    () =>
      showAllProjects || revealingSearch
        ? { sections: projectSections, hiddenProjectCount: 0 }
        : sliceWorkspaceProjectSections(projectSections, PROJECT_LIST_COLLAPSED_MAX),
    [projectSections, showAllProjects, revealingSearch],
  );
  const renderedSections = slicedSections.sections;
  const hiddenProjectCount = slicedSections.hiddenProjectCount;
  const projectConversations = useMemo(() => {
    const result = new Map<string, SidebarConversation[]>();
    for (const item of unarchivedItems) {
      if (item.isPinned) continue;
      const key = workspaceProjectPathKey(item.cwd ?? "");
      const group = result.get(key) ?? [];
      group.push(item);
      result.set(key, group);
    }
    return result;
  }, [unarchivedItems]);
  const visibleProjectConversations = useCallback(
    (project: WorkspaceProject) => {
      const key = workspaceProjectPathKey(project.path);
      const conversations = projectConversations.get(key) ?? [];
      const visible = conversations.slice(
        0,
        workspaceHistory?.get(key)?.limit ?? WORKSPACE_HISTORY_PAGE_SIZE,
      );
      const revealed = revealingSearch
        ? conversations.find((item) => item.id === currentConversationId)
        : undefined;
      return revealed && !visible.some((item) => item.id === revealed.id)
        ? [...visible, revealed]
        : visible;
    },
    [currentConversationId, projectConversations, revealingSearch, workspaceHistory],
  );
  const isGroupCollapsed = useCallback(
    (group: WorkspaceProjectGroup, members: WorkspaceProject[]) =>
      group.collapsed === true &&
      !(revealingSearch && members.some((project) => project.id === activeProjectId)),
    [activeProjectId, revealingSearch],
  );
  const visibleItems = useMemo(() => {
    if (!showProjects) return unarchivedItems;
    const visibleProjects = [
      ...(projectsCollapsed
        ? []
        : [
            ...renderedSections.grouped.flatMap((section) =>
              isGroupCollapsed(section.group, section.projects) ? [] : section.projects,
            ),
            ...renderedSections.ungrouped,
          ]),
    ];
    return [
      ...(pinnedCollapsed
        ? []
        : pinnedEntries.flatMap((entry) =>
            entry.kind === "conversation"
              ? [entry.item]
              : expandedProjectIds.has(entry.project.id)
                ? visibleProjectConversations(entry.project)
                : [],
          )),
      ...visibleProjects.flatMap((project) => {
        if (!expandedProjectIds.has(project.id)) return [];
        return visibleProjectConversations(project);
      }),
    ];
  }, [
    expandedProjectIds,
    unarchivedItems,
    pinnedEntries,
    projectsCollapsed,
    pinnedCollapsed,
    renderedSections,
    showProjects,
    isGroupCollapsed,
    visibleProjectConversations,
  ]);
  const orderedConversationIds = useMemo(() => visibleItems.map((item) => item.id), [visibleItems]);
  const visibleRunningProjectPathKeys = useMemo(() => {
    // A conversation waiting on the user — for a tool approval or for an
    // AskUserQuestion answer — is suspended, not working. Both must drop out of
    // the workspace's "running" dot the same way, or the two blocked states
    // would disagree at the project-row level.
    if (approvalConversationIds.size === 0 && questionConversationIds.size === 0) {
      return runningProjectPathKeys;
    }

    const blockedOnlyCandidates = new Set<string>();
    const activelyRunningPathKeys = new Set<string>();
    for (const item of items) {
      if (!runningConversationIds.has(item.id)) continue;
      const pathKey = workspaceProjectPathKey(item.cwd ?? "");
      if (!pathKey) continue;
      if (approvalConversationIds.has(item.id) || questionConversationIds.has(item.id)) {
        blockedOnlyCandidates.add(pathKey);
      } else {
        activelyRunningPathKeys.add(pathKey);
      }
    }

    let next: Set<string> | null = null;
    for (const pathKey of blockedOnlyCandidates) {
      if (activelyRunningPathKeys.has(pathKey) || !runningProjectPathKeys.has(pathKey)) continue;
      next ??= new Set(runningProjectPathKeys);
      next.delete(pathKey);
    }
    return next ?? runningProjectPathKeys;
  }, [
    approvalConversationIds,
    questionConversationIds,
    items,
    runningConversationIds,
    runningProjectPathKeys,
  ]);
  const selectableConversationIds = useMemo(
    () =>
      new Set(
        sectionsDisabled
          ? []
          : visibleItems
              .filter(
                (item) => !runningConversationIds.has(item.id) && !busyConversationIds.has(item.id),
              )
              .map((item) => item.id),
      ),
    [busyConversationIds, visibleItems, runningConversationIds, sectionsDisabled],
  );
  const handleSelectConversation = useStableEvent(
    (id: string, options?: ConversationOpenOptions) => {
      if (!sectionsDisabled) {
        selectionAnchorRef.current = id;
        onSelectConversation(
          id,
          options?.source === "search"
            ? {
                ...options,
                afterCommit: () => {
                  pendingSearchScrollRef.current = id;
                  setRevealedSearchConversationId(id);
                  options.afterCommit?.();
                },
              }
            : options,
        );
      }
    },
  );
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
    setRevealedSearchConversationId(null);
    if (!sectionsDisabled) {
      onProjectsCollapsedChange?.(!projectsCollapsed);
    }
  });
  const handleRecentCollapsedChange = useStableEvent(() => {
    if (!sectionsDisabled) {
      setRevealedSearchConversationId(null);
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
      sidebarSelectedProjectRef.current = project.id;
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
    if (!showProjects) onRecentCollapsedChange?.(false);
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
  // Archiving must always leave at least one active workspace behind.
  const canArchiveProjects = Boolean(onArchiveProject) && activeProjects.length > 1;
  const [archivedGroupOpen, setArchivedGroupOpen] = useState(false);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [groupRenameDraft, setGroupRenameDraft] = useState("");
  const { confirm: requestGroupDeleteConfirm, dialog: groupDeleteDialog } = useConfirmDialog();

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
      });
      if (confirmed) onDeleteWorkspaceGroup?.(group.id);
    },
    [onDeleteWorkspaceGroup, requestGroupDeleteConfirm, t],
  );
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
    if (unarchivedItems[0]?.isPinned !== true) {
      return -1;
    }
    const index = unarchivedItems.findIndex((item) => item.isPinned !== true);
    return index > 0 ? index : -1;
  }, [unarchivedItems]);
  const getHistoryItemKey = useCallback(
    (index: number) => unarchivedItems[index]?.id ?? index,
    [unarchivedItems],
  );
  const historyVirtualizer = useVirtualizer({
    count: showProjects ? 0 : unarchivedItems.length,
    getScrollElement: () => historyScrollRef.current,
    estimateSize: () => HISTORY_ROW_ESTIMATED_HEIGHT + HISTORY_ROW_GAP,
    getItemKey: getHistoryItemKey,
    overscan: HISTORY_ROW_OVERSCAN_COUNT,
  });
  const virtualHistoryRows = historyVirtualizer.getVirtualItems();
  // Workspace switch: land the new scope at the top; the scope-keyed content
  // wrapper below replays the soft enter transition at the same time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope identity intentionally drives the reset
  useEffect(() => {
    historyScrollRef.current?.scrollTo({ top: 0 });
  }, [scopeKey]);

  useEffect(() => {
    if (
      !isOpen ||
      listStatus !== "ready" ||
      revealedSearchConversationId !== currentConversationId ||
      recentCollapsed ||
      pendingSearchScrollRef.current !== currentConversationId
    )
      return;
    if (showProjects) {
      if (!visibleItems.some((item) => item.id === currentConversationId) && !activeProjectId)
        return;
      const project = projects.find((item) => item.id === activeProjectId);
      if (project && !expandedProjectIds.has(project.id)) {
        setExpandedProjectIds((current) => new Set(current).add(project.id));
        return;
      }
      if (
        pinnedCollapsed &&
        (project?.isPinned || pinnedConversations.some((item) => item.id === currentConversationId))
      ) {
        setPinnedCollapsed(false);
        return;
      }
      const row = Array.from(
        workspaceTreeRef.current?.querySelectorAll<HTMLElement>("[data-conversation-id]") ?? [],
      ).find((element) => element.dataset.conversationId === currentConversationId);
      if (!row) return;
      row.scrollIntoView({ block: "nearest" });
    } else {
      const index = unarchivedItems.findIndex((item) => item.id === revealedSearchConversationId);
      if (index < 0) return;
      historyVirtualizer.scrollToIndex(index, { align: "auto" });
    }
    pendingSearchScrollRef.current = null;
  }, [
    currentConversationId,
    historyVirtualizer,
    isOpen,
    unarchivedItems,
    showProjects,
    projects,
    activeProjectId,
    expandedProjectIds,
    pinnedCollapsed,
    pinnedConversations,
    visibleItems,
    listStatus,
    recentCollapsed,
    revealedSearchConversationId,
  ]);

  const projectGroupKey = (id: string) =>
    projectSections.grouped.find((section) => section.projects.some((project) => project.id === id))
      ?.group.id ?? "";
  const reorder = useSidebarReorderDrag({
    containerRef: workspaceTreeRef,
    disabled: sectionsDisabled || selectionMode || !isOpen,
    scopeKey,
    canDrop: (source, target) => {
      if (source === target) return false;
      const pinnedKeys = new Set(pinnedEntries.map((entry) => entry.key));
      if (pinnedKeys.has(source) || pinnedKeys.has(target)) {
        return Boolean(onReorderPinned) && pinnedKeys.has(source) && pinnedKeys.has(target);
      }
      const sourceProject = activeProjects.find(
        (project) => sidebarWorkspaceOrderKey(project.path) === source,
      );
      const targetProject = activeProjects.find(
        (project) => sidebarWorkspaceOrderKey(project.path) === target,
      );
      return Boolean(
        onReorderProjects &&
          sourceProject &&
          targetProject &&
          projectGroupKey(sourceProject.id) === projectGroupKey(targetProject.id),
      );
    },
    onDrop: (source, target, position) => {
      if (pinnedEntries.some((entry) => entry.key === source)) {
        const order = reorderSidebarPinnedEntries(pinnedEntries, source, target, position);
        if (order) onReorderPinned?.(order);
        return;
      }
      const sourceProject = activeProjects.find(
        (project) => sidebarWorkspaceOrderKey(project.path) === source,
      );
      const targetProject = activeProjects.find(
        (project) => sidebarWorkspaceOrderKey(project.path) === target,
      );
      if (!sourceProject || !targetProject) return;
      const order = reorderSidebarProjects(projects, sourceProject.id, targetProject.id, position);
      if (order) onReorderProjects?.(order);
    },
  });
  const draggedPinnedEntry = pinnedEntries.find((entry) => entry.key === reorder.draggingKey);
  const draggedWorkspace = activeProjects.find(
    (project) => sidebarWorkspaceOrderKey(project.path) === reorder.draggingKey,
  );
  const draggedTitle =
    draggedPinnedEntry?.kind === "conversation"
      ? draggedPinnedEntry.item.title
      : draggedWorkspace?.name;
  const showWorkspaceFolderDrop = workspaceFolderDropActive && !reorder.draggingKey;

  const renderHistoryRow = useCallback(
    (item: SidebarConversation, showIcon = false, archived = false) => (
      <HistoryRow
        showIcon={showIcon}
        reorderKey={
          showIcon && showProjects && !archived ? sidebarConversationOrderKey(item.id) : undefined
        }
        onReorderPointerDown={
          showIcon && showProjects && !archived && onReorderPinned
            ? reorder.onPointerDown
            : undefined
        }
        dropPosition={
          reorder.dropTarget?.key === sidebarConversationOrderKey(item.id)
            ? reorder.dropTarget.position
            : undefined
        }
        isDragging={reorder.draggingKey === sidebarConversationOrderKey(item.id)}
        isArchived={archived}
        onSetArchived={onSetConversationArchived ? handleSetConversationArchived : undefined}
        key={item.id}
        item={item}
        isActive={currentConversationId === item.id}
        isBusy={busyConversationIds.has(item.id)}
        isRunning={runningConversationIds.has(item.id)}
        needsApproval={approvalConversationIds.has(item.id)}
        hasPendingQuestion={questionConversationIds.has(item.id)}
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
        onWorkbenchDragIntent={onConversationWorkbenchDragIntent}
        onOpenInWorkbenchSplit={onConversationOpenInWorkbenchSplit}
      />
    ),
    [
      showProjects,
      onReorderPinned,
      reorder.onPointerDown,
      reorder.dropTarget,
      reorder.draggingKey,
      currentConversationId,
      handleSetConversationArchived,
      onSetConversationArchived,
      handleCancelRename,
      handleCommitRename,
      handleDeleteConversation,
      handleSelectForBulk,
      handleMenuOpenChange,
      handleRenameDraftChange,
      handleSelectConversation,
      onConversationWorkbenchDragIntent,
      onConversationOpenInWorkbenchSplit,
      handleMoveToWorkspace,
      handleSetPinned,
      handleSetPendingDelete,
      handleShareConversation,
      handleStartRenaming,
      busyConversationIds,
      canShareConversations,
      activeProjects,
      approvalConversationIds,
      questionConversationIds,
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

  const renderProjectConversations = (project: WorkspaceProject, indented = false) => {
    if (!expandedProjectIds.has(project.id)) return null;
    const key = workspaceProjectPathKey(project.path);
    const state = workspaceHistory?.get(key);
    const conversations = projectConversations.get(key) ?? [];
    const visible = visibleProjectConversations(project);
    const canLoadMore = conversations.length > visible.length || state?.hasMore === true;
    return (
      <div
        data-testid={`workspace-conversations-${project.id}`}
        className={cn("mb-2 ml-3 pl-2", indented && "ml-7")}
      >
        {visible.map((item) => renderHistoryRow(item))}
        {!state || (state.loading && visible.length === 0) ? (
          <div role="status" className="px-2 py-2 text-xs text-muted-foreground">
            {t("sidebar.readingHistory")}
          </div>
        ) : visible.length === 0 && !state.error ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            {t("chat.emptyChatHistory")}
          </div>
        ) : null}
        {state?.error ? (
          <div role="alert" className="px-2 py-1 text-xs text-destructive">
            {state.error}
          </div>
        ) : null}
        {canLoadMore || state?.error ? (
          <button
            type="button"
            disabled={sectionsDisabled || state?.loading}
            onClick={() => void onLoadWorkspaceHistory?.(project.path, !state?.error, archivedIds)}
            className="flex h-[30px] w-full items-center rounded-md px-2 text-left text-[calc(14px*var(--zone-font-scale,1))] font-normal leading-5 text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {state?.loading
              ? t("sidebar.loadingMoreHistory")
              : state?.error
                ? t("chat.workspaceHistoryRetry")
                : t("sidebar.continueLoadingHistory")}
          </button>
        ) : null}
      </div>
    );
  };

  const hasVisibleActiveConversation =
    visibleItems.some((item) => item.id === currentConversationId) ||
    (archivedConversationsOpen && archivedItems.some((item) => item.id === currentConversationId));
  const renderWorkspaceProject = (
    project: WorkspaceProject,
    indented = false,
    archived = false,
  ) => {
    const pathKey = workspaceProjectPathKey(project.path);
    return (
      <Fragment key={project.id}>
        <ProjectRow
          project={project}
          indented={indented}
          isActive={activeProjectId === project.id && !hasVisibleActiveConversation}
          isMissing={missingProjectPathKeys.has(pathKey)}
          isRunning={visibleRunningProjectPathKeys.has(pathKey)}
          pendingAction={
            pendingProjectAction?.projectId === project.id ? pendingProjectAction.mode : null
          }
          isInteractionDisabled={sectionsDisabled}
          onSelectProject={handleSelectProject}
          onWorkbenchDragIntent={onProjectWorkbenchDragIntent}
          onNewConversation={onNewConversationForProject}
          onBrowseProjectInFileTree={
            onBrowseProjectInFileTree ? handleBrowseProjectInFileTree : undefined
          }
          onBrowseProjectInSystemFileManager={
            onBrowseProjectInSystemFileManager ? handleBrowseProjectInSystemFileManager : undefined
          }
          onConfigureProject={handleConfigureProject}
          onSetProjectPinned={handleSetProjectPinned}
          onRemoveProject={handleRemoveProject}
          isArchived={archived}
          canArchive={!archived && canArchiveProjects}
          onArchiveProject={handleArchiveProject}
          onUnarchiveProject={handleUnarchiveProject}
          onSetPendingAction={handleSetPendingProjectAction}
          workspaceProjectGroups={workspaceProjectGroups}
          onMoveProjectToGroup={onMoveProjectToGroup}
          menuOpen={!sectionsDisabled && openProjectMenuId === project.id}
          onMenuOpenChange={handleProjectMenuOpenChange}
          expanded={!archived && expandedProjectIds.has(project.id)}
          onToggleExpanded={archived ? undefined : toggleProjectExpanded}
          reorderKey={!archived ? sidebarWorkspaceOrderKey(project.path) : undefined}
          onReorderPointerDown={
            !archived && (project.isPinned ? onReorderPinned : onReorderProjects)
              ? reorder.onPointerDown
              : undefined
          }
          isDragging={reorder.draggingKey === sidebarWorkspaceOrderKey(project.path)}
          dropPosition={
            reorder.dropTarget?.key === sidebarWorkspaceOrderKey(project.path)
              ? reorder.dropTarget.position
              : undefined
          }
        />
        {!archived && renderProjectConversations(project, indented)}
      </Fragment>
    );
  };
  const renderArchivedConversations = () =>
    archivedItems.length > 0 ? (
      <div className="py-2">
        <button
          type="button"
          onClick={() => setArchivedConversationsOpen((open) => !open)}
          aria-expanded={archivedConversationsOpen}
          className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", archivedConversationsOpen && "rotate-90")}
          />
          {t("chat.archivedConversations").replace("{count}", String(archivedItems.length))}
        </button>
        {archivedConversationsOpen &&
          archivedItems.map((item) => renderHistoryRow(item, false, true))}
      </div>
    ) : null;

  return (
    <aside
      aria-hidden={!isOpen}
      inert={!isOpen}
      data-app-frame-column="sidebar"
      data-state={isOpen ? "open" : "closed"}
      className={cn(
        "chat-history-sidebar zone-font-scale flex h-full shrink-0 flex-col overflow-hidden border-r border-border/50 bg-[hsl(var(--sidebar-bg))] transition-[width,opacity] duration-200 ease-out",
        isOpen ? "w-[272px] opacity-100" : "w-0 opacity-0",
      )}
      style={{ "--zone-font-scale": fontScale } as CSSProperties}
    >
      {reorder.draggingKey && draggedTitle ? (
        <div
          ref={reorder.ghostRef}
          aria-hidden="true"
          data-sidebar-drag-ghost
          className="pointer-events-none fixed left-0 top-0 layer-popover flex h-8 max-w-[240px] items-center gap-2 rounded-lg border border-border/30 bg-popover/95 px-3 text-[calc(14px*var(--zone-font-scale,1))] text-popover-foreground shadow-lg backdrop-blur-sm"
          style={{
            transform:
              "translate3d(var(--sidebar-drag-x, -9999px), var(--sidebar-drag-y, -9999px), 0)",
          }}
        >
          {draggedPinnedEntry?.kind === "conversation" ? (
            <MessageSquare className="h-4 w-4 shrink-0" />
          ) : (
            <FolderClosed className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate">{draggedTitle}</span>
        </div>
      ) : null}
      <div className="chat-history-sidebar-inner flex w-[272px] min-w-[272px] min-h-0 flex-1 flex-col">
        {headerTop}
        <div className="shrink-0 border-b border-border/50 px-2 pb-3 pt-3">
          <div className="flex items-center justify-between gap-2">
            {brand ?? (
              <div className="flex min-w-0 -translate-y-0.5 items-center gap-2">
                <img
                  src="/icon-simple.png"
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
              disabled={sectionsDisabled}
              onClick={() => setConversationSearchOpen(true)}
              className="chat-history-search-button h-[30px] w-full justify-start gap-3 rounded-lg px-3 text-[calc(14px*var(--zone-font-scale,1))] font-normal leading-5 text-foreground/80 shadow-none transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]"
              title={t("chat.searchConversations")}
            >
              <Search className="h-4 w-4 shrink-0 text-foreground/85" />
              <span className="min-w-0 flex-1 truncate text-left">
                {t("chat.searchConversations")}
              </span>
            </Button>
            {SIDEBAR_SHORTCUTS.filter(({ id }) => sidebarShortcuts[id]).map(({ id, labelKey }) => {
              const Icon = { skills: Blend, mcp: Cable, cron: Clock3, memory: Brain }[id];
              const active = activeView === `${id}-hub`;
              return (
                <Button
                  key={id}
                  type="button"
                  variant="ghost"
                  data-testid={`sidebar-shortcut-${id}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onOpenResourceHub(id)}
                  className={cn(
                    "sidebar-hub-menu-item h-[30px] w-full justify-start gap-3 rounded-lg px-3 text-[calc(14px*var(--zone-font-scale,1))] font-normal leading-5 shadow-none transition-colors",
                    active
                      ? "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]"
                      : "text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]",
                  )}
                  title={t(labelKey)}
                >
                  <Icon className="h-4 w-4 shrink-0 text-foreground/85" />
                  <span className="truncate">{t(labelKey)}</span>
                </Button>
              );
            })}
          </div>
        </div>

        <div
          aria-disabled={sectionsDisabled || undefined}
          inert={sectionsDisabled}
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            sectionsDisabled && "pointer-events-none select-none opacity-50",
          )}
        >
          {showProjects ? (
            <div
              ref={workspaceTreeRef}
              onClickCapture={reorder.onClickCapture}
              onPointerDownCapture={reorder.onPointerDownCapture}
              className="scroll-fade min-h-0 flex-1 overflow-y-auto overflow-x-hidden flex flex-col"
            >
              {pinnedConversations.length > 0 || pinnedProjects.length > 0 ? (
                <section aria-label={t("chat.pinnedSection")} className="shrink-0 pb-2">
                  <div className="flex items-center px-2 pb-1 pt-2">
                    <button
                      type="button"
                      aria-expanded={!pinnedCollapsed}
                      onClick={() => setPinnedCollapsed((collapsed) => !collapsed)}
                      className="group flex min-w-0 items-center gap-1 rounded-md px-3 py-1 text-xs font-semibold text-muted-foreground outline-hidden"
                    >
                      {t("chat.pinnedSection")}
                      <ChevronRight
                        aria-hidden="true"
                        className="h-3.5 w-3.5 opacity-0 transition-[opacity,transform] group-hover:opacity-100"
                        style={{ transform: `rotate(${pinnedCollapsed ? 0 : 90}deg)` }}
                      />
                    </button>
                  </div>
                  {!pinnedCollapsed && (
                    <div className="space-y-0.5 px-2">
                      {pinnedEntries.map((entry) =>
                        entry.kind === "conversation"
                          ? renderHistoryRow(entry.item, true)
                          : renderWorkspaceProject(entry.project),
                      )}
                    </div>
                  )}
                </section>
              ) : null}
              <section
                aria-label={t("chat.workspaceSection")}
                data-workspace-folder-drop-zone={
                  !sectionsDisabled && !reorder.draggingKey ? "" : undefined
                }
                {...(!sectionsDisabled && !reorder.draggingKey
                  ? workspaceFolderDropHandlers
                  : undefined)}
                className="flex flex-1 flex-col"
              >
                <div
                  className={cn(
                    "flex shrink-0 items-center justify-between rounded-t-xl px-2 pb-1 pt-2 transition-colors",
                    showWorkspaceFolderDrop &&
                      "bg-primary/[0.08] ring-1 ring-primary/40 ring-inset",
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
                      {showWorkspaceFolderDrop
                        ? t("chat.workspaceDropFolder")
                        : t("chat.workspaceSection")}
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 opacity-0 transition-[opacity,transform] duration-300 ease-in-out group-hover:opacity-100"
                      style={{ transform: `rotate(${projectsCollapsed ? 0 : 90}deg)` }}
                    />
                  </button>
                  <div className="flex items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={PROJECT_ICON_BUTTON_CLASS}
                      onClick={() => (selectionMode ? exitSelectionMode() : enterSelectionMode())}
                      aria-pressed={selectionMode}
                      disabled={
                        sectionsDisabled || (!selectionMode && selectableConversationIds.size === 0)
                      }
                      aria-label={t("chat.conversationBulkSelect")}
                      title={t("chat.conversationBulkSelect")}
                    >
                      <ListChecks className="h-3.5 w-3.5" />
                    </Button>
                    {canShareConversations && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={PROJECT_ICON_BUTTON_CLASS}
                        onClick={handleOpenSharedConversations}
                        aria-label={t("chat.manageSharedConversations").replace(
                          "{count}",
                          String(sharedConversationCount),
                        )}
                      >
                        <Share2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(PROJECT_ICON_BUTTON_CLASS, "hover:!bg-transparent")}
                      title={t("chat.workspaceCreate")}
                      aria-label={t("chat.workspaceCreate")}
                      disabled={sectionsDisabled || !onCreateProject}
                      onClick={() => onCreateProject?.()}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {actionErrorMessage && (
                  <div role="alert" className="mx-3 mb-2 flex gap-2 text-xs text-destructive">
                    <span className="min-w-0 flex-1">{actionErrorMessage}</span>
                    {onDismissActionError && (
                      <button
                        type="button"
                        onClick={onDismissActionError}
                        aria-label={t("chat.cancel")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
                <div
                  aria-hidden={projectsCollapsed}
                  inert={projectsCollapsed}
                  className={cn(
                    "flex-1 rounded-b-xl transition-[opacity,background-color,box-shadow] duration-300 ease-out motion-reduce:transition-none",
                    projectsCollapsed ? "hidden" : "opacity-100",
                    showWorkspaceFolderDrop &&
                      "bg-primary/[0.045] ring-1 ring-primary/40 ring-inset",
                  )}
                >
                  <div className="space-y-0.5 px-2 pb-0.5">
                    {showWorkspaceFolderDrop ? (
                      <div
                        role="status"
                        aria-live="polite"
                        className="flex h-[30px] items-center gap-2 px-2 text-xs text-muted-foreground"
                      >
                        <FolderOpen className="h-4 w-4 shrink-0" />
                        <span className="truncate">{t("chat.workspaceDropFolder")}</span>
                      </div>
                    ) : null}
                    {renderedSections.grouped.map((section) => {
                      const { group, projects: members } = section;
                      const collapsed = isGroupCollapsed(group, members);
                      return (
                        <Fragment key={group.id}>
                          <ProjectGroupHeader
                            group={group}
                            memberCount={members.length}
                            isRenaming={renamingGroupId === group.id}
                            renameDraft={groupRenameDraft}
                            onRenameDraftChange={setGroupRenameDraft}
                            onCommitRename={commitGroupRename}
                            onCancelRename={cancelGroupRename}
                            onToggleCollapsed={() => {
                              setRevealedSearchConversationId(null);
                              onToggleWorkspaceGroupCollapsed?.(group.id);
                            }}
                            onStartRename={() => {
                              setRenamingGroupId(group.id);
                              setGroupRenameDraft(group.name);
                            }}
                            onDelete={() => void requestDeleteGroup(group)}
                          />
                          {!collapsed
                            ? members.map((project) => renderWorkspaceProject(project, true))
                            : null}
                        </Fragment>
                      );
                    })}
                    {renderedSections.ungrouped.length > 0 ? (
                      <Fragment>
                        {renderedSections.grouped.length > 0 ? (
                          <div className="px-2 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                            {t("chat.workspaceUngrouped")}
                          </div>
                        ) : null}
                        {renderedSections.ungrouped.map((project) =>
                          renderWorkspaceProject(project),
                        )}
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
                          ? archivedProjects.map((project) =>
                              renderWorkspaceProject(project, false, true),
                            )
                          : null}
                      </div>
                    ) : null}
                    {renderArchivedConversations()}
                  </div>
                </div>
              </section>
            </div>
          ) : null}

          {(!showProjects || selectionMode) && (
            <div
              className={cn(
                "grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2 pb-2",
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
                        onClick={() => (selectionMode ? exitSelectionMode() : enterSelectionMode())}
                        aria-pressed={selectionMode}
                        disabled={
                          sectionsDisabled ||
                          (!selectionMode && selectableConversationIds.size === 0)
                        }
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
          )}

          <div
            aria-hidden={showProjects || recentCollapsed}
            inert={showProjects || recentCollapsed}
            className={cn(
              "flex min-h-0 flex-1 flex-col transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
              showProjects || recentCollapsed ? "hidden" : "translate-y-0 opacity-100",
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
              className="chat-history-list scroll-fade min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3"
            >
              {items.length > 0 ? (
                <div
                  key={scopeKey || "scope"}
                  className="chat-history-scope-enter relative"
                  style={{ height: historyVirtualizer.getTotalSize() }}
                >
                  {virtualHistoryRows.map((virtualRow) => {
                    const item = unarchivedItems[virtualRow.index];
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
                        {renderHistoryRow(item, item.isPinned === true)}
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
              {renderArchivedConversations()}
              {items.length > 0 && (hasMore || isLoadingMore) ? (
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={sectionsDisabled || isLoadingMore}
                  className="w-full rounded-md px-2 pb-2 pt-1 text-center text-xs leading-5 text-muted-foreground hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {isLoadingMore
                    ? t("sidebar.loadingMoreHistory")
                    : t("sidebar.continueLoadingHistory")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-border/50 bg-[hsl(var(--sidebar-bg))] px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            // 与 macOS 标题栏那个设置入口同一个 testid：自动化脚本据此定位，
            // 不必靠文案或坐标去猜。可读名走 i18n——屏幕阅读器念给用户听的
            // 东西不该为了脚本方便固定成英文。
            data-testid="open-settings"
            onClick={() => onOpenSettings()}
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
      <ConversationSearchDialog
        open={conversationSearchOpen}
        onOpenChange={setConversationSearchOpen}
        conversations={items}
        currentWorkdir={currentConversationWorkdir}
        onSelectConversation={handleSelectConversation}
      />
    </aside>
  );
});
