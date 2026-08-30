import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConversationReferenceDropZoneHit,
  findConversationReferenceDropZone,
} from "../chat/conversationReferenceDrag";
import {
  canvasAllowsPointerSplit,
  conversationReferenceForWorkbenchPayload,
  type DragSessionEvent,
  type DragSessionState,
  dragSessionReducer,
  dragStateFor,
  exceedsDragThreshold,
  IDLE_DRAG_SESSION,
  type WorkbenchDragPayload,
  type WorkbenchDragState,
  type WorkbenchDropCommit,
} from "./dragMachine";
import { installWorkbenchDragWindowListeners } from "./dragWindowListeners";
import type { WorkbenchGeometry } from "./index";
import type { WorkbenchLayout } from "./types";

export {
  canSplitRectAtEdge,
  type WorkbenchDragPayload,
  type WorkbenchDragState,
  type WorkbenchDropCommit,
} from "./dragMachine";

export type WorkbenchDragPointerEvent = {
  pointerId: number;
  clientX: number;
  clientY: number;
  /**
   * The element that received pointer-down. Capturing on it keeps move/up
   * events flowing while the pointer crosses xterm canvases, contenteditable
   * composers, and the dock/canvas boundary.
   */
  currentTarget?: EventTarget | null;
};

export type UseWorkbenchDragSessionParams = {
  enabled: boolean;
  layoutRef: React.MutableRefObject<WorkbenchLayout>;
  geometryRef: React.MutableRefObject<WorkbenchGeometry | null>;
  onCommit: (commit: WorkbenchDropCommit) => void;
  onUnavailable?: (reason: WorkbenchDragUnavailableReason) => void;
};

export type WorkbenchDragUnavailableReason =
  | "geometry-unavailable"
  | "canvas-too-narrow"
  | "no-valid-target";

/**
 * Pointer-driven drag session shared by sidebar conversation drags and pane
 * chrome drags. Arms on pointer-down, activates after a 6px threshold with a
 * frozen geometry + revision snapshot, previews the drop target on move, and
 * commits exactly once on pointer-up. Esc, pointer-cancel and window blur
 * cancel without layout changes; clicks are suppressed once a drag activates.
 *
 * This hook is the DOM event adapter; the Idle→Armed→Dragging→Commit/Cancel
 * machine and the drop-target resolution live in ./workbenchDragMachine.
 */
