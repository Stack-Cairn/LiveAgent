import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/shared/utils";
import { GripVertical } from "../icons";
import {
  applyTabDragInsertIndex,
  clampTabDragOffset,
  computeTabAutoScrollVelocity,
  computeTabDragInsertIndex,
  computeTabShiftOffsets,
  type RightDockTabSlot,
  reorderTabIdsByKeyboard,
  sameStringArray,
} from "./rightDockModel";

// Pointer travel before a press turns into a drag; below this it stays a click.
const TAB_DRAG_START_DISTANCE_PX = 5;
const TAB_DRAG_TRANSITION = "transform 180ms cubic-bezier(0.2, 0, 0, 1)";
const TAB_DROP_SETTLE_MS = 220;
const TAB_DEFAULT_GAP_PX = 4;
// Wildcard for "suppress the next tab click wherever it lands": after a real
// drag the browser may target the click at whichever tab sits under the
// pointer, not necessarily the dragged one.
const SUPPRESS_ANY_TAB_CLICK = "*";

type TabDragState = {
  pointerId: number;
  draggedId: string;
  startClientX: number;
  startClientY: number;
  latestClientX: number;
  startScrollLeft: number;
  hasMoved: boolean;
  // Frozen at the drag-start threshold; all drag math runs against this
  // snapshot while the DOM order stays untouched for the whole gesture.
  slots: RightDockTabSlot[];
  gap: number;
  baseOrder: string[];
  insertIndex: number;
  draggedOffset: number;
  previousUserSelect: string;
};

type TabDragVisual = {
  draggedId: string;
  draggedOffset: number;
  shifts: Record<string, number>;
};

// Two-phase FLIP: render the dropped tab translated back to where the pointer
// released it, then transition to 0 so it glides into its final slot.
type TabDropAnimation = {
  tabId: string;
  offset: number;
  settling: boolean;
};

type PendingDropFlip = {
  tabId: string;
  fromLeft: number;
};

export type RightDockTabDragProps = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
};

type UseRightDockTabReorderOptions = {
  canReorderTabs: boolean;
  orderedTabIds: string[];
  projectPathKey: string;
  reorderLabel: string;
  reorderHint: string;
  onDraftTabOrderChange: (nextOrder: string[] | null) => void;
  onCommitTabOrder: (nextOrder: string[]) => void;
};

function measureTabSlots(container: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const slots: RightDockTabSlot[] = [];
  for (const element of Array.from(
    container.querySelectorAll<HTMLElement>("[data-project-tools-tab-id]"),
  )) {
    const id = element.dataset.projectToolsTabId ?? "";
    if (!id) continue;
    const rect = element.getBoundingClientRect();
    slots.push({
      id,
      left: rect.left - containerRect.left + container.scrollLeft,
      width: rect.width,
    });
  }
  const first = slots[0];
  const second = slots[1];
  const gap =
    first && second ? Math.max(0, second.left - (first.left + first.width)) : TAB_DEFAULT_GAP_PX;
  return { slots, gap };
}

function findTabElement(container: HTMLElement | null, tabId: string) {
  if (!container) return null;
  return container.querySelector<HTMLElement>(`[data-project-tools-tab-id="${CSS.escape(tabId)}"]`);
}

