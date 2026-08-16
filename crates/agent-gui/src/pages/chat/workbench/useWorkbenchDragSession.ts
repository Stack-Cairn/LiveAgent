import { WORKBENCH_CANVAS_DIVIDER_SIZE as CANVAS_DIVIDER_SIZE } from "@liveagent/ui/components/workbench/WorkbenchCanvas";
import {
  hitTestWorkbenchDrop,
  MIN_CONVERSATION_PANE_HEIGHT,
  MIN_CONVERSATION_PANE_WIDTH,
  previewRectForDropTarget,
  type WorkbenchDropTarget,
  type WorkbenchEdge,
  type WorkbenchGeometry,
  type WorkbenchRect,
} from "@liveagent/ui/lib/workbench/index";
import {
  type ProjectRef,
  surfaceIdentityKey,
  type WorkbenchLayout,
} from "@liveagent/ui/lib/workbench/types";
import { useCallback, useEffect, useRef, useState } from "react";

const DRAG_THRESHOLD_PX = 6;
/** Pointer-splitting is disabled on very narrow canvases (doc §22). */
const MIN_CANVAS_WIDTH_FOR_POINTER_SPLIT = 440;

/** Both halves of a split must keep the conversation hard minimum size. */
export function canSplitRectAtEdge(rect: WorkbenchRect, edge: WorkbenchEdge): boolean {
  const divider = CANVAS_DIVIDER_SIZE;
  if (edge === "left" || edge === "right") {
    return (rect.width - divider) / 2 >= MIN_CONVERSATION_PANE_WIDTH;
  }
  return (rect.height - divider) / 2 >= MIN_CONVERSATION_PANE_HEIGHT;
}

export type WorkbenchDragPayload =
  | { kind: "conversation"; conversationId: string; project: ProjectRef; title: string }
  /** Moving an existing pane; surfaceKey is surfaceIdentityKey(pane.surface). */
  | { kind: "pane"; paneId: string; surfaceKey: string; title: string }
  /** Dragging a workspace creates a new conversation for it at the drop spot. */
  | { kind: "workspace"; projectId: string; projectPath: string; title: string }
  /** Dragging an existing terminal session (e.g. from the Right Dock) into a pane. */
  | { kind: "terminalSession"; sessionId: string; project: ProjectRef; title: string }
  /** Dragging a "new terminal" affordance creates a terminal at the drop spot. */
  | { kind: "newTerminal"; project: ProjectRef; title: string };

export type WorkbenchDropCommit = {
  payload: WorkbenchDragPayload;
  target: WorkbenchDropTarget;
  /** Layout revision frozen when the drag activated (CAS at commit time). */
  revision: number;
};

export type WorkbenchDragState = {
  payload: WorkbenchDragPayload;
  pointer: { x: number; y: number };
  target: WorkbenchDropTarget | null;
  previewRect: WorkbenchRect | null;
};

type PendingDrag = {
  payload: WorkbenchDragPayload;
  pointerId: number;
  startX: number;
  startY: number;
};

type ActiveDrag = PendingDrag & {
  canvasOrigin: { left: number; top: number };
  geometry: WorkbenchGeometry;
  revision: number;
};

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
 */
