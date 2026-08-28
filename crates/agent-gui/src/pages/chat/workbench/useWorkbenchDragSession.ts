import {
  type ConversationReferenceDropZoneHit,
  findConversationReferenceDropZone,
} from "@liveagent/ui/lib/chat/conversationReferenceDrag";
import type { WorkbenchGeometry } from "@liveagent/ui/lib/workbench/index";
import type { WorkbenchLayout } from "@liveagent/ui/lib/workbench/types";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const referenceDragActiveRef = useRef(false);
  const conversationDropZoneRef = useRef<ConversationReferenceDropZoneHit | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const cleanupListenersRef = useRef<(() => void) | null>(null);

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
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    document.documentElement.style.removeProperty("cursor");
    setDragState(null);
  }, [clearConversationDropHover]);

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
            teardown();
            return;
          }
          if (geometry && !canvasAllowsPointerSplit(geometry) && !reference) {
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
            setDragState({
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
            setDragState({
              payload: session.payload,
              pointer: { x: moveEvent.clientX, y: moveEvent.clientY },
              target: null,
              previewRect: null,
            });
            return;
          }
        }
        if (session.phase !== "dragging") {
          setDragState({
            payload: session.payload,
            pointer: { x: moveEvent.clientX, y: moveEvent.clientY },
            target: null,
            previewRect: null,
          });
          return;
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
        const reference = conversationReferenceForWorkbenchPayload(session.payload);
        if (referenceDragActiveRef.current && reference) {
          const zone = findConversationReferenceDropZone(upEvent.clientX, upEvent.clientY);
          if (zone) {
            zone.onDrop(reference);
            teardown();
            return;
          }
        }
        if (session.phase !== "dragging") {
          teardown();
          return;
        }
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

      // Capture keeps the drag lifecycle alive when editors, overlays or pane
      // controls stop pointer events during an active Workbench gesture.
      window.addEventListener("pointermove", handleMove, true);
      window.addEventListener("pointerup", handleUp, true);
      window.addEventListener("pointercancel", handleCancel, true);
      window.addEventListener("blur", handleCancel);
      window.addEventListener("keydown", handleKeyDown, true);
      cleanupListenersRef.current = () => {
        window.removeEventListener("pointermove", handleMove, true);
        window.removeEventListener("pointerup", handleUp, true);
        window.removeEventListener("pointercancel", handleCancel, true);
        window.removeEventListener("blur", handleCancel);
        window.removeEventListener("keydown", handleKeyDown, true);
      };
    },
    [dispatch, enabled, geometryRef, layoutRef, teardown],
  );

  return { dragState, beginDrag };
}
