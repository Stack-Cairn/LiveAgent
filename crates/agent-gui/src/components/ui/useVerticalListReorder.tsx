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
import {
  applyDragInsertIndex,
  clampDragOffset,
  computeDragAutoScrollVelocity,
  computeDragInsertIndex,
  computeDragShiftOffsets,
  type ReorderSlot,
  reorderIdsByKeyboard,
} from "../../lib/reorder/reorderModel";
import { cn } from "../../lib/shared/utils";
import { GripVertical } from "../icons";

const DRAG_START_DISTANCE_PX = 5;
const TOUCH_LONG_PRESS_MS = 350;
const DRAG_TRANSITION = "transform 180ms cubic-bezier(0.2, 0, 0, 1)";
const DROP_SETTLE_MS = 220;

type DragState = {
  pointerId: number;
  pointerType: string;
  draggedId: string;
  startClientX: number;
  startClientY: number;
  latestClientY: number;
  startScrollTop: number;
  active: boolean;
  slots: ReorderSlot[];
  gap: number;
  baseOrder: string[];
  insertIndex: number;
  draggedOffset: number;
  previousUserSelect: string;
};

type DragVisual = {
  draggedId: string;
  draggedOffset: number;
  shifts: Record<string, number>;
};

type DropAnimation = {
  itemId: string;
  offset: number;
  settling: boolean;
};

type UseVerticalListReorderOptions = {
  itemIds: string[];
  canReorder: boolean;
  reorderLabel: string;
  reorderHint: string;
  disabledHint?: string;
  onReorder: (nextIds: string[]) => void;
};

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function measureSlots(container: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const slots: ReorderSlot[] = [];
  for (const element of Array.from(
    container.querySelectorAll<HTMLElement>("[data-vertical-reorder-id]"),
  )) {
    const id = element.dataset.verticalReorderId ?? "";
    if (!id) continue;
    const rect = element.getBoundingClientRect();
    slots.push({
      id,
      start: rect.top - containerRect.top + container.scrollTop,
      size: rect.height,
    });
  }
  const first = slots[0];
  const second = slots[1];
  const gap = first && second ? Math.max(0, second.start - (first.start + first.size)) : 0;
  return { slots, gap };
}

function findItemElement(container: HTMLElement | null, itemId: string) {
  if (!container) return null;
  return container.querySelector<HTMLElement>(`[data-vertical-reorder-id="${CSS.escape(itemId)}"]`);
}

