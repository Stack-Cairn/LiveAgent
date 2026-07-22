import { Tooltip } from "@base-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../i18n";
import type { ChatHistorySummary } from "../../lib/chat/chatHistory";
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
import {
  AlertCircle,
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
import { Button } from "../ui/button";
import { useConfirmDialog } from "../ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";

export type ChatHistorySidebarListStatus = "initial" | "loading" | "syncing" | "ready";
export type ChatHistorySidebarMutationKind = "rename" | "pin" | "delete";

type ChatHistorySidebarProps = {
  items: readonly ChatHistorySummary[];
  currentConversationId: string;
  // Per-row in-flight mutations: only that row's menu/inputs disable.
  busyConversationIds: ReadonlyMap<string, ChatHistorySidebarMutationKind>;
  runningConversationIds: ReadonlySet<string>;
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
  // Disables the workspace + recent-conversation sections as one block while
  // either the browser transport or desktop Agent is unavailable; the top
  // sidebar actions stay usable.
  sectionsDisabled?: boolean;
  renamingId: string | null;
  renameDraft: string;
  isOpen: boolean;
  fontScale?: number;
  activeView?: "chat" | "skills-hub" | "mcp-hub";
  showProjects?: boolean;
  // Pre-sorted by the container (pinned/running/activity); rendered as-is.
  projects?: WorkspaceProject[];
  activeProjectId?: string;
  missingProjectPathKeys: ReadonlySet<string>;
  runningProjectPathKeys: ReadonlySet<string>;
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
  onStartRenaming: (item: ChatHistorySummary) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSetPinned: (id: string, isPinned: boolean) => void;
  canShareConversations: boolean;
  sharedConversationCount: number;
  onShareConversation: (item: ChatHistorySummary) => void;
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
};

const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 820px)";
const MOBILE_MENU_LONG_PRESS_MS = 520;
const MOBILE_MENU_MOVE_TOLERANCE_PX = 10;
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
// Projects are not virtualized; cap the rendered rows and offer an explicit
// "show all (N)" expansion instead.
const SIDEBAR_PROJECT_RENDER_CAP = 30;
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

type HistoryRowProps = {
  item: ChatHistorySummary;
  isActive: boolean;
  isBusy: boolean;
  isRunning: boolean;
  isDeleteDisabled: boolean;
  canShareConversation: boolean;
  isRenaming: boolean;
  isPendingDelete: boolean;
  isSelectionMode: boolean;
  isSelected: boolean;
  isSelectionDisabled: boolean;
  isInteractionDisabled: boolean;
  isMobileMenuLayout: boolean;
  renameDraft: string;
  onSelectConversation: (id: string) => void;
  onStartRenaming: (item: ChatHistorySummary) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSetPinned: (id: string, isPinned: boolean) => void;
  onShareConversation: (item: ChatHistorySummary) => void;
  onDeleteConversation: (id: string) => void;
  onSetPendingDelete: (id: string | null) => void;
  onSelectForBulk: (id: string, modifiers: { shiftKey: boolean; toggleKey: boolean }) => void;
  onEnterSelectionMode: (id: string) => void;
  menuOpen: boolean;
  menuSide: "bottom" | "right";
  onMenuOpenChange: (id: string, open: boolean) => void;
};

function areRenderedHistoryItemsEqual(previous: ChatHistorySummary, next: ChatHistorySummary) {
  return (
    previous.id === next.id &&
    previous.title === next.title &&
    previous.isPinned === next.isPinned &&
    previous.isShared === next.isShared &&
    previous.isPending === next.isPending
  );
}

