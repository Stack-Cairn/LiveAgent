import type { RightDockProjectState } from "../settings/types";

/** The right dock's root element (terminals, file tree, git review, ...). */
export const RIGHT_DOCK_SELECTOR = '[data-app-frame-column="right-dock"]';

export function isFocusInRightDock(doc: Document | undefined = globalThis.document): boolean {
  const active = doc?.activeElement;
  return Boolean(
    active && typeof active.closest === "function" && active.closest(RIGHT_DOCK_SELECTOR),
  );
}

export type CloseContextTarget = "hub" | "dock" | "pane";

/**
 * "Close current view" closes the innermost closable surface of the
 * workbench, in this order:
 * 1. a resource hub covering the main area: back to the conversation;
 * 2. the right dock, when keyboard focus is inside it;
 * 3. the focused split pane, when the workbench has two or more panes;
 * 4. the right dock, when it is open.
 * It never closes the window, a conversation, the last pane or a dialog
 * (dialogs and settings close with Escape). Null when nothing qualifies.
 */
export function resolveCloseContextTarget(input: {
  activeView: string;
  paneCount: number;
  rightDockOpen: boolean;
  focusInDock: boolean;
}): CloseContextTarget | null {
  if (input.activeView !== "chat") return "hub";
  if (input.rightDockOpen && input.focusInDock) return "dock";
  if (input.paneCount >= 2) return "pane";
  if (input.rightDockOpen) return "dock";
  return null;
}

/**
 * "Toggle terminal": hides the dock when it shows a terminal; otherwise shows
 * the dock on the project's most recently used terminal (its last terminal
 * tab, else the newest session). With no terminal yet the dock opens on its
 * own launcher (`sessionId` undefined).
 */
export function resolveTerminalToggle(input: {
  open: boolean;
  activeTabId: string | undefined;
  tabOrder: readonly string[];
  sessions: readonly { id: string; createdAt?: number }[];
}): { kind: "close" } | { kind: "open"; sessionId?: string } {
  const ids = new Set(input.sessions.map((session) => session.id));
  if (input.open && input.activeTabId && ids.has(input.activeTabId)) return { kind: "close" };
  const fromTabs = [...input.tabOrder].reverse().find((id) => ids.has(id));
  const newest = [...input.sessions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  return { kind: "open", sessionId: fromTabs ?? newest?.id };
}

/** Makes a dock tab the active one (appending it to the tab order if needed). */
export function activateRightDockTab(
  current: RightDockProjectState,
  tabId: string,
): RightDockProjectState {
  if (current.activeTabId === tabId && current.tabOrder.includes(tabId)) return current;
  return {
    ...current,
    activeTabId: tabId,
    tabOrder: current.tabOrder.includes(tabId) ? current.tabOrder : [...current.tabOrder, tabId],
  };
}
