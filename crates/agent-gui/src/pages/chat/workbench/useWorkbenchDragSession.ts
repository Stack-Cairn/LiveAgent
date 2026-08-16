import type { WorkbenchGeometry } from "@liveagent/ui/lib/workbench/index";
import type { WorkbenchLayout } from "@liveagent/ui/lib/workbench/types";
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
} from "./workbenchDragMachine";

export {
  canSplitRectAtEdge,
  type WorkbenchDragPayload,
  type WorkbenchDragState,
  type WorkbenchDropCommit,
} from "./workbenchDragMachine";

export type UseWorkbenchDragSessionParams = {
  enabled: boolean;
  layoutRef: React.MutableRefObject<WorkbenchLayout>;
  geometryRef: React.MutableRefObject<WorkbenchGeometry | null>;
  onCommit: (commit: WorkbenchDropCommit) => void;
};

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
  const { enabled, layoutRef, geometryRef, onCommit } = params;
  const [dragState, setDragState] = useState<WorkbenchDragState | null>(null);
  const sessionRef = useRef<DragSessionState>(IDLE_DRAG_SESSION);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const cleanupListenersRef = useRef<(() => void) | null>(null);

  const teardown = useCallback(() => {
    sessionRef.current = IDLE_DRAG_SESSION;
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
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
  }, []);

  const beginDrag = useCallback(
    (
      payload: WorkbenchDragPayload,
      event: { pointerId: number; clientX: number; clientY: number },
    ) => {
      if (!enabled || sessionRef.current.phase !== "idle") return;
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
            teardown();
            return;
          }
          if (!canvasAllowsPointerSplit(geometry)) {
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
        dispatch({
          type: "pointer-up",
          pointerId: upEvent.pointerId,
          clientX: upEvent.clientX,
          clientY: upEvent.clientY,
          layout: layoutRef.current,
        });
        teardown();
      };

      const handleCancel = () => teardown();
      const handleKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Escape") teardown();
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleCancel);
      window.addEventListener("blur", handleCancel);
      window.addEventListener("keydown", handleKeyDown, true);
      cleanupListenersRef.current = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
        window.removeEventListener("blur", handleCancel);
        window.removeEventListener("keydown", handleKeyDown, true);
      };
    },
    [dispatch, enabled, geometryRef, layoutRef, teardown],
  );

  return { dragState, beginDrag };
}