function areHistoryRowPropsEqual(previous: HistoryRowProps, next: HistoryRowProps) {
  return (
    areRenderedHistoryItemsEqual(previous.item, next.item) &&
    previous.isActive === next.isActive &&
    previous.isBusy === next.isBusy &&
    previous.isRunning === next.isRunning &&
    previous.isDeleteDisabled === next.isDeleteDisabled &&
    previous.canShareConversation === next.canShareConversation &&
    previous.isRenaming === next.isRenaming &&
    previous.isPendingDelete === next.isPendingDelete &&
    previous.isSelectionMode === next.isSelectionMode &&
    previous.isSelected === next.isSelected &&
    previous.isSelectionDisabled === next.isSelectionDisabled &&
    previous.isInteractionDisabled === next.isInteractionDisabled &&
    previous.isMobileMenuLayout === next.isMobileMenuLayout &&
    previous.renameDraft === next.renameDraft &&
    previous.menuOpen === next.menuOpen &&
    previous.menuSide === next.menuSide &&
    previous.onSelectConversation === next.onSelectConversation &&
    previous.onStartRenaming === next.onStartRenaming &&
    previous.onRenameDraftChange === next.onRenameDraftChange &&
    previous.onCommitRename === next.onCommitRename &&
    previous.onCancelRename === next.onCancelRename &&
    previous.onSetPinned === next.onSetPinned &&
    previous.onShareConversation === next.onShareConversation &&
    previous.onDeleteConversation === next.onDeleteConversation &&
    previous.onSetPendingDelete === next.onSetPendingDelete &&
    previous.onSelectForBulk === next.onSelectForBulk &&
    previous.onEnterSelectionMode === next.onEnterSelectionMode &&
    previous.onMenuOpenChange === next.onMenuOpenChange
  );
}

