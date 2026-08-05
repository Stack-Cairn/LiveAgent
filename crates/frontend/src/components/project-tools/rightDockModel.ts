import {
  applyDragInsertIndex,
  clampDragOffset,
  computeDragAutoScrollVelocity,
  computeDragInsertIndex,
  computeDragShiftOffsets,
  REORDER_AUTO_SCROLL_EDGE_PX,
  REORDER_AUTO_SCROLL_MAX_STEP_PX,
  reorderIdsByKeyboard,
} from "../../lib/reorder/reorderModel";
import {
  RIGHT_DOCK_SINGLETON_TAB_IDS,
  RIGHT_DOCK_TOOL_KINDS,
  type RightDockProjectState,
  type RightDockTabKind,
  type RightDockToolKind,
  rightDockToolKindForTabId,
  workspaceProjectPathKey,
} from "../../lib/settings";
import type { TerminalSession } from "../../lib/terminal/types";

export const MIN_RIGHT_DOCK_PANEL_WIDTH = 320;
export const DEFAULT_RIGHT_DOCK_MAX_PANEL_WIDTH = 720;
export const ABSOLUTE_RIGHT_DOCK_MAX_PANEL_WIDTH = 1280;
export const MIN_RIGHT_DOCK_MAIN_CONTENT_WIDTH = 420;
export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;
export const FILE_TREE_TAB_ID = RIGHT_DOCK_SINGLETON_TAB_IDS.fileTree;
export const GIT_REVIEW_TAB_ID = RIGHT_DOCK_SINGLETON_TAB_IDS.gitReview;
export const TUNNEL_TAB_ID = RIGHT_DOCK_SINGLETON_TAB_IDS.tunnel;
export const SSH_TUNNEL_TAB_ID = RIGHT_DOCK_SINGLETON_TAB_IDS.sshTunnel;
// Derived tab: exists while the managed-process store has records; never
// persisted into right-dock settings.
export const BACKGROUND_TASKS_TAB_ID = "background-tasks";
export const PROJECT_TOOLS_RESIZE_END_EVENT = "liveagent:project-tools-resize-end";

export type RightDockSingletonTabKind = RightDockToolKind;

export const RIGHT_DOCK_SINGLETON_TAB_KINDS: readonly RightDockSingletonTabKind[] =
  RIGHT_DOCK_TOOL_KINDS;

export type RightDockVisibleTab =
  | {
      id: string;
      kind: "terminal";
      session: TerminalSession;
    }
  | {
      id: string;
      kind: "backgroundTasks";
    }
  | {
      id: string;
      kind: RightDockSingletonTabKind;
    };

export function sortSessions(sessions: TerminalSession[]) {
  return [...sessions].sort((a, b) => a.createdAt - b.createdAt);
}

