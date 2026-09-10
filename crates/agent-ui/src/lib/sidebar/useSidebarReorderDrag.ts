import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

export type SidebarReorderPosition = "before" | "after";
export type SidebarReorderPointer = {
  pointerId: number;
  clientX: number;
  clientY: number;
  currentTarget: HTMLElement;
};

/** Pointer sorting avoids WKWebView's native file-drop interception. */
export function useSidebarReorderDrag(params: {
  containerRef: RefObject<HTMLDivElement | null>;
  disabled: boolean;
  scopeKey: string;
  canDrop: (source: string, target: string) => boolean;
  onDrop: (source: string, target: string, position: SidebarReorderPosition) => void;
}) {
  const callbacksRef = useRef(params);
  callbacksRef.current = params;
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);
  const ghostElementRef = useRef<HTMLDivElement | null>(null);
  const ghostPositionRef = useRef({ x: 0, y: 0 });
  const positionGhost = useCallback((x: number, y: number) => {
    ghostPositionRef.current = { x, y };
    ghostElementRef.current?.style.setProperty("--sidebar-drag-x", `${x + 12}px`);
    ghostElementRef.current?.style.setProperty("--sidebar-drag-y", `${y - 34}px`);
  }, []);
  const ghostRef = useCallback(
    (element: HTMLDivElement | null) => {
      ghostElementRef.current = element;
      positionGhost(ghostPositionRef.current.x, ghostPositionRef.current.y);
    },
    [positionGhost],
  );
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    key: string;
    position: SidebarReorderPosition;
  } | null>(null);

  const cancel = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setDraggingKey(null);
    setDropTarget(null);
  }, []);

  // A changed scope invalidates the source and targets of the in-flight sort.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes must cancel the pointer session.
  useEffect(() => {
    cancel();
    return cancel;
  }, [cancel, params.disabled, params.scopeKey]);

  const onPointerDown = useCallback(
    (sourceKey: string, event: SidebarReorderPointer) => {
      if (callbacksRef.current.disabled) return;
      cancel();
      suppressClickRef.current = false;
      let active = false;
      let target: { key: string; position: SidebarReorderPosition } | null = null;
      const origin = event.currentTarget;
      const pointerId = event.pointerId;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      const updateTarget = (x: number, y: number) => {
        const container = callbacksRef.current.containerRef.current;
        const element = document
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>("[data-sidebar-reorder-key]");
        const key = element?.dataset.sidebarReorderKey;
        if (
          !element ||
          !key ||
          !container?.contains(element) ||
          !callbacksRef.current.canDrop(sourceKey, key)
        ) {
          target = null;
        } else {
          const rect = element.getBoundingClientRect();
          target = { key, position: y < rect.top + rect.height / 2 ? "before" : "after" };
        }
        setDropTarget(target);
        if (container) {
          const rect = container.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            const delta = y < rect.top + 28 ? -14 : y > rect.bottom - 28 ? 14 : 0;
            if (delta) container.scrollBy({ top: delta });
          }
        }
      };
      const handleMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return;
        if (!active && Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) < 5)
          return;
        if (!active) {
          active = true;
          suppressClickRef.current = true;
          setDraggingKey(sourceKey);
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
          origin.setPointerCapture?.(pointerId);
        }
        move.preventDefault();
        positionGhost(move.clientX, move.clientY);
        updateTarget(move.clientX, move.clientY);
      };
      const handleUp = (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return;
        if (active) {
          up.preventDefault();
          updateTarget(up.clientX, up.clientY);
          if (target) callbacksRef.current.onDrop(sourceKey, target.key, target.position);
        }
        cancel();
      };
      const handleCancel = (event: PointerEvent) => {
        if (event.pointerId === pointerId) cancel();
      };
      const handleKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") cancel();
      };
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
        window.removeEventListener("blur", cancel);
        window.removeEventListener("keydown", handleKey);
        if (origin.hasPointerCapture?.(pointerId)) origin.releasePointerCapture(pointerId);
        if (active) {
          document.body.style.cursor = previousCursor;
          document.body.style.userSelect = previousUserSelect;
        }
      };
      window.addEventListener("pointermove", handleMove, { passive: false });
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleCancel);
      window.addEventListener("blur", cancel);
      window.addEventListener("keydown", handleKey);
    },
    [cancel, positionGhost],
  );

  return {
    ghostRef,
    draggingKey,
    dropTarget,
    onPointerDown,
    onPointerDownCapture: () => {
      if (!cleanupRef.current) suppressClickRef.current = false;
    },
    onClickCapture: (event: React.MouseEvent) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