export function useWorkbenchDragSession(params: UseWorkbenchDragSessionParams) {
  const { enabled, layoutRef, geometryRef, onCommit, onUnavailable } = params;
  const [dragState, setDragState] = useState<WorkbenchDragState | null>(null);
  const publishedDragStateRef = useRef<WorkbenchDragState | null>(null);
  const sessionRef = useRef<DragSessionState>(IDLE_DRAG_SESSION);
  const referenceDragActiveRef = useRef(false);
  const conversationDropZoneRef = useRef<ConversationReferenceDropZoneHit | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const pointerCaptureRef = useRef<{ element: Element; pointerId: number } | null>(null);
  const pendingMoveRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const dragGhostElementRef = useRef<HTMLDivElement | null>(null);

  const cleanupListenersRef = useRef<(() => void) | null>(null);

  const positionDragGhost = useCallback((clientX: number, clientY: number) => {
    const element = dragGhostElementRef.current;
    if (!element) return;
    element.style.setProperty("--workbench-drag-ghost-x", `${clientX + 14}px`);
    element.style.setProperty("--workbench-drag-ghost-y", `${clientY + 10}px`);
  }, []);

  const dragGhostRef = useCallback(
    (element: HTMLDivElement | null) => {
      dragGhostElementRef.current = element;
      const current = dragStateFor(sessionRef.current);
      if (element && current) positionDragGhost(current.pointer.x, current.pointer.y);
    },
    [positionDragGhost],
  );

  const clearConversationDropHover = useCallback(() => {
    const zone = conversationDropZoneRef.current;
    const session = sessionRef.current;
    const reference =
      session.phase === "idle" ? null : conversationReferenceForWorkbenchPayload(session.payload);
    if (zone && reference) {
      zone.onHover?.(reference, false);
    }
    conversationDropZoneRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    clearConversationDropHover();
    sessionRef.current = IDLE_DRAG_SESSION;
    referenceDragActiveRef.current = false;
    pendingMoveRef.current = null;
    if (moveFrameRef.current !== null) {
      window.cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
    }
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    const capture = pointerCaptureRef.current;
    pointerCaptureRef.current = null;
    if (capture) {
      try {
        if (capture.element.hasPointerCapture(capture.pointerId)) {
          capture.element.releasePointerCapture(capture.pointerId);
        }
      } catch {
        // The source node may unmount between pointer-up and paint (a dock
        // tab hidden by the drop's lease); capture dies with the element.
      }
    }
    document.documentElement.style.removeProperty("cursor");
    if (publishedDragStateRef.current !== null) {
      publishedDragStateRef.current = null;
      setDragState(null);
    }
  }, [clearConversationDropHover]);

  useEffect(() => teardown, [teardown]);

  const publishDragState = useCallback((nextDragState: WorkbenchDragState | null) => {
    if (dragRenderStateEqual(publishedDragStateRef.current, nextDragState)) return;
    publishedDragStateRef.current = nextDragState;
    setDragState(nextDragState);
  }, []);

  /** Run one machine event, publish the overlay model and fire any commit. */
  const dispatch = useCallback(
    (event: DragSessionEvent) => {
      const result = dragSessionReducer(sessionRef.current, event);
      sessionRef.current = result.state;
      publishDragState(dragStateFor(result.state));
      if (result.commit) onCommitRef.current(result.commit);
      return result;
    },
    [publishDragState],
  );

  const beginDrag = useCallback(
    (payload: WorkbenchDragPayload, event: WorkbenchDragPointerEvent) => {
      if (!enabled || sessionRef.current.phase !== "idle") return;
      const captureElement = event.currentTarget instanceof Element ? event.currentTarget : null;
      if (captureElement) {
        try {
          captureElement.setPointerCapture(event.pointerId);
          pointerCaptureRef.current = { element: captureElement, pointerId: event.pointerId };
        } catch {
          // Capture is best-effort: window listeners still see the gesture
          // when the host rejects setPointerCapture (inactive pointer, etc.).
        }
      }
      dispatch({
        type: "arm",
        payload,
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      });

      // Suppress the synthetic click that follows the drag's pointer-up so a
      // completed drag never doubles as a row/handle click. Disarms itself on
      // the first click it consumes or on the next fresh pointer-down.
      const disarmClickSuppressor = () => {
        window.removeEventListener("click", suppressClick, true);
        window.removeEventListener("pointerdown", disarmClickSuppressor, true);
      };
      const suppressClick = (clickEvent: MouseEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        disarmClickSuppressor();
      };
      const armClickSuppressor = () => {
        window.addEventListener("click", suppressClick, true);
        window.addEventListener("pointerdown", disarmClickSuppressor, true);
      };

      const handleMove = (moveEvent: PointerEvent) => {
        let session = sessionRef.current;
        if (session.phase === "idle" || moveEvent.pointerId !== session.pointerId) return;
        if (session.phase === "armed" && !referenceDragActiveRef.current) {
          if (
            !exceedsDragThreshold(session.start, { x: moveEvent.clientX, y: moveEvent.clientY })
          ) {
            return;
          }
          const reference = conversationReferenceForWorkbenchPayload(session.payload);
          referenceDragActiveRef.current = reference !== null;
          const canvasElement = document.querySelector("[data-workbench-canvas]");
          const geometry = geometryRef.current;
          if ((!canvasElement || !geometry) && !reference) {
            onUnavailableRef.current?.("geometry-unavailable");
            teardown();
            return;
          }
          if (geometry && !canvasAllowsPointerSplit(geometry) && !reference) {
            onUnavailableRef.current?.("canvas-too-narrow");
            teardown();
            return;
          }
          if (canvasElement && geometry && canvasAllowsPointerSplit(geometry)) {
            const canvasRect = canvasElement.getBoundingClientRect();
            dispatch({
              type: "activate",
              pointerId: session.pointerId,
              canvasOrigin: { left: canvasRect.left, top: canvasRect.top },
              geometry,
              revision: layoutRef.current.revision,
            });
          } else if (reference) {
            publishDragState({
              payload: session.payload,
              pointer: { x: moveEvent.clientX, y: moveEvent.clientY },
              target: null,
              previewRect: null,
            });
          }
          armClickSuppressor();
          document.documentElement.style.setProperty("cursor", "grabbing");
          session = sessionRef.current;
        }
        if (session.phase === "idle") return;
        const reference = conversationReferenceForWorkbenchPayload(session.payload);
        if (referenceDragActiveRef.current && reference) {
          const zone = findConversationReferenceDropZone(moveEvent.clientX, moveEvent.clientY);
          if (zone?.element !== conversationDropZoneRef.current?.element) {
            if (conversationDropZoneRef.current) {
              conversationDropZoneRef.current.onHover?.(reference, false);
            }
            conversationDropZoneRef.current = zone;
            if (zone) zone.onHover?.(reference, true);
          }
          // A Composer is a semantic target even while disabled. Never let a
          // self/duplicate/approval/text-mode rejection fall through to a Pane
          // split merely because insertion is unavailable at this moment.
          if (zone) {
            positionDragGhost(moveEvent.clientX, moveEvent.clientY);
            publishDragState({
              payload: session.payload,
              pointer: { x: moveEvent.clientX, y: moveEvent.clientY },
              target: null,
              previewRect: null,
            });
            return;
          }
        }
        if (session.phase !== "dragging") {
          positionDragGhost(moveEvent.clientX, moveEvent.clientY);
          publishDragState({
            payload: session.payload,
            pointer: { x: moveEvent.clientX, y: moveEvent.clientY },
            target: null,
            previewRect: null,
          });
          return;
        }
        // Once activated this is a workbench gesture, not text selection,
        // xterm input, or a menu interaction beneath the captured pointer.
        moveEvent.preventDefault();
        pendingMoveRef.current = {
          pointerId: moveEvent.pointerId,
          clientX: moveEvent.clientX,
          clientY: moveEvent.clientY,
        };
        if (moveFrameRef.current !== null) return;
        moveFrameRef.current = window.requestAnimationFrame(() => {
          moveFrameRef.current = null;
          const pending = pendingMoveRef.current;
          pendingMoveRef.current = null;
          const activeSession = sessionRef.current;
          if (
            !pending ||
            activeSession.phase !== "dragging" ||
            pending.pointerId !== activeSession.pointerId
          ) {
            return;
          }
          dispatch({
            type: "pointer-move",
            ...pending,
            layout: layoutRef.current,
          });
          positionDragGhost(pending.clientX, pending.clientY);
        });
      };

      const handleUp = (upEvent: PointerEvent) => {
        const session = sessionRef.current;
        if (session.phase === "idle" || upEvent.pointerId !== session.pointerId) return;
        pendingMoveRef.current = null;
        if (moveFrameRef.current !== null) {
          window.cancelAnimationFrame(moveFrameRef.current);
          moveFrameRef.current = null;
        }
        const reference = conversationReferenceForWorkbenchPayload(session.payload);
        if (referenceDragActiveRef.current && reference) {
          const zone = findConversationReferenceDropZone(upEvent.clientX, upEvent.clientY);
          if (zone) {
            upEvent.preventDefault();
            zone.onDrop(reference);
            teardown();
            return;
          }
        }
        if (session.phase !== "dragging") {
          teardown();
          return;
        }
        if (session.phase === "dragging") upEvent.preventDefault();
        const result = dispatch({
          type: "pointer-up",
          pointerId: upEvent.pointerId,
          clientX: upEvent.clientX,
          clientY: upEvent.clientY,
          layout: layoutRef.current,
        });
        if (session.phase === "dragging" && !result.commit) {
          const localX = upEvent.clientX - session.canvasOrigin.left;
          const localY = upEvent.clientY - session.canvasOrigin.top;
          const canvas = session.geometry.canvas;
          const insideCanvas =
            localX >= canvas.left &&
            localY >= canvas.top &&
            localX <= canvas.left + canvas.width &&
            localY <= canvas.top + canvas.height;
          if (insideCanvas) onUnavailableRef.current?.("no-valid-target");
        }
        teardown();
      };

      const handleCancel = () => teardown();
      const handleKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Escape") teardown();
      };

      cleanupListenersRef.current = installWorkbenchDragWindowListeners(window, {
        onPointerMove: handleMove,
        onPointerUp: handleUp,
        onPointerCancel: handleCancel,
        onBlur: handleCancel,
        onKeyDown: handleKeyDown,
      });
    },
    [dispatch, enabled, geometryRef, layoutRef, positionDragGhost, publishDragState, teardown],
  );

  return { dragState, beginDrag, dragGhostRef };
}

