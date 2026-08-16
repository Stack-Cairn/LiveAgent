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

export const DRAG_THRESHOLD_PX = 6;
/** Pointer-splitting is disabled on very narrow canvases (doc §22). */
export const MIN_CANVAS_WIDTH_FOR_POINTER_SPLIT = 440;
/** Below this canvas width the sidebar auto-dock prefers the vertical axis. */
const NARROW_CANVAS_WIDTH_FOR_AUTO_DOCK = 680;

/** Both halves of a split must keep the conversation hard minimum size. */
export function canSplitRectAtEdge(rect: WorkbenchRect, edge: WorkbenchEdge): boolean {
  const divider = CANVAS_DIVIDER_SIZE;
  if (edge === "left" || edge === "right") {
    return (rect.width - divider) / 2 >= MIN_CONVERSATION_PANE_WIDTH;
  }
  return (rect.height - divider) / 2 >= MIN_CONVERSATION_PANE_HEIGHT;
}

/** A drag arms on pointer-down and only activates once it clears this radius. */
export function exceedsDragThreshold(
  start: { x: number; y: number },
  current: { x: number; y: number },
): boolean {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  return dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX;
}

/** Very narrow canvases disable pointer splitting entirely. */
export function canvasAllowsPointerSplit(geometry: WorkbenchGeometry): boolean {
  return geometry.canvas.width >= MIN_CANVAS_WIDTH_FOR_POINTER_SPLIT;
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

/**
 * The pane a payload already owns, if any. Dropping onto it is a focus/no-op
 * rather than a move. terminalSession drags have no own pane here: the
 * session→pane mapping lives in the lease store, and a leased session is not
 * draggable from the sidebar in the first place.
 */
function ownPaneIdForPayload(
  payload: WorkbenchDragPayload,
  layout: WorkbenchLayout,
): string | undefined {
  if (payload.kind === "pane") return payload.paneId;
  if (payload.kind !== "conversation") return undefined;
  return Object.values(layout.panes).find(
    (pane) => surfaceIdentityKey(pane.surface) === `conversation:${payload.conversationId}`,
  )?.paneId;
}

/**
 * The region a divider drop would halve: everything on the chosen side of the
 * bar, within the split area the divider belongs to.
 */
function dividerInsertionRegion(
  divider: WorkbenchGeometry["dividers"][number],
  edge: WorkbenchEdge,
): WorkbenchRect {
  const before = edge === "left" || edge === "top";
  if (divider.axis === "horizontal") {
    return before
      ? { ...divider.splitArea, width: divider.rect.left - divider.splitArea.left }
      : {
          ...divider.splitArea,
          left: divider.rect.left + divider.rect.width,
          width:
            divider.splitArea.left +
            divider.splitArea.width -
            (divider.rect.left + divider.rect.width),
        };
  }
  return before
    ? { ...divider.splitArea, height: divider.rect.top - divider.splitArea.top }
    : {
        ...divider.splitArea,
        top: divider.rect.top + divider.rect.height,
        height:
          divider.splitArea.top +
          divider.splitArea.height -
          (divider.rect.top + divider.rect.height),
      };
}

/**
 * Normalize a raw hit-test target for the payload:
 * - own-pane hits become focus/no-op (pane-center on itself);
 * - sidebar payloads never overwrite a pane center — they auto-dock
 *   (bottom-first on narrow canvases, else right, then the other axis);
 * - every split target is rejected when either half would fall below the
 *   conversation hard minimum size, so drops with insufficient space show
 *   no preview and commit nothing.
 */
export function resolveWorkbenchDropTarget(
  raw: WorkbenchDropTarget | null,
  payload: WorkbenchDragPayload,
  geometry: WorkbenchGeometry,
  layout: WorkbenchLayout,
): WorkbenchDropTarget | null {
  if (!raw) return null;
  const ownPaneId = ownPaneIdForPayload(payload, layout);
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
      const preferVertical = geometry.canvas.width < NARROW_CANVAS_WIDTH_FOR_AUTO_DOCK;
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
    const region = dividerInsertionRegion(divider, raw.edge);
    if (!canSplitRectAtEdge(region, divider.axis === "horizontal" ? "right" : "bottom")) {
      return null;
    }
    return raw;
  }
  if (raw.kind === "canvas-empty" && payload.kind === "pane") {
    return null;
  }
  return raw;
}

/** Canvas-relative snapshot frozen when a drag activates. */
export type DragActivation = {
  canvasOrigin: { left: number; top: number };
  geometry: WorkbenchGeometry;
  /** Layout revision at activation time; the commit is CAS-checked against it. */
  revision: number;
};