export function useVerticalListReorder(options: UseVerticalListReorderOptions) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const frameRef = useRef(0);
  const longPressRef = useRef(0);
  const suppressClickRef = useRef(false);
  const [draggingItemId, setDraggingItemId] = useState("");
  const [dragVisual, setDragVisual] = useState<DragVisual | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ itemId: string; fromStart: number } | null>(
    null,
  );
  const [dropAnimation, setDropAnimation] = useState<DropAnimation | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  const endDragRef = useRef<(commit: boolean) => void>(() => {});

  const clearLongPress = useCallback(() => {
    window.clearTimeout(longPressRef.current);
    longPressRef.current = 0;
  }, []);

  const stopFrameLoop = useCallback(() => {
    if (!frameRef.current) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, []);

  const activateDrag = useCallback(() => {
    const drag = dragRef.current;
    const container = scrollContainerRef.current;
    if (!drag || drag.active || !container) return false;
    const measured = measureSlots(container);
    if (!measured.slots.some((slot) => slot.id === drag.draggedId)) return false;
    drag.slots = measured.slots;
    drag.gap = measured.gap;
    drag.startScrollTop = container.scrollTop;
    drag.active = true;
    drag.previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    setDraggingItemId(drag.draggedId);
    return true;
  }, []);

  const runDragFrame = useCallback(() => {
    frameRef.current = 0;
    const drag = dragRef.current;
    const container = scrollContainerRef.current;
    if (!drag?.active || !container) return;

    const rect = container.getBoundingClientRect();
    const velocity = computeDragAutoScrollVelocity(rect.top, rect.bottom, drag.latestClientY);
    if (velocity !== 0) {
      const maxScrollTop = container.scrollHeight - container.clientHeight;
      container.scrollTop = Math.min(maxScrollTop, Math.max(0, container.scrollTop + velocity));
    }

    const pointerDelta = drag.latestClientY - drag.startClientY;
    const scrollDelta = container.scrollTop - drag.startScrollTop;
    const offset = clampDragOffset(drag.slots, drag.draggedId, pointerDelta + scrollDelta);
    const insertIndex = computeDragInsertIndex(drag.slots, drag.draggedId, offset);
    if (offset !== drag.draggedOffset || insertIndex !== drag.insertIndex) {
      drag.draggedOffset = offset;
      drag.insertIndex = insertIndex;
      setDragVisual({
        draggedId: drag.draggedId,
        draggedOffset: offset,
        shifts: computeDragShiftOffsets(drag.slots, drag.draggedId, insertIndex, drag.gap),
      });
    }
    frameRef.current = window.requestAnimationFrame(runDragFrame);
  }, []);

  const handleWindowPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.latestClientY = event.clientY;

      if (!drag.active) {
        const distance = Math.hypot(
          event.clientX - drag.startClientX,
          event.clientY - drag.startClientY,
        );
        if (drag.pointerType === "touch") {
          if (distance >= DRAG_START_DISTANCE_PX) endDragRef.current(false);
          return;
        }
        if (distance < DRAG_START_DISTANCE_PX) return;
        if (!activateDrag()) {
          endDragRef.current(false);
          return;
        }
      }

      if (event.cancelable) event.preventDefault();
      if (!frameRef.current) frameRef.current = window.requestAnimationFrame(runDragFrame);
    },
    [activateDrag, runDragFrame],
  );

  const handleWindowPointerUp = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.latestClientY = event.clientY;
    endDragRef.current(true);
  }, []);

  const handleWindowPointerCancel = useCallback((event: PointerEvent) => {
    if (dragRef.current?.pointerId === event.pointerId) endDragRef.current(false);
  }, []);

  const handleWindowKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Escape" || !dragRef.current) return;
    event.stopPropagation();
    endDragRef.current(false);
  }, []);

  const removeWindowListeners = useCallback(() => {
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

  const addWindowListeners = useCallback(() => {
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

  const endDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      clearLongPress();
      stopFrameLoop();
      removeWindowListeners();
      if (!drag.active) return;

      document.body.style.userSelect = drag.previousUserSelect;
      setDraggingItemId("");
      setDragVisual(null);
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      const dragged = drag.slots.find((slot) => slot.id === drag.draggedId);
      if (dragged) {
        setPendingDrop({ itemId: drag.draggedId, fromStart: dragged.start + drag.draggedOffset });
      }
      if (!commit) return;
      const nextIds = applyDragInsertIndex(drag.baseOrder, drag.draggedId, drag.insertIndex);
      if (!sameIds(nextIds, drag.baseOrder)) optionsRef.current.onReorder(nextIds);
    },
    [clearLongPress, removeWindowListeners, stopFrameLoop],
  );
  useEffect(() => {
    endDragRef.current = endDrag;
  }, [endDrag]);

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, itemId: string) => {
      const { canReorder, itemIds } = optionsRef.current;
      if (!canReorder || itemIds.length < 2 || event.button !== 0 || dragRef.current) return;
      dragRef.current = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        draggedId: itemId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        latestClientY: event.clientY,
        startScrollTop: 0,
        active: false,
        slots: [],
        gap: 0,
        baseOrder: itemIds,
        insertIndex: itemIds.indexOf(itemId),
        draggedOffset: 0,
        previousUserSelect: "",
      };
      addWindowListeners();
      if (event.pointerType === "touch") {
        longPressRef.current = window.setTimeout(() => {
          if (activateDrag() && !frameRef.current) {
            frameRef.current = window.requestAnimationFrame(runDragFrame);
          }
        }, TOUCH_LONG_PRESS_MS);
      }
    },
    [activateDrag, addWindowListeners, runDragFrame],
  );

  useEffect(() => {
    return () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.active) document.body.style.userSelect = drag.previousUserSelect;
      clearLongPress();
      stopFrameLoop();
      removeWindowListeners();
    };
  }, [clearLongPress, removeWindowListeners, stopFrameLoop]);

  useEffect(() => {
    const drag = dragRef.current;
    if (drag && !sameIds(drag.baseOrder, options.itemIds)) endDragRef.current(false);
  }, [options.itemIds]);

  useLayoutEffect(() => {
    if (!pendingDrop) return;
    setPendingDrop(null);
    const container = scrollContainerRef.current;
    const element = findItemElement(container, pendingDrop.itemId);
    if (!container || !element) return;
    const containerRect = container.getBoundingClientRect();
    const newStart = element.getBoundingClientRect().top - containerRect.top + container.scrollTop;
    const offset = pendingDrop.fromStart - newStart;
    if (Math.abs(offset) >= 1) {
      setDropAnimation({ itemId: pendingDrop.itemId, offset, settling: false });
    }
  }, [pendingDrop]);

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
    const timeout = window.setTimeout(() => setDropAnimation(null), DROP_SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, [dropAnimation]);

  const handleReorderKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, itemId: string) => {
      const { canReorder, itemIds, onReorder } = optionsRef.current;
      if (!canReorder || itemIds.length < 2) return;
      const nextIds = reorderIdsByKeyboard(itemIds, itemId, event.key, "vertical");
      if (!nextIds) return;
      event.preventDefault();
      event.stopPropagation();
      onReorder(nextIds);
      window.requestAnimationFrame(() => {
        findItemElement(scrollContainerRef.current, itemId)?.scrollIntoView({ block: "nearest" });
      });
    },
    [],
  );

  const getItemProps = useCallback(
    (itemId: string): { "data-vertical-reorder-id": string; style?: CSSProperties } => {
      let style: CSSProperties | undefined;
      if (dragVisual) {
        style =
          itemId === dragVisual.draggedId
            ? {
                transform: `translateY(${dragVisual.draggedOffset}px)`,
                transition: "none",
                willChange: "transform",
                position: "relative",
                zIndex: 20,
              }
            : {
                transform: `translateY(${dragVisual.shifts[itemId] ?? 0}px)`,
                transition: DRAG_TRANSITION,
              };
      } else if (dropAnimation?.itemId === itemId) {
        style = {
          transform: `translateY(${dropAnimation.offset}px)`,
          transition: dropAnimation.settling ? DRAG_TRANSITION : "none",
          willChange: "transform",
        };
      }
      return { "data-vertical-reorder-id": itemId, style };
    },
    [dragVisual, dropAnimation],
  );

  const enabled = options.canReorder && options.itemIds.length >= 2;
  const renderDragHandle = useCallback(
    (itemId: string, label: string) => (
      <button
        type="button"
        aria-label={`${options.reorderLabel} ${label}`}
        title={enabled ? options.reorderHint : options.disabledHint}
        aria-disabled={!enabled}
        tabIndex={enabled ? 0 : -1}
        className={cn(
          "flex h-8 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          enabled
            ? "cursor-grab touch-none hover:bg-muted hover:text-foreground active:cursor-grabbing"
            : "cursor-not-allowed opacity-30",
        )}
        onClick={(event) => {
          event.stopPropagation();
          if (suppressClickRef.current) event.preventDefault();
        }}
        onKeyDown={(event) => handleReorderKeyDown(event, itemId)}
        onPointerDown={(event) => {
          event.stopPropagation();
          beginDrag(event, itemId);
        }}
      >
        <GripVertical className="h-4 w-4" />
      </button>
    ),
    [
      beginDrag,
      enabled,
      handleReorderKeyDown,
      options.disabledHint,
      options.reorderHint,
      options.reorderLabel,
    ],
  );

  return useMemo(
    () => ({ draggingItemId, getItemProps, renderDragHandle, scrollContainerRef }),
    [draggingItemId, getItemProps, renderDragHandle],
  );
}
