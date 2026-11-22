import { SETTINGS_ANCHOR_ATTRIBUTE } from "./settingsSearchIndex";

/**
 * Pending "open settings at this row" request. The command palette records it
 * right before opening settings; the settings shell consumes it once the
 * section is rendered, scrolls the row into view and highlights it.
 */
export type SettingsAnchorRequest = { section: string; anchor: string };

let pending: SettingsAnchorRequest | null = null;
const listeners = new Set<() => void>();

export function requestSettingsAnchor(section: string, anchor: string): void {
  pending = { section, anchor };
  for (const listener of listeners) listener();
}

export function subscribeSettingsAnchor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Returns and clears the pending request. */
export function takeSettingsAnchor(): SettingsAnchorRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export const SETTINGS_HIGHLIGHT_ATTRIBUTE = "data-settings-highlight";
const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [role="switch"], [tabindex]:not([tabindex="-1"])';

/**
 * Waits (sections may load asynchronously) for the anchor inside `root`, then
 * scrolls it to the middle of the view, highlights it for a moment and moves
 * keyboard focus to its first control. Returns a cancel function.
 */
export function revealSettingsAnchor(
  root: ParentNode,
  anchor: string,
  options: { timeoutMs?: number; highlightMs?: number; focus?: boolean } = {},
): () => void {
  const timeoutMs = options.timeoutMs ?? 2500;
  const highlightMs = options.highlightMs ?? 1800;
  const startedAt = Date.now();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;
  let highlighted: Element | null = null;
  let cancelled = false;

  const attempt = () => {
    if (cancelled) return;
    let target: HTMLElement | null = null;
    for (const element of root.querySelectorAll<HTMLElement>(`[${SETTINGS_ANCHOR_ATTRIBUTE}]`)) {
      if (element.getAttribute(SETTINGS_ANCHOR_ATTRIBUTE) === anchor) {
        target = element;
        break;
      }
    }
    if (!target) {
      if (Date.now() - startedAt < timeoutMs) pollTimer = setTimeout(attempt, 60);
      return;
    }
    target.scrollIntoView?.({ block: "center", behavior: "smooth" });
    target.setAttribute(SETTINGS_HIGHLIGHT_ATTRIBUTE, "true");
    highlighted = target;
    if (options.focus !== false) {
      const control = target.matches(FOCUSABLE)
        ? target
        : target.querySelector<HTMLElement>(FOCUSABLE);
      control?.focus({ preventScroll: true });
    }
    highlightTimer = setTimeout(() => {
      target.removeAttribute(SETTINGS_HIGHLIGHT_ATTRIBUTE);
      highlighted = null;
    }, highlightMs);
  };
  attempt();

  return () => {
    cancelled = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (highlightTimer) clearTimeout(highlightTimer);
    highlighted?.removeAttribute(SETTINGS_HIGHLIGHT_ATTRIBUTE);
  };
}
