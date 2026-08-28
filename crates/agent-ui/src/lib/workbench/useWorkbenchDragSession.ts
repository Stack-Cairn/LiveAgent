import { useCallback, useEffect, useRef, useState } from "react";
import {
  canvasAllowsPointerSplit,
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
  const sessionRef = useRef<DragSessionState>(IDLE_DRAG_SESSION);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const pointerCaptureRef = useRef<{ element: Element; pointerId: number } | null>(null);

  const cleanupListenersRef = useRef<(() => void) | null>(null);

  const teardown = useCallback(() => {
    sessionRef.current = IDLE_DRAG_SESSION;
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
    setDragState(null);
  }, []);

  useEffect(() => teardown, [teardown]);

  /** Run one machine event, publish the overlay model and fire any commit. */
  const dispatch = useCallback((event: DragSessionEvent) => {
    const result = dragSessionReducer(sessionRef.current, event);
    sessionRef.current = result.state;
    setDragState(dragStateFor(result.state));
    if (result.commit) onCommitRef.current(result.commit);
    return result;
  }, []);

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
        const session = sessionRef.current;
        if (session.phase === "idle" || moveEvent.pointerId !== session.pointerId) return;
        if (session.phase === "armed") {
          if (
            !exceedsDragThreshold(session.start, { x: moveEvent.clientX, y: moveEvent.clientY })
          ) {
            return;
          }
          const canvasElement = document.querySelector("[data-workbench-canvas]");
          const geometry = geometryRef.current;
          if (!canvasElement || !geometry) {
            onUnavailableRef.current?.("geometry-unavailable");
            teardown();
            return;
          }
          if (!canvasAllowsPointerSplit(geometry)) {
            onUnavailableRef.current?.("canvas-too-narrow");
            teardown();
            return;
          }
          const canvasRect = canvasElement.getBoundingClientRect();
          dispatch({
            type: "activate",
            pointerId: session.pointerId,
            canvasOrigin: { left: canvasRect.left, top: canvasRect.top },
            geometry,
            revision: layoutRef.current.revision,
          });
          armClickSuppressor();
          document.documentElement.style.setProperty("cursor", "grabbing");
        }
        // Once activated this is a workbench gesture, not text selection,
        // xterm input, or a menu interaction beneath the captured pointer.
        moveEvent.preventDefault();
        dispatch({
          type: "pointer-move",
          pointerId: moveEvent.pointerId,
          clientX: moveEvent.clientX,
          clientY: moveEvent.clientY,
          layout: layoutRef.current,
        });
      };

      const handleUp = (upEvent: PointerEvent) => {
        const session = sessionRef.current;
        if (session.phase === "idle" || upEvent.pointerId !== session.pointerId) return;
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
    [dispatch, enabled, geometryRef, layoutRef, teardown],
  );

  return { dragState, beginDrag };
}