const HistoryRow = memo(function HistoryRow(props: HistoryRowProps) {
  const {
    item,
    isActive,
    isBusy,
    isRunning,
    isDeleteDisabled,
    canShareConversation,
    isRenaming,
    isPendingDelete,
    isSelectionMode,
    isSelected,
    isSelectionDisabled,
    isInteractionDisabled,
    isMobileMenuLayout,
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
    menuOpen,
    menuSide,
    onMenuOpenChange,
  } = props;
  const { t } = useLocale();

  const inputRef = useRef<HTMLInputElement | null>(null);
  // Enter/Escape mark the blur as handled so onBlur commits exactly once —
  // symmetric with ProjectRow's skipNextBlurCommitRef.
  const skipNextBlurCommitRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTriggeredRef = useRef(false);
  const longPressCancelledRef = useRef(false);
  const [isLongPressActive, setIsLongPressActive] = useState(false);

  const handleSelect = useCallback(
    (
      modifiers: { shiftKey: boolean; toggleKey: boolean } = {
        shiftKey: false,
        toggleKey: false,
      },
    ) => {
      if (isInteractionDisabled) {
        return;
      }
      if (isSelectionMode || modifiers.shiftKey || modifiers.toggleKey) {
        if (!isSelectionDisabled) {
          onSelectForBulk(item.id, modifiers);
        }
        return;
      }
      onSelectConversation(item.id);
    },
    [
      isInteractionDisabled,
      isSelectionDisabled,
      isSelectionMode,
      item.id,
      onSelectConversation,
      onSelectForBulk,
    ],
  );

  const handleStartRenaming = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    onStartRenaming(item);
  }, [isInteractionDisabled, item, onStartRenaming]);

  const handleRequestDelete = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    onSetPendingDelete(item.id);
  }, [isInteractionDisabled, item.id, onSetPendingDelete]);

  const handleEnterSelectionMode = useCallback(() => {
    if (!isInteractionDisabled && !isSelectionDisabled) {
      onEnterSelectionMode(item.id);
    }
  }, [isInteractionDisabled, isSelectionDisabled, item.id, onEnterSelectionMode]);

  const handleTogglePinned = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    onSetPinned(item.id, item.isPinned !== true);
  }, [isInteractionDisabled, item.id, item.isPinned, onSetPinned]);

  const handleShare = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    onShareConversation(item);
  }, [isInteractionDisabled, item, onShareConversation]);

  const handleConfirmDelete = useCallback(() => {
    onSetPendingDelete(null);
    if (isInteractionDisabled) {
      return;
    }
    onDeleteConversation(item.id);
  }, [isInteractionDisabled, item.id, onDeleteConversation, onSetPendingDelete]);

  const handleCancelDelete = useCallback(() => {
    onSetPendingDelete(null);
  }, [onSetPendingDelete]);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open && isInteractionDisabled) {
        return;
      }
      onMenuOpenChange(item.id, open);
    },
    [isInteractionDisabled, item.id, onMenuOpenChange],
  );

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const resetLongPressState = useCallback(() => {
    clearLongPressTimer();
    longPressStartRef.current = null;
    longPressTriggeredRef.current = false;
    longPressCancelledRef.current = false;
    setIsLongPressActive(false);
  }, [clearLongPressTimer]);

  const cancelLongPressGesture = useCallback(() => {
    clearLongPressTimer();
    longPressStartRef.current = null;
    longPressCancelledRef.current = true;
    setIsLongPressActive(false);
  }, [clearLongPressTimer]);

  const openMobileMenuFromLongPress = useCallback(() => {
    clearLongPressTimer();

    if (isInteractionDisabled || isSelectionMode || !isMobileMenuLayout || isBusy) {
      setIsLongPressActive(false);
      longPressCancelledRef.current = true;
      return;
    }

    longPressTriggeredRef.current = true;
    setIsLongPressActive(false);
    onMenuOpenChange(item.id, true);
  }, [
    clearLongPressTimer,
    isBusy,
    isInteractionDisabled,
    isSelectionMode,
    isMobileMenuLayout,
    item.id,
    onMenuOpenChange,
  ]);

  const handleTitlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (isInteractionDisabled || isSelectionMode || !isMobileMenuLayout || isBusy) {
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      clearLongPressTimer();
      longPressTriggeredRef.current = false;
      longPressCancelledRef.current = false;
      setIsLongPressActive(true);
      longPressStartRef.current = { x: event.clientX, y: event.clientY };
      longPressTimerRef.current = window.setTimeout(
        openMobileMenuFromLongPress,
        MOBILE_MENU_LONG_PRESS_MS,
      );
    },
    [
      clearLongPressTimer,
      isBusy,
      isInteractionDisabled,
      isSelectionMode,
      isMobileMenuLayout,
      openMobileMenuFromLongPress,
    ],
  );

  const handleTitlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isMobileMenuLayout || longPressStartRef.current === null) {
        return;
      }

      const deltaX = Math.abs(event.clientX - longPressStartRef.current.x);
      const deltaY = Math.abs(event.clientY - longPressStartRef.current.y);
      if (deltaX > MOBILE_MENU_MOVE_TOLERANCE_PX || deltaY > MOBILE_MENU_MOVE_TOLERANCE_PX) {
        cancelLongPressGesture();
      }
    },
    [cancelLongPressGesture, isMobileMenuLayout],
  );

  const handleTitlePointerUp = useCallback(() => {
    if (!isMobileMenuLayout || isInteractionDisabled) {
      resetLongPressState();
      return;
    }

    const shouldSelect = !longPressTriggeredRef.current && !longPressCancelledRef.current;
    resetLongPressState();

    if (shouldSelect && !isBusy) {
      handleSelect();
    }
  }, [handleSelect, isBusy, isInteractionDisabled, isMobileMenuLayout, resetLongPressState]);

  const handleTitlePointerCancel = useCallback(() => {
    if (!isMobileMenuLayout) {
      return;
    }
    cancelLongPressGesture();
  }, [cancelLongPressGesture, isMobileMenuLayout]);

  const handleTitleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (isMobileMenuLayout) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      handleSelect({
        shiftKey: event.shiftKey,
        toggleKey: event.ctrlKey || event.metaKey,
      });
    },
    [handleSelect, isMobileMenuLayout],
  );

  const handleTitleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!isMobileMenuLayout) {
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleSelect();
      }
    },
    [handleSelect, isMobileMenuLayout],
  );

  const handleTitleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (!isMobileMenuLayout) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsLongPressActive(false);
    },
    [isMobileMenuLayout],
  );

  const shouldShowMobilePressFeedback = isMobileMenuLayout && (isLongPressActive || menuOpen);

  useEffect(() => {
    if (!isRenaming) return;
    skipNextBlurCommitRef.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isRenaming]);

  useEffect(() => {
    if (!isInteractionDisabled) {
      return;
    }
    resetLongPressState();
    onMenuOpenChange(item.id, false);
  }, [isInteractionDisabled, item.id, onMenuOpenChange, resetLongPressState]);

  useEffect(() => () => clearLongPressTimer(), [clearLongPressTimer]);

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
            disabled={isInteractionDisabled}
            className="h-7 rounded-xl border-border/60 text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            {t("chat.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleConfirmDelete}
            disabled={isInteractionDisabled || isBusy || isDeleteDisabled}
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
        !isSelectionMode && shouldShowMobilePressFeedback && "bg-foreground/[0.09] text-foreground",
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
            disabled={isInteractionDisabled || isBusy}
          />
        </div>
      ) : (
        <DropdownMenu
          open={!isInteractionDisabled && !isSelectionMode && menuOpen}
          onOpenChange={handleMenuOpenChange}
          modal={false}
        >
          {/* biome-ignore lint/complexity/noUselessFragments: DropdownMenu keeps trigger and popup siblings under one provider child */}
          <>
            <div className="relative min-w-0">
              {isMobileMenuLayout && !isSelectionMode ? (
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-hidden="true"
                      tabIndex={-1}
                      className="chat-history-row-title-menu-anchor absolute inset-0 h-full w-full rounded-[1rem] opacity-0 pointer-events-none"
                    />
                  }
                />
              ) : null}

              <button
                type="button"
                onClick={handleTitleClick}
                onMouseDown={(event) => {
                  if (event.shiftKey) event.preventDefault();
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  if (!isSelectionMode && !isMobileMenuLayout && !isRunning && !isBusy) {
                    handleStartRenaming();
                  }
                }}
                onContextMenu={handleTitleContextMenu}
                onKeyDown={handleTitleKeyDown}
                onPointerDown={handleTitlePointerDown}
                onPointerMove={handleTitlePointerMove}
                onPointerUp={handleTitlePointerUp}
                onPointerCancel={handleTitlePointerCancel}
                onPointerLeave={handleTitlePointerCancel}
                aria-pressed={isSelectionMode ? isSelected : undefined}
                disabled={isInteractionDisabled || (isSelectionMode && isSelectionDisabled)}
                className="chat-history-row-title-button flex h-[30px] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring"
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
            </div>

            <div
              className={cn(
                "relative flex items-center justify-end overflow-hidden transition-[max-width,opacity] duration-200 ease-out",
                isSelectionMode && "hidden",
                isRunning
                  ? // Mobile rows render no inline action buttons, so this flex
                    // box has zero content width AND zero height — max-w alone
                    // leaves the absolutely-positioned spinner fully clipped by
                    // overflow-hidden. Reserve the spinner slot explicitly
                    // (both axes) and skip the hover/focus swap.
                    isMobileMenuLayout
                    ? "h-7 w-7 opacity-100"
                    : "max-w-7 opacity-100 group-hover/item:max-w-16 group-focus-within/item:max-w-16"
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
                    isMobileMenuLayout
                      ? "opacity-100"
                      : [
                          "opacity-100 group-hover/item:opacity-0 group-focus-within/item:opacity-0",
                          menuOpen && "opacity-0",
                        ],
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
                {!isMobileMenuLayout ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={PROJECT_ICON_BUTTON_CLASS}
                      title={
                        item.isPinned ? t("chat.conversationUnpin") : t("chat.conversationPin")
                      }
                      aria-label={
                        item.isPinned ? t("chat.conversationUnpin") : t("chat.conversationPin")
                      }
                      onClick={handleTogglePinned}
                      disabled={isInteractionDisabled || isBusy || item.isPending}
                    >
                      {item.isPinned ? (
                        <PinOff className="h-3.5 w-3.5" />
                      ) : (
                        <Pin className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={PROJECT_ICON_BUTTON_CLASS}
                          disabled={isInteractionDisabled || isBusy}
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
                  </>
                ) : null}
              </div>
            </div>

            {!isSelectionMode ? (
              <DropdownMenuContent
                side={menuSide}
                align="start"
                sideOffset={8}
                collisionPadding={12}
                className="sidebar-context-menu min-w-[10rem] rounded-xl border-border/60 bg-background/95 backdrop-blur-xl"
              >
                {isMobileMenuLayout && !item.isPending ? (
                  <DropdownMenuItem
                    disabled={isInteractionDisabled}
                    onSelect={handleTogglePinned}
                    className="gap-2"
                  >
                    {item.isPinned ? (
                      <PinOff className="h-3.5 w-3.5" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
                    {item.isPinned ? t("chat.conversationUnpin") : t("chat.conversationPin")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={isInteractionDisabled || isRunning || isBusy}
                  onSelect={handleEnterSelectionMode}
                  className="gap-2"
                >
                  <ListChecks className="h-3.5 w-3.5" />
                  {t("chat.conversationBulkSelect")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={isInteractionDisabled}
                  onSelect={handleStartRenaming}
                  className="gap-2"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  {t("chat.conversationRename")}
                </DropdownMenuItem>
                {canShareConversation && !item.isPending ? (
                  <DropdownMenuItem
                    disabled={isInteractionDisabled}
                    onSelect={handleShare}
                    className="gap-2"
                  >
                    <Share2 className="h-3.5 w-3.5" />
                    {t("chat.conversationShare")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={isInteractionDisabled || isDeleteDisabled}
                  onSelect={handleRequestDelete}
                  className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("chat.conversationDelete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            ) : null}
          </>
        </DropdownMenu>
      )}
    </div>
  );
}, areHistoryRowPropsEqual);

const ProjectRow = memo(function ProjectRow(props: {
  project: WorkspaceProject;
  isActive: boolean;
  isMissing: boolean;
  isRunning: boolean;
  isRenaming: boolean;
  isPendingRemove: boolean;
  isInteractionDisabled: boolean;
  renameDraft: string;
  onSelectProject: (project: WorkspaceProject) => void;
  onBrowseProjectInFileTree?: (project: WorkspaceProject) => void;
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
  menuOpen: boolean;
  onMenuOpenChange: (projectId: string, open: boolean) => void;
}) {
  const {
    project,
    isActive,
    isMissing,
    isRunning,
    isRenaming,
    isPendingRemove,
    isInteractionDisabled,
    renameDraft,
    onSelectProject,
    onBrowseProjectInFileTree,
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
    menuOpen,
    onMenuOpenChange,
  } = props;
  const { t } = useLocale();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const skipNextBlurCommitRef = useRef(false);
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
    if (isInteractionDisabled) {
      return;
    }
    onSetPendingRemove(project.id);
  }, [isInteractionDisabled, onSetPendingRemove, project.id]);

  const handleConfirmRemove = useCallback(() => {
    onSetPendingRemove(null);
    if (isInteractionDisabled) {
      return;
    }
    onRemoveProject(project);
  }, [isInteractionDisabled, onRemoveProject, onSetPendingRemove, project]);

  const handleCancelRemove = useCallback(() => {
    onSetPendingRemove(null);
  }, [onSetPendingRemove]);

  const handleTogglePinned = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    onSetProjectPinned(project, !isPinned);
  }, [isInteractionDisabled, isPinned, onSetProjectPinned, project]);

  const handleBrowseInFileTree = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    onBrowseProjectInFileTree?.(project);
  }, [isInteractionDisabled, onBrowseProjectInFileTree, project]);

  const handleArchive = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    onArchiveProject(project);
  }, [isInteractionDisabled, onArchiveProject, project]);

  const handleUnarchive = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    onUnarchiveProject(project);
  }, [isInteractionDisabled, onUnarchiveProject, project]);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      if (open && isInteractionDisabled) {
        return;
      }
      onMenuOpenChange(project.id, open);
    },
    [isInteractionDisabled, onMenuOpenChange, project.id],
  );

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
            disabled={isInteractionDisabled}
            className="h-7 rounded-xl border-border/60 bg-background text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            {t("chat.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleConfirmRemove}
            disabled={isInteractionDisabled || isRunning}
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
            disabled={isInteractionDisabled}
          />
        </div>
      ) : (
        <Tooltip.Root disabled={isInteractionDisabled}>
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
                  if (!isDefaultProject && !isInteractionDisabled) {
                    onStartRenamingProject(project);
                  }
                }}
                disabled={isInteractionDisabled}
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
                  disabled={isInteractionDisabled}
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
                    disabled={isInteractionDisabled}
                  >
                    {isPinned ? (
                      <PinOff className="h-3.5 w-3.5" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
                  </Button>
                ) : null}
                <DropdownMenu
                  open={!isInteractionDisabled && menuOpen}
                  onOpenChange={handleMenuOpenChange}
                  modal={false}
                >
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={PROJECT_ICON_BUTTON_CLASS}
                        title={t("chat.workspaceMore")}
                        aria-label={t("chat.workspaceMore")}
                        disabled={isInteractionDisabled}
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
                          disabled={isInteractionDisabled}
                          onSelect={() => onStartRenamingProject(project)}
                          className="gap-2"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          {t("chat.workspaceRename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={isInteractionDisabled}
                          onSelect={handleRequestRemove}
                          className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("chat.workspaceRemove")}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                    {!isArchived && canArchive ? (
                      <DropdownMenuItem
                        disabled={isInteractionDisabled}
                        onSelect={handleArchive}
                        className="gap-2"
                      >
                        <Archive className="h-3.5 w-3.5" />
                        {t("chat.workspaceArchive")}
                      </DropdownMenuItem>
                    ) : null}
                    {isArchived ? (
                      <DropdownMenuItem
                        disabled={isInteractionDisabled}
                        onSelect={handleUnarchive}
                        className="gap-2"
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" />
                        {t("chat.workspaceUnarchive")}
                      </DropdownMenuItem>
                    ) : null}
                    {onBrowseProjectInFileTree ? (
                      <DropdownMenuItem
                        disabled={isInteractionDisabled}
                        onSelect={handleBrowseInFileTree}
                        className="gap-2"
                      >
                        <FolderTree className="h-3.5 w-3.5" />
                        {t("chat.workspaceBrowseInFileTree")}
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
    sectionsDisabled = false,
    renamingId,
    renameDraft,
    isOpen,
    fontScale = 1,
    activeView = "chat",
    showProjects = false,
    projects = [],
    activeProjectId,
    missingProjectPathKeys,
    runningProjectPathKeys,
    projectRenamingId = null,
    projectRenameDraft = "",
    projectsCollapsed = false,
    recentCollapsed = false,
    onProjectsCollapsedChange,
    onRecentCollapsedChange,
    onCreateProject,
    onSelectProject,
    onBrowseProjectInFileTree,
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
  const handleStartRenaming = useStableEvent((item: ChatHistorySummary) => {
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
  const handleShareConversation = useStableEvent((item: ChatHistorySummary) => {
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
  const handleSetPendingProjectRemove = useStableEvent((projectId: string | null) => {
    if (!sectionsDisabled || projectId === null) {
      setPendingProjectRemoveId(projectId);
    }
  });
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
  const handleCreateProject = useStableEvent(() => {
    if (!sectionsDisabled) {
      onCreateProject?.();
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
  const handleStartRenamingProject = useStableEvent((project: WorkspaceProject) => {
    if (!sectionsDisabled) {
      onStartRenamingProject?.(project);
    }
  });
  const handleProjectRenameDraftChange = useStableEvent((value: string) => {
    if (!sectionsDisabled) {
      onProjectRenameDraftChange?.(value);
    }
  });
  const handleCommitProjectRename = useStableEvent(() => {
    if (!sectionsDisabled) {
      onCommitProjectRename?.();
    }
  });
  const handleCancelProjectRename = useStableEvent(() => {
    onCancelProjectRename?.();
  });
  const handleSetProjectPinned = useStableEvent((project: WorkspaceProject, isPinned: boolean) => {
    if (!sectionsDisabled) {
      onSetProjectPinned?.(project, isPinned);
    }
  });
  const handleRemoveProject = useStableEvent((project: WorkspaceProject) => {
    if (!sectionsDisabled) {
      onRemoveProject?.(project);
    }
  });
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
    setIsBulkDeleting(false);
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
  // Projects arrive pre-sorted from the container; only the render cap is
  // applied here.
  const renderedProjects = useMemo(
    () => (showAllProjects ? activeProjects : activeProjects.slice(0, SIDEBAR_PROJECT_RENDER_CAP)),
    [activeProjects, showAllProjects],
  );
  // Archiving must always leave at least one active workspace behind.
  const canArchiveProjects = Boolean(onArchiveProject) && activeProjects.length > 1;
  const [archivedGroupOpen, setArchivedGroupOpen] = useState(false);
  const hasCappedProjects = activeProjects.length > SIDEBAR_PROJECT_RENDER_CAP;
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
    setPendingProjectRemoveId(null);
    exitSelectionMode();
    handleCancelRename();
    handleCancelProjectRename();
    projectSectionResizeCleanupRef.current?.();
    if (projectSectionResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(projectSectionResizeFrameRef.current);
      projectSectionResizeFrameRef.current = null;
    }
    setIsProjectSectionResizing(false);
  }, [exitSelectionMode, handleCancelProjectRename, handleCancelRename, sectionsDisabled]);

  useEffect(() => {
    if (!pendingProjectRemoveId) {
      return;
    }
    if (!projects.some((project) => project.id === pendingProjectRemoveId)) {
      setPendingProjectRemoveId(null);
    }
  }, [pendingProjectRemoveId, projects]);

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
    (item: ChatHistorySummary) => (
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
        isSelectionDisabled={isBulkDeleting || !selectableConversationIds.has(item.id)}
        isInteractionDisabled={sectionsDisabled}
        isMobileMenuLayout={isMobileMenuLayout}
        renameDraft={renamingId === item.id ? renameDraft : ""}
        onSelectConversation={handleSelectConversation}
        onStartRenaming={handleStartRenaming}
        onRenameDraftChange={handleRenameDraftChange}
        onCommitRename={handleCommitRename}
        onCancelRename={handleCancelRename}
        onSetPinned={handleSetPinned}
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
      handleSetPinned,
      handleSetPendingDelete,
      handleShareConversation,
      handleStartRenaming,
      busyConversationIds,
      canShareConversations,
      enterSelectionMode,
      isBulkDeleting,
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
        <div className="shrink-0 border-b border-border/50 px-2 pb-3 pt-3">
          <div className="flex items-center justify-between gap-2">
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
                className="flex items-center justify-between px-2 pb-1 pt-2"
              >
                <button
                  type="button"
                  aria-expanded={!projectsCollapsed}
                  className="group flex min-w-0 items-center gap-1 rounded-md px-3 py-1 text-xs font-semibold text-muted-foreground outline-hidden"
                  onClick={handleProjectsCollapsedChange}
                  disabled={sectionsDisabled}
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
                  onClick={handleCreateProject}
                  disabled={sectionsDisabled || !onCreateProject}
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
                        isInteractionDisabled={sectionsDisabled}
                        renameDraft={projectRenameDraft}
                        onSelectProject={handleSelectProject}
                        onBrowseProjectInFileTree={
                          onBrowseProjectInFileTree ? handleBrowseProjectInFileTree : undefined
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
                        onSetPendingRemove={handleSetPendingProjectRemove}
                        menuOpen={!sectionsDisabled && openProjectMenuId === project.id}
                        onMenuOpenChange={handleProjectMenuOpenChange}
                      />
                    );
                  })}
                  {hasCappedProjects ? (
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
                                isRenaming={projectRenamingId === project.id}
                                isPendingRemove={pendingProjectRemoveId === project.id}
                                isInteractionDisabled={sectionsDisabled}
                                renameDraft={projectRenameDraft}
                                onSelectProject={handleSelectProject}
                                onBrowseProjectInFileTree={
                                  onBrowseProjectInFileTree
                                    ? handleBrowseProjectInFileTree
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
                                onSetPendingRemove={handleSetPendingProjectRemove}
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={handleBulkDelete}
                    disabled={
                      sectionsDisabled || selectedConversationIds.size === 0 || isBulkDeleting
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
        <div className="shrink-0 border-t border-border/50 bg-[hsl(var(--sidebar-bg))] px-2 py-1.5">
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
        </div>
      </div>
      {bulkDeleteDialog}
    </aside>
  );
});
