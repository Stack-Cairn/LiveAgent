import {
  DEFAULT_WORKSPACE_PROJECT_ID,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@liveagent/app/lib/settings";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Columns2,
  Edit3,
  Folder,
  FolderClosed,
  FolderOpen,
  FolderTree,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Pin,
  PinOff,
  Settings,
  Share2,
  Trash2,
  X,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { Input } from "@liveagent/ui/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@liveagent/ui/components/ui/tooltip";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  clearActiveConversationReferenceDrag,
  writeConversationReferenceDragPayload,
} from "@liveagent/ui/lib/chat/conversationReferenceDrag";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  memo,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SidebarConversation } from "../../lib/sidebar/types";
import type { WorkspaceProjectGroup } from "../../lib/workspaceProjectTypes";

export type WorkspaceProjectRemoveOptions = {
  deleteWorktree?: boolean;
  deleteBranch?: boolean;
};

type PendingWorkspaceProjectAction = {
  projectId: string;
  mode: "remove" | "deleteWorktree";
};

const MOBILE_MENU_LONG_PRESS_MS = 520;
const MOBILE_MENU_MOVE_TOLERANCE_PX = 10;
const PROJECT_ICON_BUTTON_CLASS =
  "h-7 w-7 rounded-lg !bg-transparent text-muted-foreground transition-colors hover:!bg-transparent hover:!text-foreground active:!bg-transparent focus-visible:!bg-transparent data-[state=open]:!bg-transparent data-[state=open]:text-foreground data-[popup-open]:!bg-transparent data-[popup-open]:text-foreground";