export function useRightDockTabReorder(options: UseRightDockTabReorderOptions) {
  const { projectPathKey, reorderLabel, reorderHint, onDraftTabOrderChange } = options;
  const tabsScrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<TabDragState | null>(null);
  const frameRef = useRef(0);
  const suppressedTabClickRef = useRef("");
  const suppressResetTimeoutRef = useRef(0);
  const [draggingTabId, setDraggingTabId] = useState("");
  const [dragVisual, setDragVisual] = useState<TabDragVisual | null>(null);
  const [dropAnimation, setDropAnimation] = useState<TabDropAnimation | null>(null);
  const [pendingDropFlip, setPendingDropFlip] = useState<PendingDropFlip | null>(null);

  // Latest-value ref so the stable window-level listeners and pointer-down
  // handlers never close over stale options.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  const endTabDragRef = useRef<(commit: boolean) => void>(() => {});

  const suppressNextTabClick = useCallback((tabId: string) => {
    suppressedTabClickRef.current = tabId;
    window.clearTimeout(suppressResetTimeoutRef.current);
    // The post-drag click (if any) dispatches synchronously after pointerup,
    // before timers run; anything later is a genuine click and must not be
    // swallowed by stale suppression.
    suppressResetTimeoutRef.current = window.setTimeout(() => {
      suppressedTabClickRef.current = "";
    }, 0);
  }, []);

  const consumeSuppressedTabClick = useCallback((tabId: string) => {
    const suppressed = suppressedTabClickRef.current;
    if (suppressed !== SUPPRESS_ANY_TAB_CLICK && suppressed !== tabId) return false;
    suppressedTabClickRef.current = "";
    return true;
  }, []);

  const stopDragFrameLoop = useCallback(() => {
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
  }, []);

  const runDragFrame = useCallback(() => {
    frameRef.current = 0;
    const drag = dragRef.current;
    const container = tabsScrollRef.current;
    if (!drag?.hasMoved || !container) return;

    const rect = container.getBoundingClientRect();
    const velocity = computeTabAutoScrollVelocity(rect.left, rect.right, drag.latestClientX);
    if (velocity !== 0) {
      const maxScrollLeft = container.scrollWidth - container.clientWidth;
      container.scrollLeft = Math.min(maxScrollLeft, Math.max(0, container.scrollLeft + velocity));
    }

    const dragged = drag.slots.find((slot) => slot.id === drag.draggedId);
    if (dragged) {
      const pointerDelta = drag.latestClientX - drag.startClientX;
      const scrollDelta = container.scrollLeft - drag.startScrollLeft;
      const offset = clampTabDragOffset(drag.slots, drag.draggedId, pointerDelta + scrollDelta);
      const insertIndex = computeTabDragInsertIndex(drag.slots, drag.draggedId, offset);
      if (offset !== drag.draggedOffset || insertIndex !== drag.insertIndex) {
        drag.draggedOffset = offset;
        drag.insertIndex = insertIndex;
        setDragVisual({
          draggedId: drag.draggedId,
          draggedOffset: offset,
          shifts: computeTabShiftOffsets(drag.slots, drag.draggedId, insertIndex, drag.gap),
        });
      }
    }

    frameRef.current = window.requestAnimationFrame(runDragFrame);
  }, []);

  // Window listeners live from pointerdown to drag end. They are stable
  // (created once) and reach the current drag state through refs.
  const handleWindowPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.latestClientX = event.clientX;

      if (!drag.hasMoved) {
        const distance = Math.hypot(
          event.clientX - drag.startClientX,
          event.clientY - drag.startClientY,
        );
        if (distance < TAB_DRAG_START_DISTANCE_PX) return;
        const container = tabsScrollRef.current;
        const measured = container ? measureTabSlots(container) : null;
        if (!container || !measured?.slots.some((slot) => slot.id === drag.draggedId)) {
          endTabDragRef.current(false);
          return;
        }
        drag.slots = measured.slots;
        drag.gap = measured.gap;
        drag.startScrollLeft = container.scrollLeft;
        drag.hasMoved = true;
        drag.previousUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        setDraggingTabId(drag.draggedId);
      }

      if (event.cancelable) event.preventDefault();
      if (!frameRef.current) {
        frameRef.current = window.requestAnimationFrame(runDragFrame);
      }
    },
    [runDragFrame],
  );

  const handleWindowPointerUp = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.latestClientX = event.clientX;
    endTabDragRef.current(true);
  }, []);

  const handleWindowPointerCancel = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    endTabDragRef.current(false);
  }, []);

  const handleWindowKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Escape" || !dragRef.current) return;
    event.stopPropagation();
    endTabDragRef.current(false);
  }, []);

  const removeWindowDragListeners = useCallback(() => {
    window.removeEventListener("pointermove", handleWindowPointerMove);
    window.removeEventListener("pointerup", handleWindowPointerUp);
    window.removeEventListener("pointercancel", handleWindowPointerCancel);
    window.removeEventListener("keydown", handleWindowKeyDown, true);
  }, [
    handleWindowKeyDown,
    handleWindowPointerCancel,
    handleWindowPointerMove,
    handleWindowPointerUp,
  ]);

  const addWindowDragListeners = useCallback(() => {
    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    window.addEventListener("keydown", handleWindowKeyDown, true);
  }, [
    handleWindowKeyDown,
    handleWindowPointerCancel,
    handleWindowPointerMove,
    handleWindowPointerUp,
  ]);

  const endTabDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      stopDragFrameLoop();
      removeWindowDragListeners();
      if (!drag.hasMoved) return;

      document.body.style.userSelect = drag.previousUserSelect;
      setDraggingTabId("");
      setDragVisual(null);
      suppressNextTabClick(SUPPRESS_ANY_TAB_CLICK);

      const dragged = drag.slots.find((slot) => slot.id === drag.draggedId);
      if (dragged) {
        // FLIP anchor: the tab's visual position at release, in content coords.
        setPendingDropFlip({
          tabId: drag.draggedId,
          fromLeft: dragged.left + drag.draggedOffset,
        });
      }

      if (!commit) return;
      const nextOrder = applyTabDragInsertIndex(drag.baseOrder, drag.draggedId, drag.insertIndex);
      if (!sameStringArray(nextOrder, drag.baseOrder)) {
        optionsRef.current.onDraftTabOrderChange(nextOrder);
        optionsRef.current.onCommitTabOrder(nextOrder);
      }
    },
    [removeWindowDragListeners, stopDragFrameLoop, suppressNextTabClick],
  );
  useEffect(() => {
    endTabDragRef.current = endTabDrag;
  }, [endTabDrag]);

  const beginTabDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, tabId: string, source: "handle" | "tab") => {
      const { canReorderTabs, orderedTabIds } = optionsRef.current;
      if (!canReorderTabs || orderedTabIds.length < 2) return;
      if (event.button !== 0 || dragRef.current) return;
      // Touch drags start from the grip only: the strip itself must keep
      // panning under a finger, while the grip opts out via touch-action.
      if (source === "tab" && event.pointerType === "touch") return;
      dragRef.current = {
        pointerId: event.pointerId,
        draggedId: tabId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        latestClientX: event.clientX,
        startScrollLeft: 0,
        hasMoved: false,
        slots: [],
        gap: TAB_DEFAULT_GAP_PX,
        baseOrder: orderedTabIds,
        insertIndex: -1,
        draggedOffset: 0,
        previousUserSelect: "",
      };
      addWindowDragListeners();
    },
    [addWindowDragListeners],
  );

  useEffect(() => {
    return () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.hasMoved) {
        document.body.style.userSelect = drag.previousUserSelect;
      }
      window.clearTimeout(suppressResetTimeoutRef.current);
      stopDragFrameLoop();
      removeWindowDragListeners();
    };
  }, [removeWindowDragListeners, stopDragFrameLoop]);

  // The visible tab set changed under a live drag (a session died, another
  // client reordered): the slot snapshot is stale, so abort without commit.
  useEffect(() => {
    const drag = dragRef.current;
    if (drag && !sameStringArray(drag.baseOrder, options.orderedTabIds)) {
      endTabDragRef.current(false);
    }
  }, [options.orderedTabIds]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectPathKey is the trigger — switching projects discards every bit of in-flight drag state.
  useEffect(() => {
    onDraftTabOrderChange(null);
    setDraggingTabId("");
    setDragVisual(null);
    setDropAnimation(null);
    setPendingDropFlip(null);
    dragRef.current = null;
    suppressedTabClickRef.current = "";
    stopDragFrameLoop();
    removeWindowDragListeners();
  }, [onDraftTabOrderChange, projectPathKey, removeWindowDragListeners, stopDragFrameLoop]);

  // Runs after the post-drop render: measure where the dropped tab landed and
  // start it translated back at its release position.
  useLayoutEffect(() => {
    if (!pendingDropFlip) return;
    setPendingDropFlip(null);
    const container = tabsScrollRef.current;
    const element = findTabElement(container, pendingDropFlip.tabId);
    if (!container || !element) return;
    const containerRect = container.getBoundingClientRect();
    const newLeft =
      element.getBoundingClientRect().left - containerRect.left + container.scrollLeft;
    const offset = pendingDropFlip.fromLeft - newLeft;
    if (Math.abs(offset) < 1) return;
    setDropAnimation({ tabId: pendingDropFlip.tabId, offset, settling: false });
  }, [pendingDropFlip]);

  useEffect(() => {
    if (!dropAnimation) return;
    if (!dropAnimation.settling) {
      const frame = window.requestAnimationFrame(() => {
        setDropAnimation((current) =>
          current && !current.settling ? { ...current, offset: 0, settling: true } : current,
        );
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const timeout = window.setTimeout(() => setDropAnimation(null), TAB_DROP_SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, [dropAnimation]);

  const handleTabReorderKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, tabId: string) => {
      const { orderedTabIds, onCommitTabOrder } = optionsRef.current;
      if (orderedTabIds.length < 2) return;
      const nextOrder = reorderTabIdsByKeyboard(orderedTabIds, tabId, event.key);
      if (!nextOrder) return;

      event.preventDefault();
      event.stopPropagation();
      optionsRef.current.onDraftTabOrderChange(nextOrder);
      onCommitTabOrder(nextOrder);

      const tabElement = event.currentTarget.closest("[data-project-tools-tab-id]");
      if (tabElement instanceof HTMLElement) {
        window.requestAnimationFrame(() => {
          tabElement.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
      }
    },
    [],
  );

  const getTabDragProps = useCallback(
    (tabId: string): RightDockTabDragProps => ({
      onPointerDown: (event) => beginTabDrag(event, tabId, "tab"),
    }),
    [beginTabDrag],
  );

  const getTabDragStyle = useCallback(
    (tabId: string): CSSProperties | undefined => {
      if (dragVisual) {
        if (tabId === dragVisual.draggedId) {
          return {
            transform: `translateX(${dragVisual.draggedOffset}px)`,
            transition: "none",
            willChange: "transform",
          };
        }
        // Non-dragged tabs always carry the transition so a shift returning
        // to 0 slides back instead of snapping.
        return {
          transform: `translateX(${dragVisual.shifts[tabId] ?? 0}px)`,
          transition: TAB_DRAG_TRANSITION,
        };
      }
      if (dropAnimation && dropAnimation.tabId === tabId) {
        return {
          transform: `translateX(${dropAnimation.offset}px)`,
          transition: dropAnimation.settling ? TAB_DRAG_TRANSITION : "none",
          willChange: "transform",
        };
      }
      return undefined;
    },
    [dragVisual, dropAnimation],
  );

  const canReorderTabs = options.canReorderTabs;
  const renderTabDragHandle = useCallback(
    (tabId: string, label: string) => (
      <button
        type="button"
        data-project-tools-tab-action="drag"
        aria-label={`${reorderLabel} ${label}`}
        title={reorderHint}
        disabled={!canReorderTabs}
        tabIndex={canReorderTabs ? 0 : -1}
        className={cn(
          "relative z-10 flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/45 opacity-70 transition-[background-color,color,opacity] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          canReorderTabs
            ? "cursor-grab touch-none hover:bg-background/80 hover:text-foreground hover:opacity-100 focus-visible:bg-background focus-visible:text-foreground focus-visible:opacity-100 active:cursor-grabbing"
            : "cursor-default opacity-30",
        )}
        onClick={() => {
          consumeSuppressedTabClick(tabId);
        }}
        onKeyDown={(event) => handleTabReorderKeyDown(event, tabId)}
        onPointerDown={(event) => {
          event.stopPropagation();
          beginTabDrag(event, tabId, "handle");
        }}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
    ),
    [
      beginTabDrag,
      canReorderTabs,
      consumeSuppressedTabClick,
      handleTabReorderKeyDown,
      reorderHint,
      reorderLabel,
    ],
  );

  return useMemo(
    () => ({
      consumeSuppressedTabClick,
      draggingTabId,
      getTabDragProps,
      getTabDragStyle,
      renderTabDragHandle,
      tabsScrollRef,
    }),
    [
      consumeSuppressedTabClick,
      draggingTabId,
      getTabDragProps,
      getTabDragStyle,
      renderTabDragHandle,
    ],
  );
}
