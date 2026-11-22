import { useCallback, useEffect, useRef, useState } from "react";
import {
  SIDEBAR_SHORTCUTS,
  type SidebarShortcutId,
  type SidebarShortcuts,
} from "../settings/sidebarShortcuts";

// Clicks inside an open modal (shared Dialog/AlertDialog) never navigate.
const MODAL_ROLE_SELECTOR = ["dialog", "alertdialog"].map((role) => `[role="${role}"]`).join(", ");

/**
 * Back / forward history of what the main area shows (a conversation or a
 * full-page view such as a resource hub). Locations are opaque strings chosen
 * by the host, e.g. `conversation:<id>` or `view:skills-hub`.
 */
export type NavigationHistory = {
  readonly entries: readonly string[];
  /** Position of the current location; -1 while empty. */
  readonly index: number;
};

export const NAVIGATION_HISTORY_LIMIT = 50;
export const EMPTY_NAVIGATION_HISTORY: NavigationHistory = { entries: [], index: -1 };

const CONVERSATION_PREFIX = "conversation:";
const VIEW_PREFIX = "view:";

export type NavigationLocation =
  | { kind: "conversation"; conversationId: string }
  | { kind: "view"; view: `${SidebarShortcutId}-hub` };

/**
 * The location the workbench shows: a saved conversation in the chat view, or
 * a resource hub. Unsent drafts are not recorded (there is nothing to return
 * to), and neither is the settings overlay, which closes on its own.
 */
export function workbenchNavigationLocation(input: {
  activeView: "chat" | `${SidebarShortcutId}-hub`;
  conversationId: string | null | undefined;
  isDraft: boolean;
}): string | null {
  if (input.activeView !== "chat") return `${VIEW_PREFIX}${input.activeView}`;
  const id = input.conversationId?.trim();
  return id && !input.isDraft ? `${CONVERSATION_PREFIX}${id}` : null;
}

export function parseNavigationLocation(location: string): NavigationLocation | null {
  if (location.startsWith(CONVERSATION_PREFIX)) {
    const conversationId = location.slice(CONVERSATION_PREFIX.length);
    return conversationId ? { kind: "conversation", conversationId } : null;
  }
  if (location.startsWith(VIEW_PREFIX)) {
    const view = location.slice(VIEW_PREFIX.length);
    const resource = view.replace(/-hub$/, "");
    if (view.endsWith("-hub") && SIDEBAR_SHORTCUTS.some((entry) => entry.id === resource)) {
      return { kind: "view", view: view as `${SidebarShortcutId}-hub` };
    }
  }
  return null;
}

/** Deleted conversations and hubs hidden from the sidebar are skipped. */
export function isWorkbenchNavigationLocationOpenable(
  location: string,
  input: { hasConversation: (id: string) => boolean; visibleHubs: SidebarShortcuts },
): boolean {
  const parsed = parseNavigationLocation(location);
  if (!parsed) return false;
  if (parsed.kind === "conversation") return input.hasConversation(parsed.conversationId);
  return input.visibleHubs[parsed.view.replace(/-hub$/, "") as SidebarShortcutId] === true;
}

/**
 * Records a visit. Revisiting the current location is a no-op; a new location
 * drops the forward branch (like a browser) and the oldest entries beyond
 * `limit`.
 */
export function recordNavigation(
  history: NavigationHistory,
  location: string,
  limit = NAVIGATION_HISTORY_LIMIT,
): NavigationHistory {
  if (history.entries[history.index] === location) return history;
  const entries = [...history.entries.slice(0, history.index + 1), location];
  const overflow = Math.max(0, entries.length - Math.max(1, limit));
  const kept = overflow > 0 ? entries.slice(overflow) : entries;
  return { entries: kept, index: kept.length - 1 };
}

/**
 * One step back (-1) or forward (+1). Entries that can no longer be opened
 * (deleted conversations, hidden views) are dropped first, and so are
 * duplicates that end up adjacent once they are gone, so a step never lands
 * on a dead or identical location. Null when there is nowhere to go.
 */
export function stepNavigation(
  history: NavigationHistory,
  direction: -1 | 1,
  isValid: (location: string) => boolean = () => true,
): { history: NavigationHistory; location: string } | null {
  const entries: string[] = [];
  let index = -1;
  history.entries.forEach((location, position) => {
    const current = position === history.index;
    if (!current && !isValid(location)) return;
    if (entries[entries.length - 1] !== location) entries.push(location);
    if (current) index = entries.length - 1;
  });
  if (index < 0) return null;
  const target = index + direction;
  if (target < 0 || target >= entries.length) return null;
  return { history: { entries, index: target }, location: entries[target] };
}

// A navigation may pass through intermediate locations before it lands (a hub
// switches to the chat view first, the conversation commits a moment later).
// Those are not visits of their own.
const PENDING_NAVIGATION_MS = 1500;

export type NavigationHistoryControls = {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => boolean;
  goForward: () => boolean;
};

export function useNavigationHistory(options: {
  /** What the main area shows now; null for states that are not recorded (drafts). */
  location: string | null;
  /** Shows a recorded location again. */
  navigate: (location: string) => void;
  /** Whether a recorded location can still be opened. */
  isValid?: (location: string) => boolean;
  limit?: number;
  /** Mouse back / forward buttons (buttons 3 and 4) step through the history. */
  mouseButtons?: boolean;
}): NavigationHistoryControls {
  const { location, limit = NAVIGATION_HISTORY_LIMIT, mouseButtons = true } = options;
  const [history, setHistory] = useState<NavigationHistory>(EMPTY_NAVIGATION_HISTORY);
  const historyRef = useRef(history);
  historyRef.current = history;
  const latestRef = useRef(options);
  latestRef.current = options;
  const pendingRef = useRef<{ location: string; until: number } | null>(null);

  useEffect(() => {
    if (location === null) return;
    const pending = pendingRef.current;
    if (pending) {
      if (pending.location === location) {
        pendingRef.current = null;
        return;
      }
      if (Date.now() < pending.until) return;
      pendingRef.current = null;
    }
    setHistory((current) => {
      const next = recordNavigation(current, location, limit);
      historyRef.current = next;
      return next;
    });
  }, [limit, location]);

  const go = useCallback((direction: -1 | 1) => {
    const step = stepNavigation(historyRef.current, direction, latestRef.current.isValid);
    if (!step) return false;
    historyRef.current = step.history;
    setHistory(step.history);
    pendingRef.current = { location: step.location, until: Date.now() + PENDING_NAVIGATION_MS };
    latestRef.current.navigate(step.location);
    return true;
  }, []);
  const goBack = useCallback(() => go(-1), [go]);
  const goForward = useCallback(() => go(1), [go]);

  useEffect(() => {
    if (!mouseButtons) return;
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      // A dialog over the workbench keeps what is behind it in place.
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(MODAL_ROLE_SELECTOR)) return;
      if (go(event.button === 3 ? -1 : 1)) event.preventDefault();
    };
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [go, mouseButtons]);

  const isValid = options.isValid;
  return {
    canGoBack: stepNavigation(history, -1, isValid) !== null,
    canGoForward: stepNavigation(history, 1, isValid) !== null,
    goBack,
    goForward,
  };
}