export function areSessionsEqual(left: TerminalSession[], right: TerminalSession[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function formatTerminalSessionTitle(title: string, terminalLabel: string) {
  const match = /^Terminal(?:\s+(\d+))?$/.exec(title.trim());
  if (!match) return title;
  return match[1] ? `${terminalLabel} ${match[1]}` : terminalLabel;
}

export function terminalSessionBelongsToProject(session: TerminalSession, projectPathKey: string) {
  const wantedProjectKey = workspaceProjectPathKey(projectPathKey);
  if (!wantedProjectKey) return false;
  const sessionProjectKey = workspaceProjectPathKey(session.projectPathKey || session.cwd);
  return sessionProjectKey === wantedProjectKey;
}

export function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

export function expandedPathsForFileTreePath(path: string) {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  return ["", ...dirs.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

export function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function orderRightDockVisibleTabs(
  tabs: RightDockVisibleTab[],
  tabOrder: readonly string[],
) {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const used = new Set<string>();
  const ordered: RightDockVisibleTab[] = [];
  for (const id of tabOrder) {
    const tab = byId.get(id);
    if (!tab || used.has(id)) continue;
    used.add(id);
    ordered.push(tab);
  }
  for (const tab of tabs) {
    if (used.has(tab.id)) continue;
    ordered.push(tab);
  }
  return ordered;
}

export function rightDockTabRequiresProject(kind: RightDockSingletonTabKind) {
  return kind !== "tunnel";
}

export function getRightDockVisibleTabs(options: {
  backgroundTasksVisible: boolean;
  localSessions: TerminalSession[];
  projectPathKey: string;
  projectState: RightDockProjectState;
  tunnelAvailable: boolean;
}) {
  const { backgroundTasksVisible, localSessions, projectPathKey, projectState, tunnelAvailable } =
    options;
  const nextTabs: RightDockVisibleTab[] = localSessions.map((session) => ({
    id: session.id,
    kind: "terminal",
    session,
  }));
  for (const kind of RIGHT_DOCK_SINGLETON_TAB_KINDS) {
    if (!projectState.tools[kind]) continue;
    if (kind === "tunnel" && !tunnelAvailable) continue;
    if (rightDockTabRequiresProject(kind) && !projectPathKey) continue;
    nextTabs.push({ id: rightDockSingletonTabId(kind), kind });
  }
  if (backgroundTasksVisible) {
    nextTabs.push({ id: BACKGROUND_TASKS_TAB_ID, kind: "backgroundTasks" });
  }
  return nextTabs;
}

// Render-time resolution of the persisted activeTabId. Never written back:
// a session id that is merely not loaded yet must not be "corrected", or the
// correction would race the session list and broadcast to other clients.
export function resolveEffectiveActiveTabId(
  activeTabId: string | undefined,
  orderedVisibleTabIds: readonly string[],
  sessionsLoaded: boolean,
): string | null {
  if (activeTabId && orderedVisibleTabIds.includes(activeTabId)) return activeTabId;
  if (
    activeTabId &&
    !sessionsLoaded &&
    activeTabId !== BACKGROUND_TASKS_TAB_ID &&
    !rightDockToolKindForTabId(activeTabId)
  ) {
    return null;
  }
  return orderedVisibleTabIds[0] ?? null;
}

export function getCurrentRightDockActiveTab(
  effectiveActiveTabId: string | null,
  visibleTabs: readonly RightDockVisibleTab[],
): RightDockTabKind {
  if (!effectiveActiveTabId) return "terminal";
  return visibleTabs.find((tab) => tab.id === effectiveActiveTabId)?.kind ?? "terminal";
}

// --- Tab drag engine ------------------------------------------------------
// All drag math runs against an immutable slot snapshot taken when the drag
// crosses the start threshold. The DOM order stays frozen for the whole
// gesture (tabs move via transform only), so these functions are monotonic in
// pointer position and can never oscillate the way live-DOM midpoint checks
// did when neighbouring tabs had different widths.

export type RightDockTabSlot = {
  id: string;
  // Content-coordinate left edge (independent of the strip's scrollLeft).
  left: number;
  width: number;
};

// Insertion index for the dragged tab among the remaining tabs, given the
// dragged tab's clamped drag offset. A neighbour is crossed when the dragged
// tab's LEADING edge passes that neighbour's frozen midpoint: the left edge
// going leftwards, the right edge going rightwards. Comparing the dragged
// CENTER against midpoints would leave the first/last slot unreachable
// whenever the dragged tab is wider than the edge tab, because
// clampTabDragOffset stops the dragged edges at the strip content bounds and
// the center then can't travel past the edge tab's midpoint.
export function computeTabDragInsertIndex(
  slots: readonly RightDockTabSlot[],
  draggedId: string,
  draggedOffset: number,
) {
  return computeDragInsertIndex(
    slots.map((slot) => ({ id: slot.id, start: slot.left, size: slot.width })),
    draggedId,
    draggedOffset,
  );
}

// Final id order produced by dropping the dragged tab at `insertIndex` among
// the remaining ids.
export function applyTabDragInsertIndex(
  order: readonly string[],
  draggedId: string,
  insertIndex: number,
) {
  return applyDragInsertIndex(order, draggedId, insertIndex);
}

// translateX per non-dragged tab while the dragged tab hovers at
// `insertIndex`: tabs between the origin and the target slot slide by one
// dragged-tab width (plus gap) to open the drop gap.
export function computeTabShiftOffsets(
  slots: readonly RightDockTabSlot[],
  draggedId: string,
  insertIndex: number,
  gap: number,
) {
  return computeDragShiftOffsets(
    slots.map((slot) => ({ id: slot.id, start: slot.left, size: slot.width })),
    draggedId,
    insertIndex,
    gap,
  );
}

// Keeps the dragged tab inside the strip's content bounds.
export function clampTabDragOffset(
  slots: readonly RightDockTabSlot[],
  draggedId: string,
  offset: number,
) {
  return clampDragOffset(
    slots.map((slot) => ({ id: slot.id, start: slot.left, size: slot.width })),
    draggedId,
    offset,
  );
}

export const TAB_AUTO_SCROLL_EDGE_PX = REORDER_AUTO_SCROLL_EDGE_PX;
export const TAB_AUTO_SCROLL_MAX_STEP_PX = REORDER_AUTO_SCROLL_MAX_STEP_PX;

// Per-frame auto-scroll velocity while dragging: zero in the middle of the
// strip, ramping up with pointer depth into either edge zone so the scroll
// speed follows intent instead of stepping per pointermove event.
export function computeTabAutoScrollVelocity(
  containerLeft: number,
  containerRight: number,
  clientX: number,
) {
  return computeDragAutoScrollVelocity(containerLeft, containerRight, clientX);
}

export function reorderTabIdsByKeyboard(tabIds: readonly string[], tabId: string, key: string) {
  return reorderIdsByKeyboard(tabIds, tabId, key, "horizontal");
}

export function rightDockSingletonTabId(kind: RightDockSingletonTabKind) {
  return RIGHT_DOCK_SINGLETON_TAB_IDS[kind];
}

// Choose the tab to activate after `closingTabId` disappears: nearest
// neighbour to the right, else to the left.
export function rightDockNeighborTabId(
  orderedVisibleTabIds: readonly string[],
  closingTabId: string,
): string | null {
  const remaining = orderedVisibleTabIds.filter((id) => id !== closingTabId);
  if (remaining.length === 0) return null;
  const index = orderedVisibleTabIds.indexOf(closingTabId);
  if (index < 0) return remaining[0] ?? null;
  return remaining[Math.min(index, remaining.length - 1)] ?? null;
}

export function closeRightDockToolTabState(
  state: RightDockProjectState,
  kind: RightDockSingletonTabKind,
  fallbackActiveTabId: string | null,
): RightDockProjectState {
  if (!state.tools[kind]) return state;
  const tabId = rightDockSingletonTabId(kind);
  const tools = { ...state.tools };
  delete tools[kind];
  const activeTabId =
    state.activeTabId === tabId ? (fallbackActiveTabId ?? undefined) : state.activeTabId;
  return {
    ...(activeTabId ? { activeTabId } : {}),
    tabOrder: state.tabOrder.filter((id) => id !== tabId),
    tools,
    openVersion: state.openVersion,
    stateVersion: state.stateVersion,
    writerId: state.writerId,
    lastUsedAt: state.lastUsedAt,
  };
}