export type DragSessionState =
  | { phase: "idle" }
  | {
      phase: "armed";
      payload: WorkbenchDragPayload;
      pointerId: number;
      start: { x: number; y: number };
    }
  | ({
      phase: "dragging";
      payload: WorkbenchDragPayload;
      pointerId: number;
      start: { x: number; y: number };
      drag: WorkbenchDragState | null;
    } & DragActivation);

export type DragSessionEvent =
  | {
      type: "arm";
      payload: WorkbenchDragPayload;
      pointerId: number;
      clientX: number;
      clientY: number;
    }
  /** Emitted by the adapter once the threshold is cleared and a snapshot exists. */
  | ({ type: "activate"; pointerId: number } & DragActivation)
  | {
      type: "pointer-move";
      pointerId: number;
      clientX: number;
      clientY: number;
      layout: WorkbenchLayout;
    }
  | {
      type: "pointer-up";
      pointerId: number;
      clientX: number;
      clientY: number;
      layout: WorkbenchLayout;
    }
  /** Esc, pointer-cancel, window blur and teardown all land here. */
  | { type: "cancel" };

export type DragSessionResult = {
  state: DragSessionState;
  /** Set exactly once, on the pointer-up that resolves to a target. */
  commit: WorkbenchDropCommit | null;
};

export const IDLE_DRAG_SESSION: DragSessionState = { phase: "idle" };

/**
 * Pure Idle→Armed→Dragging→Commit/Cancel state machine behind the drag
 * session. Activation is an explicit event because the snapshot it freezes
 * (canvas origin, geometry, layout revision) can only be read from the DOM by
 * the hook adapter.
 */
export function dragSessionReducer(
  state: DragSessionState,
  event: DragSessionEvent,
): DragSessionResult {
  switch (event.type) {
    case "arm": {
      // A second pointer never preempts a live gesture.
      if (state.phase !== "idle") return { state, commit: null };
      return {
        state: {
          phase: "armed",
          payload: event.payload,
          pointerId: event.pointerId,
          start: { x: event.clientX, y: event.clientY },
        },
        commit: null,
      };
    }
    case "activate": {
      if (state.phase !== "armed" || state.pointerId !== event.pointerId) {
        return { state, commit: null };
      }
      return {
        state: {
          phase: "dragging",
          payload: state.payload,
          pointerId: state.pointerId,
          start: state.start,
          canvasOrigin: event.canvasOrigin,
          geometry: event.geometry,
          revision: event.revision,
          drag: null,
        },
        commit: null,
      };
    }
    case "pointer-move": {
      if (state.phase !== "dragging" || state.pointerId !== event.pointerId) {
        return { state, commit: null };
      }
      const target = resolveTargetAtPointer(state, event.clientX, event.clientY, event.layout);
      return {
        state: {
          ...state,
          drag: {
            payload: state.payload,
            pointer: { x: event.clientX, y: event.clientY },
            target,
            previewRect: target ? previewRectForDropTarget(state.geometry, target) : null,
          },
        },
        commit: null,
      };
    }
    case "pointer-up": {
      if (state.phase === "idle" || state.pointerId !== event.pointerId) {
        return { state, commit: null };
      }
      // Armed-but-never-activated gestures end as plain clicks.
      if (state.phase !== "dragging") return { state: IDLE_DRAG_SESSION, commit: null };
      const target = resolveTargetAtPointer(state, event.clientX, event.clientY, event.layout);
      return {
        state: IDLE_DRAG_SESSION,
        commit: target ? { payload: state.payload, target, revision: state.revision } : null,
      };
    }
    case "cancel":
      return { state: IDLE_DRAG_SESSION, commit: null };
  }
}

function resolveTargetAtPointer(
  state: Extract<DragSessionState, { phase: "dragging" }>,
  clientX: number,
  clientY: number,
  layout: WorkbenchLayout,
): WorkbenchDropTarget | null {
  const localX = clientX - state.canvasOrigin.left;
  const localY = clientY - state.canvasOrigin.top;
  return resolveWorkbenchDropTarget(
    hitTestWorkbenchDrop(state.geometry, localX, localY),
    state.payload,
    state.geometry,
    layout,
  );
}

/** The drag overlay model for a state, or null while idle/armed. */
export function dragStateFor(state: DragSessionState): WorkbenchDragState | null {
  return state.phase === "dragging" ? state.drag : null;
}