export function useWorkbenchDragSession(params: UseWorkbenchDragSessionParams) {
  const { enabled, layoutRef, geometryRef, onCommit } = params;
  const [dragState, setDragState] = useState<WorkbenchDragState | null>(null);
  const pendingRef = useRef<PendingDrag | null>(null);
  const activeRef = useRef<ActiveDrag | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const cleanupListenersRef = useRef<(() => void) | null>(null);

  const teardown = useCallback(() => {
    pendingRef.current = null;
    activeRef.current = null;
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    document.documentElement.style.removeProperty("cursor");
    setDragState(null);
  }, []);

  useEffect(() => teardown, [teardown]);

  /**
   * Normalize a raw hit-test target for the payload:
   * - own-pane hits become focus/no-op (pane-center on itself);
   * - sidebar payloads never overwrite a pane center — they auto-dock
   *   (bottom-first on narrow canvases, else right, then the other axis);
   * - every split target is rejected when either half would fall below the
   *   conversation hard minimum size, so drops with insufficient space show
   *   no preview and commit nothing.
   */
  const resolveTarget = useCallback(
    (
      raw: WorkbenchDropTarget | null,
      payload: WorkbenchDragPayload,
      geometry: WorkbenchGeometry,
    ): WorkbenchDropTarget | null => {
      if (!raw) return null;
      const layout = layoutRef.current;
      // terminalSession drags have no own pane here: the session→pane mapping
      // lives in the lease store, and a leased session is not draggable from
      // the sidebar in the first place.
      const ownPaneId =
        payload.kind === "pane"
          ? payload.paneId
          : payload.kind === "conversation"
            ? Object.values(layout.panes).find(
                (pane) =>
                  surfaceIdentityKey(pane.surface) === `conversation:${payload.conversationId}`,
              )?.paneId
            : undefined;

      const paneRect = (paneId: string): WorkbenchRect | null =>
        geometry.panes.find((pane) => pane.paneId === paneId)?.rect ?? null;

      if (raw.kind === "pane-center") {
        if (ownPaneId && raw.paneId === ownPaneId) {
          return { kind: "pane-center", paneId: ownPaneId };
        }
        // Sidebar payloads never overwrite a pane: deterministic auto-dock.
        if (payload.kind !== "pane") {
          const rect = paneRect(raw.paneId);
          if (!rect) return null;
          const preferVertical = geometry.canvas.width < 680;
          const edges: WorkbenchEdge[] = preferVertical ? ["bottom", "right"] : ["right", "bottom"];
          for (const edge of edges) {
            if (canSplitRectAtEdge(rect, edge)) {
              return { kind: "pane-edge", paneId: raw.paneId, edge };
            }
          }
          return null;
        }
        return raw;
      }
      if (raw.kind === "pane-edge") {
        if (ownPaneId && raw.paneId === ownPaneId) {
          return { kind: "pane-center", paneId: ownPaneId };
        }
        const rect = paneRect(raw.paneId);
        if (!rect || !canSplitRectAtEdge(rect, raw.edge)) return null;
        return raw;
      }
      if (raw.kind === "canvas-edge") {
        return canSplitRectAtEdge(geometry.canvas, raw.edge) ? raw : null;
      }
      if (raw.kind === "divider") {
        const divider = geometry.dividers.find((entry) => entry.splitId === raw.splitId);
        if (!divider) return null;
        // The inserted pane halves the region on the chosen side of the bar.
        const before = raw.edge === "left" || raw.edge === "top";
        const region: WorkbenchRect =
          divider.axis === "horizontal"
            ? before
              ? { ...divider.splitArea, width: divider.rect.left - divider.splitArea.left }
              : {
                  ...divider.splitArea,
                  left: divider.rect.left + divider.rect.width,
                  width:
                    divider.splitArea.left +
                    divider.splitArea.width -
                    (divider.rect.left + divider.rect.width),
                }
            : before
              ? { ...divider.splitArea, height: divider.rect.top - divider.splitArea.top }
              : {
                  ...divider.splitArea,
                  top: divider.rect.top + divider.rect.height,
                  height:
                    divider.splitArea.top +
                    divider.splitArea.height -
                    (divider.rect.top + divider.rect.height),
                };
        if (!canSplitRectAtEdge(region, divider.axis === "horizontal" ? "right" : "bottom")) {
          return null;
        }
        return raw;
      }
      if (raw.kind === "canvas-empty" && payload.kind === "pane") {
        return null;
      }
      return raw;
    },
    [layoutRef],
  );

  const beginDrag = useCallback(
    (
      payload: WorkbenchDragPayload,
      event: { pointerId: number; clientX: number; clientY: number },
    ) => {
      if (!enabled || pendingRef.current || activeRef.current) return;
      pendingRef.current = {
        payload,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };

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
        const pending = pendingRef.current;
        if (!pending || moveEvent.pointerId !== pending.pointerId) return;
        if (!activeRef.current) {
          const dx = moveEvent.clientX - pending.startX;
          const dy = moveEvent.clientY - pending.startY;
          if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
          const canvasElement = document.querySelector("[data-workbench-canvas]");
          const geometry = geometryRef.current;
          if (!canvasElement || !geometry) {
            teardown();
            return;
          }
          // Very narrow canvases disable pointer splitting entirely.
          if (geometry.canvas.width < MIN_CANVAS_WIDTH_FOR_POINTER_SPLIT) {
            teardown();
            return;
          }
          const canvasRect = canvasElement.getBoundingClientRect();
          activeRef.current = {
            ...pending,
            canvasOrigin: { left: canvasRect.left, top: canvasRect.top },
            geometry,
            revision: layoutRef.current.revision,
          };
          armClickSuppressor();
          document.documentElement.style.setProperty("cursor", "grabbing");
        }
        const active = activeRef.current;
        const localX = moveEvent.clientX - active.canvasOrigin.left;
        const localY = moveEvent.clientY - active.canvasOrigin.top;
        const target = resolveTarget(
          hitTestWorkbenchDrop(active.geometry, localX, localY),
          active.payload,
          active.geometry,
        );
        setDragState({
          payload: active.payload,
          pointer: { x: moveEvent.clientX, y: moveEvent.clientY },
          target,
          previewRect: target ? previewRectForDropTarget(active.geometry, target) : null,
        });
      };

      const handleUp = (upEvent: PointerEvent) => {
        const pending = pendingRef.current;
        if (!pending || upEvent.pointerId !== pending.pointerId) return;
        const active = activeRef.current;
        if (active) {
          const localX = upEvent.clientX - active.canvasOrigin.left;
          const localY = upEvent.clientY - active.canvasOrigin.top;
          const target = resolveTarget(
            hitTestWorkbenchDrop(active.geometry, localX, localY),
            active.payload,
            active.geometry,
          );
          if (target) {
            onCommitRef.current({
              payload: active.payload,
              target,
              revision: active.revision,
            });
          }
        }
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
    [enabled, geometryRef, layoutRef, resolveTarget, teardown],
  );

  return { dragState, beginDrag };
}
