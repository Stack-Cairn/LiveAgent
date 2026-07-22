import { Tooltip } from "@base-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import iconSimpleUrl from "../../../src-tauri/icons/icon-simple.png";
import { useLocale } from "../../i18n";
import type { AppUpdateController } from "../../lib/appUpdates";
import {
  DEFAULT_WORKSPACE_PROJECT_ID,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import type {
  SidebarBatchDeleteOptions,
  SidebarBatchDeleteResult,
} from "../../lib/sidebar/batchDelete";
import { reconcileSidebarSelection, updateSidebarSelection } from "../../lib/sidebar/selection";
import type {
  SidebarConversation,
  SidebarListStatus,
  SidebarMutationKind,
} from "../../lib/sidebar/types";
import { AppUpdateButton } from "../AppUpdateButton";
import {
  Archive,
  ArchiveRestore,
  Blend,
  Cable,
  Check,
  ChevronRight,
  CirclePlus,
  Edit3,
  FolderClosed,
  FolderOpen,
  FolderTree,
  ListChecks,
  Loader2,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  PinOff,
  Plus,
  Settings,
  Share2,
  Trash2,
  X,
} from "../icons";
import { isMacOsTauri, MacOsTitleBarSpacer } from "../MacOsTitleBarSpacer";
import { Button } from "../ui/button";
import { useConfirmDialog } from "../ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";

type ChatHistorySidebarProps = {
  items: readonly SidebarConversation[];
  currentConversationId: string;
  runningConversationIds: ReadonlySet<string>;
  // Rows with an in-flight mutation: only that row's controls are disabled.
  busyConversationIds: ReadonlyMap<string, SidebarMutationKind>;
  listStatus: SidebarListStatus;
  // Identity of the current list scope (workspace/text mode). A change
  // remounts the list content with a soft enter transition and resets scroll.
  scopeKey?: string;
  totalItems: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  // Localized error text (list or per-row mutation); rendered as a banner
  // above the rows, never replacing them.
  errorMessage: string | null;
  errorDetail?: string | null;
  onDismissError?: () => void;
  renamingId: string | null;
  renameDraft: string;
  isOpen: boolean;
  fontScale?: number;
  activeView?: "chat" | "skills-hub" | "mcp-hub";
  showProjects?: boolean;
  // Pre-sorted by the container (activity/running/pinned) — rendered as-is.
  projects?: WorkspaceProject[];
  activeProjectId?: string;
  missingProjectPathKeys?: ReadonlySet<string>;
  runningProjectPathKeys?: ReadonlySet<string>;
  projectRenamingId?: string | null;
  projectRenameDraft?: string;
  projectsCollapsed?: boolean;
  recentCollapsed?: boolean;
  onProjectsCollapsedChange?: (collapsed: boolean) => void;
  onRecentCollapsedChange?: (collapsed: boolean) => void;
  onCreateProject?: () => void;
  onSelectProject?: (project: WorkspaceProject) => void;
  onNewConversationForProject?: (project: WorkspaceProject) => void;
  onBrowseProjectInFileTree?: (project: WorkspaceProject) => void;
  onBrowseProjectInSystemFileManager?: (project: WorkspaceProject) => void;
  onStartRenamingProject?: (project: WorkspaceProject) => void;
  onProjectRenameDraftChange?: (value: string) => void;
  onCommitProjectRename?: () => void;
  onCancelProjectRename?: () => void;
  onSetProjectPinned?: (project: WorkspaceProject, isPinned: boolean) => void;
  onRemoveProject?: (project: WorkspaceProject) => void;
  onArchiveProject?: (project: WorkspaceProject) => void;
  onUnarchiveProject?: (project: WorkspaceProject) => void;
  // Path keys of archived workspaces; those rows render disabled in a
  // collapsed group at the end of the list.
  archivedProjectPathKeys?: ReadonlySet<string>;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onStartRenaming: (item: SidebarConversation) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSetPinned: (id: string, isPinned: boolean) => void;
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
  appUpdate?: AppUpdateController;
  onOpenSkillsHub?: () => void;
  onOpenMcpHub?: () => void;
};

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

function useStableEvent<Args extends unknown[], Return>(
  handler: (...args: Args) => Return,
): (...args: Args) => Return {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  return useCallback((...args: Args) => handlerRef.current(...args), []);
}

const HistoryRow = memo(function HistoryRow(props: {
  item: SidebarConversation;
  isActive: boolean;
  isRunning: boolean;
  isBusy: boolean;
  isDeleteDisabled: boolean;
  canShareConversation: boolean;
  isRenaming: boolean;
  isPendingDelete: boolean;
  isSelectionMode: boolean;
  isSelected: boolean;
  isSelectionDisabled: boolean;
  renameDraft: string;
  onSelectConversation: (id: string) => void;
  onStartRenaming: (item: SidebarConversation) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSetPinned: (id: string, isPinned: boolean) => void;
  onShareConversation: (item: SidebarConversation) => void;
  onDeleteConversation: (id: string) => void;
  onSetPendingDelete: (id: string | null) => void;
  onSelectForBulk: (id: string, modifiers: { shiftKey: boolean; toggleKey: boolean }) => void;
  onEnterSelectionMode: (id: string) => void;
}) {
  const {
    item,
    isActive,
    isRunning,
    isBusy,
    isDeleteDisabled,
    canShareConversation,
    isRenaming,
    isPendingDelete,
    isSelectionMode,
    isSelected,
    isSelectionDisabled,
    renameDraft,
    onSelectConversation,
    onStartRenaming,
    onRenameDraftChange,
    onCommitRename,
    onCancelRename,
    onSetPinned,
    onShareConversation,
    onDeleteConversation,
    onSetPendingDelete,
    onSelectForBulk,
    onEnterSelectionMode,
  } = props;
  const { t } = useLocale();

  const inputRef = useRef<HTMLInputElement | null>(null);
  // Enter/Escape mark the blur as handled so the following input blur does
  // not double-commit (symmetric with ProjectRow's guard).
  const skipNextBlurCommitRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleSelect = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const usesSelectionModifier = event.shiftKey || event.ctrlKey || event.metaKey;
      if (isSelectionMode || usesSelectionModifier) {
        if (!isSelectionDisabled) {
          onSelectForBulk(item.id, {
            shiftKey: event.shiftKey,
            toggleKey: event.ctrlKey || event.metaKey,
          });
        }
        return;
      }
      onSelectConversation(item.id);
    },
    [isSelectionDisabled, isSelectionMode, item.id, onSelectConversation, onSelectForBulk],
  );

  const handleStartRenaming = useCallback(() => {
    onStartRenaming(item);
  }, [item, onStartRenaming]);

  const handleRequestDelete = useCallback(() => {
    onSetPendingDelete(item.id);
  }, [item.id, onSetPendingDelete]);

  const handleEnterSelectionMode = useCallback(() => {
    onEnterSelectionMode(item.id);
  }, [item.id, onEnterSelectionMode]);

  const handleTogglePinned = useCallback(() => {
    onSetPinned(item.id, item.isPinned !== true);
  }, [item.id, item.isPinned, onSetPinned]);

  const handleShare = useCallback(() => {
    onShareConversation(item);
  }, [item, onShareConversation]);

  const handleConfirmDelete = useCallback(() => {
    onSetPendingDelete(null);
    onDeleteConversation(item.id);
  }, [item.id, onDeleteConversation, onSetPendingDelete]);

  const handleCancelDelete = useCallback(() => {
    onSetPendingDelete(null);
  }, [onSetPendingDelete]);

  useEffect(() => {
    if (!isRenaming) return;
    skipNextBlurCommitRef.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isRenaming]);

  if (isPendingDelete) {
    return (
      <div className="chat-history-row rounded-2xl border border-border/70 bg-background px-3 py-2.5 shadow-xs shadow-black/5">
        <p className="truncate text-sm leading-5 text-foreground/80">
          {t("chat.conversationDeleteConfirm").replace("{title}", item.title)}
        </p>
        <p className="mt-0.5 text-[calc(11px*var(--zone-font-scale,1))] leading-4 text-muted-foreground">
          {t("chat.conversationDeleteWarning")}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCancelDelete}
            className="h-7 rounded-xl border-border/60 text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            {t("chat.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleConfirmDelete}
            disabled={isDeleteDisabled || isBusy}
            className="h-7 rounded-xl bg-destructive text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
          >
            {t("chat.delete")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "chat-history-row group/item grid h-[30px] grid-cols-[minmax(0,1fr)_auto] items-center rounded-lg pl-1 transition-colors",
        isSelectionMode && isSelected
          ? "bg-primary/10 text-foreground hover:bg-primary/[0.14]"
          : isActive
            ? "bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.09]"
            : "text-foreground/85 hover:bg-foreground/[0.05] hover:text-foreground",
        isSelectionMode && isSelectionDisabled && "opacity-50",
      )}
    >
      {isRenaming ? (
        <div className="flex h-[30px] min-w-0 items-center px-2">
          <Input
            ref={inputRef}
            value={renameDraft}
            onChange={(e) => onRenameDraftChange(e.currentTarget.value)}
            onBlur={() => {
              if (skipNextBlurCommitRef.current) {
                skipNextBlurCommitRef.current = false;
                return;
              }
              onCommitRename();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                skipNextBlurCommitRef.current = true;
                onCommitRename();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                skipNextBlurCommitRef.current = true;
                onCancelRename();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-7 min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[calc(14px*var(--zone-font-scale,1))] font-normal shadow-none outline-none focus-visible:border-0 focus-visible:bg-transparent"
            disabled={isRunning || isBusy}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={handleSelect}
          onMouseDown={(event) => {
            if (event.shiftKey) event.preventDefault();
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            if (!isSelectionMode && !isRunning && !isBusy) {
              handleStartRenaming();
            }
          }}
          aria-pressed={isSelectionMode ? isSelected : undefined}
          disabled={isSelectionMode && isSelectionDisabled}
          className="flex h-[30px] min-w-0 items-center gap-2 rounded-md px-2 text-left outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring"
          title={item.title}
        >
          {isSelectionMode ? (
            <span
              aria-hidden="true"
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                isSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/45 bg-background/50",
              )}
            >
              {isSelected ? <Check className="h-3 w-3" /> : null}
            </span>
          ) : null}
          <span className="sidebar-project-name-fade min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[calc(14px*var(--zone-font-scale,1))] font-normal leading-5">
            {item.title}
          </span>
        </button>
      )}
      {!isRenaming && !isSelectionMode ? (
        <div
          className={cn(
            "relative flex items-center justify-end overflow-hidden transition-[max-width,opacity] duration-200 ease-out",
            isRunning
              ? "max-w-7 opacity-100 group-hover/item:max-w-16 group-focus-within/item:max-w-16"
              : "max-w-0 opacity-0 group-hover/item:max-w-16 group-hover/item:opacity-100 group-focus-within/item:max-w-16 group-focus-within/item:opacity-100",
            menuOpen && "max-w-16 opacity-100",
          )}
        >
          {isRunning ? (
            <span
              role="img"
              aria-label={t("chat.statusRunningReply")}
              title={t("chat.statusRunningReply")}
              className={cn(
                "pointer-events-none absolute right-1.5 flex h-4 w-4 items-center justify-center text-muted-foreground transition-opacity duration-200",
                "opacity-100 group-hover/item:opacity-0 group-focus-within/item:opacity-0",
                menuOpen && "opacity-0",
              )}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
            </span>
          ) : null}
          <div
            className={cn(
              "flex items-center gap-0.5 transition-opacity duration-200",
              isRunning
                ? "opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100"
                : "opacity-100",
              menuOpen && "opacity-100",
            )}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={PROJECT_ICON_BUTTON_CLASS}
              title={item.isPinned ? t("chat.conversationUnpin") : t("chat.conversationPin")}
              aria-label={item.isPinned ? t("chat.conversationUnpin") : t("chat.conversationPin")}
              onClick={handleTogglePinned}
              disabled={item.isPending || isBusy}
            >
              {item.isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </Button>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={PROJECT_ICON_BUTTON_CLASS}
                    title={t("chat.conversationMore")}
                    aria-label={t("chat.conversationMore")}
                    onPointerDown={(e: React.PointerEvent<HTMLButtonElement>) =>
                      e.stopPropagation()
                    }
                    onClick={(e: React.MouseEvent<HTMLButtonElement>) => e.stopPropagation()}
                  />
                }
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="start"
                sideOffset={8}
                className="sidebar-context-menu min-w-[10rem] rounded-xl border-border/60 bg-background/95 backdrop-blur-xl"
              >
                {canShareConversation && !item.isPending ? (
                  <DropdownMenuItem onSelect={handleShare} className="gap-2">
                    <Share2 className="h-3.5 w-3.5" />
                    {t("chat.conversationShare")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={isRunning || isBusy}
                  onSelect={handleEnterSelectionMode}
                  className="gap-2"
                >
                  <ListChecks className="h-3.5 w-3.5" />
                  {t("chat.conversationBulkSelect")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={isRunning || isBusy}
                  onSelect={handleStartRenaming}
                  className="gap-2"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  {t("chat.conversationRename")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={isDeleteDisabled || isBusy}
                  onSelect={handleRequestDelete}
                  className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("chat.conversationDelete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ) : null}
    </div>
  );
});

const ProjectRow = memo(function ProjectRow(props: {
  project: WorkspaceProject;
  isActive: boolean;
  isMissing: boolean;
  isRunning: boolean;
  isRenaming: boolean;
  isPendingRemove: boolean;
  renameDraft: string;
  onSelectProject: (project: WorkspaceProject) => void;
  onBrowseProjectInFileTree?: (project: WorkspaceProject) => void;
  onBrowseProjectInSystemFileManager?: (project: WorkspaceProject) => void;
  onStartRenamingProject: (project: WorkspaceProject) => void;
  onProjectRenameDraftChange: (value: string) => void;
  onCommitProjectRename: () => void;
  onCancelProjectRename: () => void;
  onSetProjectPinned: (project: WorkspaceProject, isPinned: boolean) => void;
  onRemoveProject: (project: WorkspaceProject) => void;
  // Archived rows render disabled: no selection (so no new conversations),
  // no pin — but rename/remove/browse stay available from the menu.
  isArchived: boolean;
  // Offered only while at least one other non-archived workspace remains.
  canArchive: boolean;
  onArchiveProject: (project: WorkspaceProject) => void;
  onUnarchiveProject: (project: WorkspaceProject) => void;
  onSetPendingRemove: (projectId: string | null) => void;
}) {
  const {
    project,
    isActive,
    isMissing,
    isRunning,
    isRenaming,
    isPendingRemove,
    renameDraft,
    onSelectProject,
    onBrowseProjectInFileTree,
    onBrowseProjectInSystemFileManager,
    onStartRenamingProject,
    onProjectRenameDraftChange,
    onCommitProjectRename,
    onCancelProjectRename,
    onSetProjectPinned,
    onRemoveProject,
    isArchived,
    canArchive,
    onArchiveProject,
    onUnarchiveProject,
    onSetPendingRemove,
  } = props;
  const { t } = useLocale();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const skipNextBlurCommitRef = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isDefaultProject = project.id === DEFAULT_WORKSPACE_PROJECT_ID;
  const isPinned = project.isPinned === true;
  const ProjectFolderIcon = isActive ? FolderOpen : FolderClosed;

  useEffect(() => {
    if (!isRenaming) return;
    skipNextBlurCommitRef.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isRenaming]);

  const handleRequestRemove = useCallback(() => {
    onSetPendingRemove(project.id);
  }, [onSetPendingRemove, project.id]);

  const handleConfirmRemove = useCallback(() => {
    onSetPendingRemove(null);
    onRemoveProject(project);
  }, [onRemoveProject, onSetPendingRemove, project]);

  const handleCancelRemove = useCallback(() => {
    onSetPendingRemove(null);
  }, [onSetPendingRemove]);

  const handleTogglePinned = useCallback(() => {
    onSetProjectPinned(project, !isPinned);
  }, [isPinned, onSetProjectPinned, project]);

  const handleBrowseInFileTree = useCallback(() => {
    onBrowseProjectInFileTree?.(project);
  }, [onBrowseProjectInFileTree, project]);

  const handleBrowseInSystemFileManager = useCallback(() => {
    onBrowseProjectInSystemFileManager?.(project);
  }, [onBrowseProjectInSystemFileManager, project]);

  const handleArchive = useCallback(() => {
    onArchiveProject(project);
  }, [onArchiveProject, project]);

  const handleUnarchive = useCallback(() => {
    onUnarchiveProject(project);
  }, [onUnarchiveProject, project]);

  if (isPendingRemove) {
    return (
      <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm text-destructive shadow-xs shadow-black/5">
        <p className="truncate font-medium leading-5 text-destructive">
          {t("chat.workspaceRemoveConfirm").replace("{name}", project.name)}
        </p>
        <p className="mt-0.5 text-[calc(11px*var(--zone-font-scale,1))] leading-4 text-destructive/75">
          {isRunning ? t("chat.workspaceRemoveRunning") : t("chat.workspaceRemoveDescription")}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCancelRemove}
            className="h-7 rounded-xl border-border/60 bg-background text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            {t("chat.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleConfirmRemove}
            disabled={isRunning}
            className="h-7 rounded-xl bg-destructive text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
          >
            {t("chat.remove")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className={cn(
        "group/project grid h-[30px] grid-cols-[minmax(0,1fr)_auto] items-center rounded-lg pl-1 transition-colors",
        isMissing
          ? "text-destructive hover:bg-destructive/10"
          : isArchived
            ? "text-muted-foreground/60 hover:bg-foreground/[0.03]"
            : isActive
              ? "bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.09]"
              : "text-foreground/85 hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      {isRenaming ? (
        <div className="flex h-[30px] min-w-0 items-center gap-3 rounded-md px-2 text-left">
          <ProjectFolderIcon
            className={cn(
              "h-4 w-4 shrink-0 transition-colors",
              isMissing
                ? "text-destructive"
                : isArchived
                  ? "text-muted-foreground/40"
                  : isActive
                    ? "text-amber-500"
                    : "text-foreground/65",
            )}
          />
          <Input
            ref={inputRef}
            value={renameDraft}
            onChange={(e) => onProjectRenameDraftChange(e.currentTarget.value)}
            onBlur={() => {
              if (skipNextBlurCommitRef.current) {
                skipNextBlurCommitRef.current = false;
                return;
              }
              onCommitProjectRename();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                skipNextBlurCommitRef.current = true;
                onCommitProjectRename();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                skipNextBlurCommitRef.current = true;
                onCancelProjectRename();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-7 min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[calc(14px*var(--zone-font-scale,1))] font-normal shadow-none outline-none focus-visible:border-0 focus-visible:bg-transparent"
          />
        </div>
      ) : (
        <Tooltip.Root>
          <Tooltip.Trigger
            delay={0}
            closeOnClick
            render={
              <button
                type="button"
                aria-disabled={isArchived || undefined}
                className={cn(
                  "flex h-[30px] min-w-0 items-center gap-3 rounded-md px-2 text-left outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  isMissing
                    ? "hover:text-destructive focus-visible:bg-destructive/10"
                    : isArchived
                      ? "cursor-default"
                      : "hover:text-foreground focus-visible:bg-foreground/[0.06]",
                )}
                onClick={() => {
                  // Archived workspaces cannot be selected, so no new
                  // conversations can start in them.
                  if (!isArchived) {
                    onSelectProject(project);
                  }
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  if (!isDefaultProject) {
                    onStartRenamingProject(project);
                  }
                }}
              >
                <ProjectFolderIcon
                  className={cn(
                    "h-4 w-4 shrink-0 transition-colors",
                    isMissing
                      ? "text-destructive"
                      : isArchived
                        ? "text-muted-foreground/40"
                        : isActive
                          ? "text-amber-500"
                          : "text-foreground/65",
                  )}
                />
                <span
                  className={cn(
                    "sidebar-project-name-fade min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[calc(14px*var(--zone-font-scale,1))] font-normal leading-5",
                    isMissing ? "text-destructive" : undefined,
                  )}
                >
                  {project.name}
                </span>
              </button>
            }
          />
          <Tooltip.Portal>
            <Tooltip.Positioner
              anchor={rowRef}
              side="right"
              align="center"
              sideOffset={10}
              collisionPadding={8}
              className="z-[9999]"
            >
              <Tooltip.Popup className="w-64 rounded-xl border border-border/60 bg-popover px-3 py-2.5 text-popover-foreground shadow-lg outline-hidden data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95">
                <p className="truncate text-sm font-semibold leading-5">{project.name}</p>
                <p className="mt-1 break-all text-xs leading-4 text-muted-foreground">
                  {project.path}
                </p>
              </Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        </Tooltip.Root>
      )}
      {!isRenaming ? (
        <div
          className={cn(
            "relative flex items-center justify-end overflow-hidden transition-[max-width,opacity] duration-200 ease-out",
            isMissing
              ? "max-w-8 opacity-100"
              : isRunning
                ? "max-w-7 opacity-100 group-hover/project:max-w-16 group-focus-within/project:max-w-16"
                : "max-w-0 opacity-0 group-hover/project:max-w-16 group-hover/project:opacity-100 group-focus-within/project:max-w-16 group-focus-within/project:opacity-100",
            menuOpen && "max-w-16 opacity-100",
          )}
        >
          {isRunning && !isMissing ? (
            <span
              role="img"
              aria-label={t("chat.statusRunningReply")}
              title={t("chat.statusRunningReply")}
              className={cn(
                "pointer-events-none absolute right-1.5 flex h-4 w-4 items-center justify-center text-muted-foreground transition-opacity duration-200",
                "opacity-100 group-hover/project:opacity-0 group-focus-within/project:opacity-0",
                menuOpen && "opacity-0",
              )}
            >
              <Loader2 className="h-4 w-4 animate-spin" />
            </span>
          ) : null}
          <div
            className={cn(
              "flex items-center gap-0.5 transition-opacity duration-200",
              isRunning && !isMissing
                ? "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100"
                : "opacity-100",
              menuOpen && "opacity-100",
            )}
          >
            {isMissing && !isArchived ? (
              !isDefaultProject ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    PROJECT_ICON_BUTTON_CLASS,
                    "text-destructive hover:!bg-transparent hover:text-destructive",
                  )}
                  title={t("chat.workspaceRemove")}
                  aria-label={t("chat.workspaceRemove")}
                  onClick={handleRequestRemove}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null
            ) : (
              <>
                {!isArchived ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={PROJECT_ICON_BUTTON_CLASS}
                    title={isPinned ? t("chat.workspaceUnpin") : t("chat.workspacePin")}
                    aria-label={isPinned ? t("chat.workspaceUnpin") : t("chat.workspacePin")}
                    onClick={handleTogglePinned}
                  >
                    {isPinned ? (
                      <PinOff className="h-3.5 w-3.5" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
                  </Button>
                ) : null}
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={PROJECT_ICON_BUTTON_CLASS}
                        title={t("chat.workspaceMore")}
                        aria-label={t("chat.workspaceMore")}
                      />
                    }
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="right"
                    align="start"
                    sideOffset={6}
                    className="sidebar-context-menu"
                  >
                    {!isDefaultProject ? (
                      <>
                        <DropdownMenuItem
                          onSelect={() => onStartRenamingProject(project)}
                          className="gap-2"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          {t("chat.workspaceRename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={handleRequestRemove}
                          className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("chat.workspaceRemove")}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    {!isArchived && canArchive ? (
                      <DropdownMenuItem onSelect={handleArchive} className="gap-2">
                        <Archive className="h-3.5 w-3.5" />
                        {t("chat.workspaceArchive")}
                      </DropdownMenuItem>
                    ) : null}
                    {isArchived ? (
                      <DropdownMenuItem onSelect={handleUnarchive} className="gap-2">
                        <ArchiveRestore className="h-3.5 w-3.5" />
                        {t("chat.workspaceUnarchive")}
                      </DropdownMenuItem>
                    ) : null}
                    {onBrowseProjectInFileTree ? (
                      <DropdownMenuItem onSelect={handleBrowseInFileTree} className="gap-2">
                        <FolderTree className="h-3.5 w-3.5" />
                        {t("chat.workspaceBrowseInFileTree")}
                      </DropdownMenuItem>
                    ) : null}
                    {onBrowseProjectInSystemFileManager ? (
                      <DropdownMenuItem
                        onSelect={handleBrowseInSystemFileManager}
                        className="gap-2"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        {t("chat.workspaceBrowseInSystemFileManager")}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
});

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

function SidebarStateCard(props: {
  title: string;
  description?: string;
  tone?: "default" | "error";
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  const { title, description, tone = "default", onDismiss, dismissLabel } = props;

  return (
    <div
      className={cn(
        "rounded-2xl border px-3 py-3 text-sm",
        tone === "error"
          ? "border-destructive/20 bg-destructive/5 text-destructive"
          : "border-border/60 bg-background/70 text-muted-foreground",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div
          className={cn(
            "min-w-0 font-medium",
            tone === "error" ? "text-destructive" : "text-foreground/85",
          )}
        >
          {title}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={dismissLabel}
            title={dismissLabel}
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors",
              tone === "error"
                ? "text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
                : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {description ? <div className="mt-1 text-xs leading-5">{description}</div> : null}
    </div>
  );
}

export const ChatHistorySidebar = memo(function ChatHistorySidebar(props: ChatHistorySidebarProps) {
  const {
    items,
    currentConversationId,
    runningConversationIds,
    busyConversationIds,
    listStatus,
    scopeKey = "",
    hasMore,
    isLoadingMore,
    errorMessage,
    errorDetail,
    onDismissError,
    renamingId,
    renameDraft,
    isOpen,
    fontScale = 1,
    activeView = "chat",
    showProjects = false,
    projects = [],
    activeProjectId,
    missingProjectPathKeys = EMPTY_PROJECT_PATH_KEYS,
    runningProjectPathKeys = EMPTY_PROJECT_PATH_KEYS,
    projectRenamingId = null,
    projectRenameDraft = "",
    projectsCollapsed = false,
    recentCollapsed = false,
    onProjectsCollapsedChange,
    onRecentCollapsedChange,
    onCreateProject,
    onSelectProject,
    onBrowseProjectInFileTree,
    onBrowseProjectInSystemFileManager,
    onStartRenamingProject,
    onProjectRenameDraftChange,
    onCommitProjectRename,
    onCancelProjectRename,
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
    canShareConversations,
    sharedConversationCount,
    onShareConversation,
    onOpenSharedConversations,
    onDeleteConversation,
    onDeleteConversations,
    onLoadMore,
    onCloseSidebar,
    onOpenSettings,
    appUpdate,
    onOpenSkillsHub,
    onOpenMcpHub,
  } = props;
  const { t } = useLocale();

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedConversationIds, setSelectedConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [pendingProjectRemoveId, setPendingProjectRemoveId] = useState<string | null>(null);
  const [showAllProjects, setShowAllProjects] = useState(false);
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
  const { confirm: requestBulkDeleteConfirm, dialog: bulkDeleteDialog } = useConfirmDialog();
  const orderedConversationIds = useMemo(() => items.map((item) => item.id), [items]);
  const selectableConversationIds = useMemo(
    () =>
      new Set(
        items
          .filter(
            (item) => !runningConversationIds.has(item.id) && !busyConversationIds.has(item.id),
          )
          .map((item) => item.id),
      ),
    [busyConversationIds, items, runningConversationIds],
  );
  const handleSelectConversation = useStableEvent((id: string) => {
    selectionAnchorRef.current = id;
    onSelectConversation(id);
  });
  const handleStartRenaming = useStableEvent(onStartRenaming);
  const handleRenameDraftChange = useStableEvent(onRenameDraftChange);
  const handleCommitRename = useStableEvent(onCommitRename);
  const handleCancelRename = useStableEvent(onCancelRename);
  const handleSetPinned = useStableEvent(onSetPinned);
  const handleShareConversation = useStableEvent(onShareConversation);
  const handleOpenSharedConversations = useStableEvent(onOpenSharedConversations);
  const handleDeleteConversation = useStableEvent(onDeleteConversation);
  const handleDeleteConversations = useStableEvent(onDeleteConversations);
  const handleSelectProject = useStableEvent((project: WorkspaceProject) => {
    onSelectProject?.(project);
  });
  const handleBrowseProjectInFileTree = useStableEvent((project: WorkspaceProject) => {
    onBrowseProjectInFileTree?.(project);
  });
  const handleBrowseProjectInSystemFileManager = useStableEvent((project: WorkspaceProject) => {
    onBrowseProjectInSystemFileManager?.(project);
  });
  const handleStartRenamingProject = useStableEvent((project: WorkspaceProject) => {
    onStartRenamingProject?.(project);
  });
  const handleProjectRenameDraftChange = useStableEvent((value: string) => {
    onProjectRenameDraftChange?.(value);
  });
  const handleCommitProjectRename = useStableEvent(() => {
    onCommitProjectRename?.();
  });
  const handleCancelProjectRename = useStableEvent(() => {
    onCancelProjectRename?.();
  });
  const handleSetProjectPinned = useStableEvent((project: WorkspaceProject, isPinned: boolean) => {
    onSetProjectPinned?.(project, isPinned);
  });
  const handleRemoveProject = useStableEvent((project: WorkspaceProject) => {
    onRemoveProject?.(project);
  });
  const handleArchiveProject = useStableEvent((project: WorkspaceProject) => {
    onArchiveProject?.(project);
  });
  const handleUnarchiveProject = useStableEvent((project: WorkspaceProject) => {
    onUnarchiveProject?.(project);
  });
  const exitSelectionMode = useCallback(() => {
    bulkDeleteRunRef.current += 1;
    setIsBulkDeleting(false);
    setSelectionMode(false);
    setSelectedConversationIds(new Set());
    selectionAnchorRef.current = null;
  }, []);
  const enterSelectionMode = useStableEvent((initialId?: string) => {
    setPendingDeleteId(null);
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
      if (!selectableConversationIds.has(id)) {
        return;
      }
      setPendingDeleteId(null);
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
    if (ids.length === 0 || isBulkDeleting) {
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
  // Projects arrive pre-sorted from the container; the view only caps the
  // rendered count until the user expands the list.
  const renderedProjects = useMemo(
    () => (showAllProjects ? activeProjects : activeProjects.slice(0, PROJECT_LIST_COLLAPSED_MAX)),
    [activeProjects, showAllProjects],
  );
  // Archiving must always leave at least one active workspace behind.
  const canArchiveProjects = Boolean(onArchiveProject) && activeProjects.length > 1;
  const [archivedGroupOpen, setArchivedGroupOpen] = useState(false);
  const hiddenProjectCount = activeProjects.length - renderedProjects.length;
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
    const defaultProjectsBodyHeight = clampSidebarSectionHeight(
      Math.min(projectsContentHeight, Math.floor(available / 2)),
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
    projectSectionHeight,
    projectsCollapsed,
    recentCollapsed,
    showProjects,
    sidebarSectionMetrics,
  ]);
  const canResizeProjectSections =
    showProjects &&
    !projectsCollapsed &&
    !recentCollapsed &&
    sidebarSectionLayout.resizeMaxHeight > sidebarSectionLayout.resizeMinHeight;
  sidebarSectionLayoutRef.current = {
    projectsBodyHeight: sidebarSectionLayout.projectsBodyHeight,
    resizeMinHeight: sidebarSectionLayout.resizeMinHeight,
    resizeMaxHeight: sidebarSectionLayout.resizeMaxHeight,
  };
  const historyScrollRef = useRef<HTMLDivElement | null>(null);
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

  const isListLoading = listStatus === "loading" || listStatus === "initial";

  // Workspace switch: land the new scope at the top; the keyed content
  // wrapper below replays the soft enter transition at the same time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope identity intentionally drives the reset
  useEffect(() => {
    historyScrollRef.current?.scrollTo({ top: 0 });
  }, [scopeKey]);

  useEffect(() => {
    if (
      !hasMore ||
      isListLoading ||
      isLoadingMore ||
      recentCollapsed ||
      items.length === 0 ||
      lastVirtualHistoryIndex < items.length - HISTORY_LOAD_MORE_THRESHOLD
    ) {
      return;
    }
    onLoadMore();
  }, [
    hasMore,
    isListLoading,
    isLoadingMore,
    items.length,
    lastVirtualHistoryIndex,
    onLoadMore,
    recentCollapsed,
  ]);

  useEffect(() => {
    if (!pendingProjectRemoveId) {
      return;
    }
    if (!projects.some((project) => project.id === pendingProjectRemoveId)) {
      setPendingProjectRemoveId(null);
    }
  }, [pendingProjectRemoveId, projects]);

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
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !canResizeProjectSections) {
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
    [canResizeProjectSections],
  );

  const renderHistoryRow = useCallback(
    (item: SidebarConversation) => (
      <HistoryRow
        key={item.id}
        item={item}
        isActive={currentConversationId === item.id}
        isRunning={runningConversationIds.has(item.id)}
        isBusy={busyConversationIds.has(item.id)}
        isDeleteDisabled={runningConversationIds.has(item.id)}
        canShareConversation={canShareConversations}
        isRenaming={renamingId === item.id}
        isPendingDelete={pendingDeleteId === item.id}
        isSelectionMode={selectionMode}
        isSelected={selectedConversationIds.has(item.id)}
        isSelectionDisabled={isBulkDeleting || !selectableConversationIds.has(item.id)}
        renameDraft={renamingId === item.id ? renameDraft : ""}
        onSelectConversation={handleSelectConversation}
        onStartRenaming={handleStartRenaming}
        onRenameDraftChange={handleRenameDraftChange}
        onCommitRename={handleCommitRename}
        onCancelRename={handleCancelRename}
        onSetPinned={handleSetPinned}
        onShareConversation={handleShareConversation}
        onDeleteConversation={handleDeleteConversation}
        onSetPendingDelete={setPendingDeleteId}
        onSelectForBulk={handleSelectForBulk}
        onEnterSelectionMode={enterSelectionMode}
      />
    ),
    [
      busyConversationIds,
      currentConversationId,
      handleCancelRename,
      handleCommitRename,
      handleDeleteConversation,
      handleSelectForBulk,
      handleRenameDraftChange,
      handleSelectConversation,
      handleSetPinned,
      handleShareConversation,
      handleStartRenaming,
      isBulkDeleting,
      canShareConversations,
      enterSelectionMode,
      pendingDeleteId,
      renameDraft,
      renamingId,
      runningConversationIds,
      selectableConversationIds,
      selectedConversationIds,
      selectionMode,
    ],
  );

  return (
    <aside
      className={cn(
        "chat-history-sidebar zone-font-scale flex h-full shrink-0 flex-col overflow-hidden border-r border-border/50 bg-[hsl(var(--sidebar-bg))] transition-[width,opacity] duration-200 ease-out",
        isOpen ? "w-[272px] opacity-100" : "w-0 opacity-0",
      )}
      style={{ "--zone-font-scale": fontScale } as CSSProperties}
    >
      <div className="chat-history-sidebar-inner flex w-[272px] min-w-[272px] min-h-0 flex-1 flex-col">
        <MacOsTitleBarSpacer className="bg-[hsl(var(--sidebar-bg))]" />
        <div className="shrink-0 border-b border-border/50 px-2 pb-3 pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 -translate-y-0.5 items-center gap-2">
              <img
                src={iconSimpleUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="h-8 w-8 shrink-0 select-none rounded-xl object-contain"
              />
              <div className="min-w-0">
                <div className="truncate font-semibold tracking-tight">Live Agent</div>
              </div>
            </div>

            {!isMacOsTauri() && (
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
            )}
          </div>

          <div className="mt-3 flex flex-col gap-0.5">
            <Button
              type="button"
              variant="ghost"
              onClick={onNewConversation}
              className={cn(
                "chat-history-new-conversation-button h-[30px] w-full justify-start gap-3 rounded-lg px-3 text-[calc(14px*var(--zone-font-scale,1))] font-normal leading-5 shadow-none transition-colors",
                activeView === "chat"
                  ? "text-foreground/90 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08]"
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
          className={cn(
            "grid min-h-0 flex-1 content-start",
            isProjectSectionResizing ? undefined : SIDEBAR_SECTION_ROWS_TRANSITION_CLASS,
          )}
        >
          {showProjects ? (
            <>
              <div
                ref={projectsHeaderRef}
                className="flex items-center justify-between px-2 pb-1 pt-2"
              >
                <button
                  type="button"
                  aria-expanded={!projectsCollapsed}
                  className="group flex min-w-0 items-center gap-1 rounded-md px-3 py-1 text-xs font-semibold text-muted-foreground outline-hidden"
                  onClick={() => onProjectsCollapsedChange?.(!projectsCollapsed)}
                >
                  <span>{t("chat.workspaceSection")}</span>
                  <ChevronRight
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 opacity-0 transition-[opacity,transform] duration-300 ease-in-out group-hover:opacity-100"
                    style={{ transform: `rotate(${projectsCollapsed ? 0 : 90}deg)` }}
                  />
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(PROJECT_ICON_BUTTON_CLASS, "hover:!bg-transparent")}
                  title={t("chat.workspaceCreate")}
                  aria-label={t("chat.workspaceCreate")}
                  onClick={() => onCreateProject?.()}
                  disabled={!onCreateProject}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div
                aria-hidden={projectsCollapsed}
                inert={projectsCollapsed}
                className={cn(
                  "min-h-0 overflow-y-auto overflow-x-hidden transition-opacity duration-300 ease-out motion-reduce:transition-none",
                  projectsCollapsed ? "opacity-0" : "opacity-100",
                )}
              >
                <div ref={projectsBodyRef} className="space-y-0.5 px-2 pb-0.5">
                  {renderedProjects.map((project) => {
                    const pathKey = workspaceProjectPathKey(project.path);
                    return (
                      <ProjectRow
                        key={project.id}
                        project={project}
                        isActive={activeProjectId === project.id}
                        isMissing={missingProjectPathKeys.has(pathKey)}
                        isRunning={runningProjectPathKeys.has(pathKey)}
                        isRenaming={projectRenamingId === project.id}
                        isPendingRemove={pendingProjectRemoveId === project.id}
                        renameDraft={projectRenameDraft}
                        onSelectProject={handleSelectProject}
                        onBrowseProjectInFileTree={
                          onBrowseProjectInFileTree ? handleBrowseProjectInFileTree : undefined
                        }
                        onBrowseProjectInSystemFileManager={
                          onBrowseProjectInSystemFileManager
                            ? handleBrowseProjectInSystemFileManager
                            : undefined
                        }
                        onStartRenamingProject={handleStartRenamingProject}
                        onProjectRenameDraftChange={handleProjectRenameDraftChange}
                        onCommitProjectRename={handleCommitProjectRename}
                        onCancelProjectRename={handleCancelProjectRename}
                        onSetProjectPinned={handleSetProjectPinned}
                        onRemoveProject={handleRemoveProject}
                        isArchived={false}
                        canArchive={canArchiveProjects}
                        onArchiveProject={handleArchiveProject}
                        onUnarchiveProject={handleUnarchiveProject}
                        onSetPendingRemove={setPendingProjectRemoveId}
                      />
                    );
                  })}
                  {hiddenProjectCount > 0 || showAllProjects ? (
                    <button
                      type="button"
                      onClick={() => setShowAllProjects((current) => !current)}
                      className="flex w-full items-center justify-center rounded-md px-2 py-1.5 text-[calc(11.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground/80 transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {showAllProjects
                        ? t("chat.workspaceShowLess")
                        : t("chat.workspaceShowAll").replace(
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
                        className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[calc(11.5px*var(--zone-font-scale,1))] font-medium text-muted-foreground/80 transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
                                isRenaming={projectRenamingId === project.id}
                                isPendingRemove={pendingProjectRemoveId === project.id}
                                renameDraft={projectRenameDraft}
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
                                onStartRenamingProject={handleStartRenamingProject}
                                onProjectRenameDraftChange={handleProjectRenameDraftChange}
                                onCommitProjectRename={handleCommitProjectRename}
                                onCancelProjectRename={handleCancelProjectRename}
                                onSetProjectPinned={handleSetProjectPinned}
                                onRemoveProject={handleRemoveProject}
                                isArchived
                                canArchive={false}
                                onArchiveProject={handleArchiveProject}
                                onUnarchiveProject={handleUnarchiveProject}
                                onSetPendingRemove={setPendingProjectRemoveId}
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
                  "group items-center justify-center border-0 bg-transparent p-0 focus-visible:outline-none",
                  canResizeProjectSections
                    ? "hidden h-2 cursor-row-resize touch-none md:flex"
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
                onClick={() => onRecentCollapsedChange?.(!recentCollapsed)}
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={handleBulkDelete}
                    disabled={selectedConversationIds.size === 0 || isBulkDeleting}
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
                  {items.length > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => enterSelectionMode()}
                      disabled={selectableConversationIds.size === 0}
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
            {errorMessage ? (
              <div className="shrink-0 px-2 pb-2">
                <SidebarStateCard
                  title={errorMessage}
                  description={errorDetail ?? undefined}
                  tone="error"
                  onDismiss={onDismissError}
                  dismissLabel={t("chat.cancel")}
                />
              </div>
            ) : null}
            <div
              ref={historyScrollRef}
              aria-busy={isListLoading || isLoadingMore}
              className="chat-history-list min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3"
            >
              {/* Render priority: skeleton (loading with zero rows) → rows
                  (with a syncing pill) → empty state only when ready without
                  error. The error banner above never replaces the rows. The
                  scope-keyed wrapper replays a soft enter transition when the
                  workspace scope changes. */}
              {isListLoading && items.length === 0 ? (
                <HistoryListLoadingSkeleton />
              ) : (
                <div key={scopeKey || "scope"} className="chat-history-scope-enter">
                  {listStatus === "syncing" ? (
                    <div className="flex items-center gap-2 px-2 pb-1 pt-1 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-muted-foreground/75">
                      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/35 opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary/70" />
                      </span>
                      <span>{t("chat.history.syncing")}</span>
                    </div>
                  ) : null}
                  {items.length === 0 ? (
                    listStatus === "ready" && !errorMessage ? (
                      <div className="flex items-center justify-center px-4 py-8 text-center">
                        <p className="text-xs font-medium text-muted-foreground/60">
                          {t("chat.emptyChatHistory")}
                        </p>
                      </div>
                    ) : null
                  ) : (
                    <div className="relative" style={{ height: historyVirtualizer.getTotalSize() }}>
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
                            {renderHistoryRow(item)}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
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
        <div className="shrink-0 border-t border-border/50 bg-[hsl(var(--sidebar-bg))] px-2 py-1.5">
          <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onOpenSettings}
              className="h-8 w-full min-w-0 justify-start gap-2.5 rounded-lg px-2.5 text-[calc(13px*var(--zone-font-scale,1))] font-normal text-foreground/85 shadow-none hover:bg-foreground/[0.08] hover:text-foreground"
              title={t("tooltip.settings")}
            >
              <Settings className="h-4 w-4 shrink-0 text-foreground/75" />
              <span className="truncate">{t("tooltip.settings")}</span>
            </Button>
            {appUpdate?.showUpdateButton ? (
              <AppUpdateButton appUpdate={appUpdate} iconOnly />
            ) : null}
          </div>
        </div>
      </div>
      {bulkDeleteDialog}
    </aside>
  );
});