function dragRenderStateEqual(
  current: WorkbenchDragState | null,
  next: WorkbenchDragState | null,
): boolean {
  if (current === next) return true;
  if (!current || !next || current.payload !== next.payload) return false;
  const currentTarget = current.target;
  const nextTarget = next.target;
  if (currentTarget?.kind !== nextTarget?.kind) return false;
  if (currentTarget && nextTarget) {
    switch (currentTarget.kind) {
      case "canvas-empty":
        break;
      case "canvas-edge":
        if (nextTarget.kind !== "canvas-edge" || currentTarget.edge !== nextTarget.edge)
          return false;
        break;
      case "divider":
        if (
          nextTarget.kind !== "divider" ||
          currentTarget.splitId !== nextTarget.splitId ||
          currentTarget.edge !== nextTarget.edge
        ) {
          return false;
        }
        break;
      case "pane-edge":
        if (
          nextTarget.kind !== "pane-edge" ||
          currentTarget.paneId !== nextTarget.paneId ||
          currentTarget.edge !== nextTarget.edge
        ) {
          return false;
        }
        break;
      case "pane-center":
        if (nextTarget.kind !== "pane-center" || currentTarget.paneId !== nextTarget.paneId) {
          return false;
        }
        break;
    }
  }
  const currentRect = current.previewRect;
  const nextRect = next.previewRect;
  return (
    currentRect === nextRect ||
    Boolean(
      currentRect &&
        nextRect &&
        currentRect.left === nextRect.left &&
        currentRect.top === nextRect.top &&
        currentRect.width === nextRect.width &&
        currentRect.height === nextRect.height,
    )
  );
}