type HistoryRowProps = {
  item: SidebarConversation;
  isActive: boolean;
  isBusy: boolean;
  isRunning: boolean;
  needsApproval: boolean;
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
  onStartRenaming: (item: SidebarConversation) => void;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSetPinned: (id: string, isPinned: boolean) => void;
  onMoveToWorkspace: (id: string, cwd: string) => void;
  moveWorkspaces: readonly WorkspaceProject[];
  onShareConversation: (item: SidebarConversation) => void;
  onDeleteConversation: (id: string) => void;
  onSetPendingDelete: (id: string | null) => void;
  onSelectForBulk: (id: string, modifiers: { shiftKey: boolean; toggleKey: boolean }) => void;
  onEnterSelectionMode: (id: string) => void;
  menuOpen: boolean;
  menuSide: "bottom" | "right";
  onMenuOpenChange: (id: string, open: boolean) => void;
  /**
   * Workbench pointer-drag intent from the row title area (desktop only).
   * The drag session activates after a movement threshold, so plain clicks
   * keep their existing select semantics.
   */
  onWorkbenchDragIntent?: (
    item: SidebarConversation,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** Menu alternative to dragging: open the conversation in a split pane. */
  onOpenInWorkbenchSplit?: (item: SidebarConversation) => void;
};

function areRenderedHistoryItemsEqual(previous: SidebarConversation, next: SidebarConversation) {
  return (
    previous.id === next.id &&
    previous.title === next.title &&
    previous.cwd === next.cwd &&
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
    previous.needsApproval === next.needsApproval &&
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
    previous.onMoveToWorkspace === next.onMoveToWorkspace &&
    previous.moveWorkspaces === next.moveWorkspaces &&
    previous.onShareConversation === next.onShareConversation &&
    previous.onDeleteConversation === next.onDeleteConversation &&
    previous.onSetPendingDelete === next.onSetPendingDelete &&
    previous.onSelectForBulk === next.onSelectForBulk &&
    previous.onEnterSelectionMode === next.onEnterSelectionMode &&
    previous.onMenuOpenChange === next.onMenuOpenChange &&
    previous.onWorkbenchDragIntent === next.onWorkbenchDragIntent &&
    previous.onOpenInWorkbenchSplit === next.onOpenInWorkbenchSplit
  );
}

export const HistoryRow = memo(function HistoryRow(props: HistoryRowProps) {
  const {
    item,
    isActive,
    isBusy,
    isRunning,
    needsApproval,
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
    onMoveToWorkspace,
    moveWorkspaces,
    onShareConversation,
    onDeleteConversation,
    onSetPendingDelete,
    onSelectForBulk,
    onEnterSelectionMode,
    menuOpen,
    menuSide,
    onMenuOpenChange,
    onWorkbenchDragIntent,
    onOpenInWorkbenchSplit,
  } = props;
  const { t } = useLocale();
  const showRunningIndicator = isRunning && !needsApproval;

  const inputRef = useRef<HTMLInputElement | null>(null);
  // Enter/Escape mark the blur as handled so onBlur commits exactly once —
  // symmetric with ProjectRow's skipNextBlurCommitRef.
  const skipNextBlurCommitRef = useRef(false);
  // Renaming from the menu unmounts the whole dropdown in the commit that
  // mounts the rename input, and Base UI resolves its return-focus target
  // synchronously during that unmount — before the input's ref attaches — so
  // the deferred focus() landed on a fallback element, blurring the input and
  // committing the untouched title ("rename does nothing" on Windows). The
  // menu's finalFocus callback consumes this one-shot flag to skip that
  // return-focus entirely; the isRenaming effect owns focus placement instead.
  const suppressMenuReturnFocusRef = useRef(false);
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

  const handleStartRenamingFromMenu = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    suppressMenuReturnFocusRef.current = true;
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

  const handleMoveToWorkspace = useCallback(
    (cwd: string) => {
      if (!isInteractionDisabled) {
        onMoveToWorkspace(item.id, cwd);
      }
    },
    [isInteractionDisabled, item.id, onMoveToWorkspace],
  );

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
      // Desktop: arm a workbench pane drag from the title area. Touch keeps
      // the long-press menu; renaming/selection/menu states never drag.
      if (
        onWorkbenchDragIntent &&
        !isMobileMenuLayout &&
        !isInteractionDisabled &&
        !isSelectionMode &&
        !isRenaming &&
        !isPendingDelete &&
        !menuOpen &&
        event.pointerType !== "touch" &&
        event.button === 0 &&
        !item.isPending
      ) {
        onWorkbenchDragIntent(item, {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          currentTarget: event.currentTarget,
        });
      }
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
      isPendingDelete,
      isRenaming,
      isSelectionMode,
      isMobileMenuLayout,
      item,
      menuOpen,
      onWorkbenchDragIntent,
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

  const handleNativeConversationDragStart = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>) => {
      if (
        onWorkbenchDragIntent ||
        isInteractionDisabled ||
        isSelectionMode ||
        isRenaming ||
        isPendingDelete ||
        menuOpen ||
        item.isPending
      ) {
        event.preventDefault();
        return;
      }
      if (
        !writeConversationReferenceDragPayload(event.dataTransfer, {
          id: item.id,
          title: item.title,
          cwd: item.cwd,
          updatedAt: item.updatedAt,
        })
      ) {
        event.preventDefault();
      }
    },
    [
      isInteractionDisabled,
      isPendingDelete,
      isRenaming,
      isSelectionMode,
      item,
      menuOpen,
      onWorkbenchDragIntent,
    ],
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
                      className="chat-history-row-title-menu-anchor absolute inset-0 h-full w-full rounded-2xl opacity-0 pointer-events-none"
                    />
                  }
                />
              ) : null}

              <button
                type="button"
                draggable={!onWorkbenchDragIntent && !item.isPending}
                onDragStart={handleNativeConversationDragStart}
                onDragEnd={clearActiveConversationReferenceDrag}
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
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border transition-colors",
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
                {!isSelectionMode && needsApproval ? (
                  <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-emerald-500/[0.14] px-2 text-[calc(10.5px*var(--zone-font-scale,1))] font-medium leading-none text-emerald-700 dark:bg-emerald-400/[0.13] dark:text-emerald-300">
                    {t("chat.toolApproval.sidebarStatus")}
                  </span>
                ) : null}
              </button>
            </div>

            <div
              className={cn(
                "relative flex items-center justify-end overflow-hidden transition-[max-width,opacity] duration-200 ease-out",
                isSelectionMode && "hidden",
                showRunningIndicator || item.isPinned
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
              {showRunningIndicator ? (
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
                  <Loader2 className="h-4 w-4 animate-spin [animation-duration:1.6s] motion-reduce:animate-none" />
                </span>
              ) : item.isPinned ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute right-1.5 flex h-4 w-4 items-center justify-center text-amber-500/90 transition-opacity duration-200",
                    isMobileMenuLayout
                      ? "opacity-100"
                      : [
                          "opacity-100 group-hover/item:opacity-0 group-focus-within/item:opacity-0",
                          menuOpen && "opacity-0",
                        ],
                  )}
                >
                  <Pin className="h-3 w-3" />
                </span>
              ) : null}
              <div
                className={cn(
                  "flex items-center gap-0.5 transition-opacity duration-200",
                  showRunningIndicator || item.isPinned
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
                finalFocus={() => {
                  if (suppressMenuReturnFocusRef.current) {
                    suppressMenuReturnFocusRef.current = false;
                    return false;
                  }
                  return true;
                }}
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
                {onOpenInWorkbenchSplit && !item.isPending ? (
                  <DropdownMenuItem
                    disabled={isInteractionDisabled}
                    onSelect={() => onOpenInWorkbenchSplit(item)}
                    className="gap-2"
                  >
                    <Columns2 className="h-3.5 w-3.5" />
                    {t("workbench.openInSplit")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={isInteractionDisabled}
                  onSelect={handleStartRenamingFromMenu}
                  className="gap-2"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                  {t("chat.conversationRename")}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger
                    disabled={
                      isInteractionDisabled || isRunning || isBusy || moveWorkspaces.length === 0
                    }
                    className="gap-2"
                  >
                    <Folder className="h-3.5 w-3.5" />
                    {t("chat.conversationMoveToWorkspace")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="sidebar-context-menu max-h-[18rem] min-w-[12rem] overflow-y-auto rounded-xl border-border/60 bg-background/95 backdrop-blur-xl">
                    {moveWorkspaces.map((workspace) => (
                      <DropdownMenuItem
                        key={workspace.id}
                        disabled={
                          isInteractionDisabled ||
                          isRunning ||
                          isBusy ||
                          workspace.path === item.cwd
                        }
                        onSelect={() => handleMoveToWorkspace(workspace.path)}
                        className="gap-2"
                      >
                        <FolderClosed className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{workspace.path}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
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

// 项目分组标题行：折叠切换、成员计数、重命名与删除。
export function ProjectGroupHeader(props: {
  group: WorkspaceProjectGroup;
  memberCount: number;
  isRenaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onToggleCollapsed: () => void;
  onStartRename: () => void;
  onDelete: () => void;
}) {
  const {
    group,
    memberCount,
    isRenaming,
    renameDraft,
    onRenameDraftChange,
    onCommitRename,
    onCancelRename,
    onToggleCollapsed,
    onStartRename,
    onDelete,
  } = props;
  const { t } = useLocale();

  if (isRenaming) {
    return (
      <div className="flex h-[30px] items-center gap-2 rounded-lg pl-2 pr-1">
        <Input
          value={renameDraft}
          onChange={(event) => onRenameDraftChange(event.currentTarget.value)}
          onBlur={onCommitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancelRename();
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[calc(13px*var(--zone-font-scale,1))] font-semibold shadow-none outline-none focus-visible:border-0 focus-visible:bg-transparent"
          autoFocus
        />
      </div>
    );
  }

  return (
    <div className="group/project-group flex h-[30px] items-center rounded-lg pl-1 pr-0.5 transition-colors hover:bg-foreground/[0.04]">
      <button
        type="button"
        className="flex h-[30px] min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left outline-hidden transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onToggleCollapsed}
        title={t("chat.workspaceGroupToggle")}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            group.collapsed ? "" : "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[calc(13px*var(--zone-font-scale,1))] font-semibold leading-5">
          {group.name}
        </span>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
          {memberCount}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            />
          }
          aria-label={t("chat.workspaceGroupActions")}
          title={t("chat.workspaceGroupActions")}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-40">
          <DropdownMenuItem onSelect={onStartRename} className="gap-2 text-xs">
            <Edit3 className="h-3.5 w-3.5" />
            <span>{t("chat.workspaceGroupRename")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onDelete}
            className="gap-2 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t("chat.workspaceGroupDelete")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export const ProjectRow = memo(function ProjectRow(props: {
  project: WorkspaceProject;
  isActive: boolean;
  isMissing: boolean;
  isRunning: boolean;
  pendingAction: PendingWorkspaceProjectAction["mode"] | null;
  isInteractionDisabled: boolean;
  onSelectProject: (project: WorkspaceProject) => void;
  onBrowseProjectInFileTree?: (project: WorkspaceProject) => void;
  onConfigureProject: (project: WorkspaceProject) => void;
  onBrowseProjectInSystemFileManager?: (project: WorkspaceProject) => void;
  onSetProjectPinned: (project: WorkspaceProject, isPinned: boolean) => void;
  onRemoveProject: (project: WorkspaceProject, options?: WorkspaceProjectRemoveOptions) => void;
  // Archived rows render disabled: no selection (so no new conversations),
  // no pin — but rename/remove/browse stay available from the menu.
  isArchived: boolean;
  // Offered only while at least one other non-archived workspace remains.
  canArchive: boolean;
  onArchiveProject: (project: WorkspaceProject) => void;
  onUnarchiveProject: (project: WorkspaceProject) => void;
  onSetPendingAction: (action: PendingWorkspaceProjectAction | null) => void;
  // 分组内的项目行：相对组头缩进，形成层级视觉。
  indented?: boolean;
  // 分组归属：菜单中提供“移动到分组”子菜单。
  workspaceProjectGroups?: WorkspaceProjectGroup[];
  onMoveProjectToGroup?: (projectPath: string, groupId: string | null) => void;
  menuOpen: boolean;
  onMenuOpenChange: (projectId: string, open: boolean) => void;
  /**
   * Workbench pointer-drag intent from the project title (desktop only):
   * dragging a workspace into the pane canvas creates a new conversation for
   * it at the drop position. Never armed for archived or missing projects.
   */
  onWorkbenchDragIntent?: (
    project: WorkspaceProject,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
}) {
  const {
    project,
    isActive,
    isMissing,
    isRunning,
    pendingAction,
    isInteractionDisabled,
    onSelectProject,
    onBrowseProjectInFileTree,
    onConfigureProject,
    onBrowseProjectInSystemFileManager,
    onSetProjectPinned,
    onRemoveProject,
    isArchived,
    canArchive,
    onArchiveProject,
    onUnarchiveProject,
    onSetPendingAction,
    indented = false,
    workspaceProjectGroups = [],
    onMoveProjectToGroup,
    menuOpen,
    onMenuOpenChange,
    onWorkbenchDragIntent,
  } = props;
  const { t } = useLocale();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const isDefaultProject = project.id === DEFAULT_WORKSPACE_PROJECT_ID;
  const isPinned = project.isPinned === true;
  const [deleteBranchWithWorktree, setDeleteBranchWithWorktree] = useState(false);
  const currentGroupId = workspaceProjectGroups.find((group) =>
    group.projectPaths.some(
      (path) => workspaceProjectPathKey(path) === workspaceProjectPathKey(project.path),
    ),
  )?.id;
  const ProjectFolderIcon = isActive ? FolderOpen : FolderClosed;

  useEffect(() => {
    if (pendingAction !== "deleteWorktree") {
      setDeleteBranchWithWorktree(false);
    }
  }, [pendingAction]);

  const handleRequestRemove = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    onSetPendingAction({ projectId: project.id, mode: "remove" });
  }, [isInteractionDisabled, onSetPendingAction, project.id]);

  const handleRequestDeleteWorktree = useCallback(() => {
    if (isInteractionDisabled || !project.worktree) {
      return;
    }
    onSetPendingAction({ projectId: project.id, mode: "deleteWorktree" });
  }, [isInteractionDisabled, onSetPendingAction, project.id, project.worktree]);

  const handleConfirmPendingAction = useCallback(() => {
    const mode = pendingAction;
    onSetPendingAction(null);
    if (isInteractionDisabled || !mode) {
      return;
    }
    onRemoveProject(
      project,
      mode === "deleteWorktree"
        ? { deleteWorktree: true, deleteBranch: deleteBranchWithWorktree }
        : undefined,
    );
  }, [
    deleteBranchWithWorktree,
    isInteractionDisabled,
    onRemoveProject,
    onSetPendingAction,
    pendingAction,
    project,
  ]);

  const handleCancelPendingAction = useCallback(() => {
    onSetPendingAction(null);
  }, [onSetPendingAction]);

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

  const handleBrowseInSystemFileManager = useCallback(() => {
    if (isInteractionDisabled) {
      return;
    }
    onBrowseProjectInSystemFileManager?.(project);
  }, [isInteractionDisabled, onBrowseProjectInSystemFileManager, project]);

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

  if (pendingAction) {
    const deletingWorktree = pendingAction === "deleteWorktree" && Boolean(project.worktree);
    return (
      <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm text-destructive shadow-xs shadow-black/5">
        <p className="truncate font-medium leading-5 text-destructive">
          {t(
            deletingWorktree
              ? "chat.workspaceDeleteWorktreeConfirm"
              : "chat.workspaceRemoveConfirm",
          ).replace("{name}", project.name)}
        </p>
        <p className="mt-0.5 text-[calc(11px*var(--zone-font-scale,1))] leading-4 text-destructive/75">
          {isRunning
            ? t("chat.workspaceRemoveRunning")
            : t(
                deletingWorktree
                  ? "chat.workspaceDeleteWorktreeDescription"
                  : "chat.workspaceRemoveDescription",
              )}
        </p>
        {deletingWorktree ? (
          <>
            <p className="mt-1 break-all font-mono text-[10px] leading-4 text-destructive/70">
              {project.path}
            </p>
            {project.worktree?.branch ? (
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-[11px] leading-4 text-foreground">
                <input
                  type="checkbox"
                  checked={deleteBranchWithWorktree}
                  onChange={(event) => setDeleteBranchWithWorktree(event.currentTarget.checked)}
                  disabled={isInteractionDisabled || isRunning}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-destructive"
                />
                <span>
                  {t("chat.workspaceDeleteWorktreeBranch").replace(
                    "{branch}",
                    project.worktree.branch,
                  )}
                </span>
              </label>
            ) : null}
          </>
        ) : null}
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCancelPendingAction}
            disabled={isInteractionDisabled}
            className="h-7 rounded-xl border-border/60 bg-background text-xs font-normal text-muted-foreground hover:text-foreground"
          >
            {t("chat.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleConfirmPendingAction}
            disabled={isInteractionDisabled || isRunning}
            className="h-7 rounded-xl bg-destructive text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
          >
            {t(deletingWorktree ? "chat.workspaceDeleteWorktree" : "chat.remove")}
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
        indented && "pl-5",
        isMissing
          ? "text-destructive hover:bg-destructive/10"
          : isArchived
            ? "text-muted-foreground/60 hover:bg-foreground/[0.03]"
            : isActive
              ? "bg-foreground/[0.07] text-foreground hover:bg-foreground/[0.09]"
              : "text-foreground/85 hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      <Tooltip disabled={isInteractionDisabled}>
        <TooltipTrigger
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
              onPointerDown={(event) => {
                if (
                  !onWorkbenchDragIntent ||
                  isArchived ||
                  isMissing ||
                  isInteractionDisabled ||
                  menuOpen ||
                  pendingAction !== null ||
                  event.pointerType === "touch" ||
                  event.button !== 0
                ) {
                  return;
                }
                onWorkbenchDragIntent(project, {
                  pointerId: event.pointerId,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  currentTarget: event.currentTarget,
                });
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                if (!isInteractionDisabled) {
                  onConfigureProject(project);
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
        <TooltipContent
          anchor={rowRef}
          side="right"
          sideOffset={10}
          className="w-64 rounded-xl px-3 py-2.5"
        >
          <p className="truncate text-sm font-semibold leading-5">{project.name}</p>
          <p className="mt-1 break-all text-xs leading-4 text-muted-foreground">{project.path}</p>
        </TooltipContent>
      </Tooltip>
      <div
        className={cn(
          "relative flex items-center justify-end overflow-hidden transition-[max-width,opacity] duration-200 ease-out",
          isMissing
            ? "max-w-8 opacity-100"
            : isRunning || (isPinned && !isArchived)
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
            <Loader2 className="h-4 w-4 animate-spin [animation-duration:1.6s] motion-reduce:animate-none" />
          </span>
        ) : !isMissing && !isArchived && isPinned ? (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute right-1.5 flex h-4 w-4 items-center justify-center text-amber-500/80 transition-opacity duration-200",
              "opacity-100 group-hover/project:opacity-0 group-focus-within/project:opacity-0",
              menuOpen && "opacity-0",
            )}
          >
            <Pin className="h-3 w-3" />
          </span>
        ) : null}
        <div
          className={cn(
            "flex items-center gap-0.5 transition-opacity duration-200",
            (isRunning || (isPinned && !isArchived)) && !isMissing
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
                  {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
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
                  {/* 第一组：管理 —— 配置、分组归属、归档状态。 */}
                  <DropdownMenuItem
                    disabled={isInteractionDisabled}
                    onSelect={() => onConfigureProject(project)}
                    className="gap-2"
                  >
                    <Settings className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("chat.workspaceConfigure")}
                  </DropdownMenuItem>
                  {/* 无任何分组时隐藏“移动到分组”，避免展开空的子菜单。 */}
                  {onMoveProjectToGroup && workspaceProjectGroups.length > 0 ? (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger disabled={isInteractionDisabled} className="gap-2">
                        <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="min-w-0 flex-1">{t("chat.workspaceGroupMove")}</span>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        side="right"
                        align="start"
                        sideOffset={6}
                        className="min-w-40"
                      >
                        {workspaceProjectGroups.map((group) => (
                          <DropdownMenuItem
                            key={group.id}
                            disabled={group.id === currentGroupId}
                            onSelect={() => onMoveProjectToGroup(project.path, group.id)}
                            className="gap-2 text-xs"
                          >
                            {group.id === currentGroupId ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1 truncate">{group.name}</span>
                          </DropdownMenuItem>
                        ))}
                        {currentGroupId ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() => onMoveProjectToGroup(project.path, null)}
                              className="gap-2 text-xs"
                            >
                              <X className="h-3.5 w-3.5 text-muted-foreground" />
                              <span>{t("chat.workspaceGroupUngroup")}</span>
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : null}
                  {!isArchived && canArchive ? (
                    <DropdownMenuItem
                      disabled={isInteractionDisabled}
                      onSelect={handleArchive}
                      className="gap-2"
                    >
                      <Archive className="h-3.5 w-3.5 text-muted-foreground" />
                      {t("chat.workspaceArchive")}
                    </DropdownMenuItem>
                  ) : null}
                  {isArchived ? (
                    <DropdownMenuItem
                      disabled={isInteractionDisabled}
                      onSelect={handleUnarchive}
                      className="gap-2"
                    >
                      <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" />
                      {t("chat.workspaceUnarchive")}
                    </DropdownMenuItem>
                  ) : null}
                  {/* 第二组：浏览定位 —— 在文件树 / 系统资源管理器中打开。 */}
                  {onBrowseProjectInFileTree || onBrowseProjectInSystemFileManager ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {onBrowseProjectInFileTree ? (
                    <DropdownMenuItem
                      disabled={isInteractionDisabled}
                      onSelect={handleBrowseInFileTree}
                      className="gap-2"
                    >
                      <FolderTree className="h-3.5 w-3.5 text-muted-foreground" />
                      {t("chat.workspaceBrowseInFileTree")}
                    </DropdownMenuItem>
                  ) : null}
                  {onBrowseProjectInSystemFileManager ? (
                    <DropdownMenuItem
                      disabled={isInteractionDisabled}
                      onSelect={handleBrowseInSystemFileManager}
                      className="gap-2"
                    >
                      <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                      {t("chat.workspaceBrowseInSystemFileManager")}
                    </DropdownMenuItem>
                  ) : null}
                  {/* 第三组：危险操作 —— 固定在菜单底部并以分隔线隔开。 */}
                  {!isDefaultProject ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={isInteractionDisabled}
                        onSelect={handleRequestRemove}
                        className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />
                        {t("chat.workspaceRemoveOnly")}
                      </DropdownMenuItem>
                      {project.worktree ? (
                        <DropdownMenuItem
                          disabled={isInteractionDisabled}
                          onSelect={handleRequestDeleteWorktree}
                          className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("chat.workspaceDeleteWorktree")}
                        </DropdownMenuItem>
                      ) : null}
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
