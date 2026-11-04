import { type RefObject, useEffect, useRef } from "react";

/**
 * Esc stops the running turn of the conversation that has focus.
 *
 * The key is read on `window` in the bubble phase, after every layer that
 * owns Esc has seen it. Precedence is therefore structural:
 *
 * 1. composer popups (mention / slash menus) stop propagation, and the
 *    command panel and the expanded composer call `preventDefault`;
 * 2. a pending tool approval keeps Esc for itself (the caller disables this
 *    while the approval bar is shown);
 * 3. Base UI dialogs, popovers and menus `preventDefault` when they close,
 *    and a target inside any of them is ignored anyway; so is any key while
 *    the settings layer covers the chat;
 * 4. a surface marked `data-escape-owner` (sidebar selection mode) and a
 *    non-empty text selection keep Esc for themselves;
 * 5. only then does Esc stop the run.
 */

/** Element that scopes one conversation: its transcript plus its composer. */
export const ESCAPE_STOP_RUN_SCOPE = "[data-workbench-pane-id], [data-conversation-scope]";
const WORKBENCH_PANE = "[data-workbench-pane]";
// Modal and popup surfaces (shared Dialog/AlertDialog/Menu render these roles),
// plus full-page layers such as settings that cover the chat without a dialog role,
// and any surface that marks itself as owning Esc (sidebar selection mode).
const OVERLAY =
  "[role=dialog], [role=alertdialog], [aria-modal=true], [role=menu], [role=listbox], [data-command-palette-suppressed], [data-escape-owner]";
const EDITABLE_TARGET =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';

export type EscapeStopRunEvent = Pick<
  KeyboardEvent,
  | "key"
  | "defaultPrevented"
  | "isComposing"
  | "keyCode"
  | "repeat"
  | "altKey"
  | "ctrlKey"
  | "metaKey"
  | "shiftKey"
  | "target"
>;

export type EscapeStopRunContext = {
  /** Conversation scope (transcript + composer) this composer belongs to. */
  scope: Element | null;
  /** The composer's own editing area; other text fields keep Esc. */
  composerInput: Element | null;
};

export function shouldEscapeStopRun(
  event: EscapeStopRunEvent,
  context: EscapeStopRunContext,
): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.repeat) return false;
  // Esc during IME composition cancels the composition, not the run.
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const { scope, composerInput } = context;
  if (!scope?.isConnected || scope.getClientRects().length === 0) return false;

  const target = event.target;
  const element =
    target && typeof (target as Element).closest === "function" ? (target as Element) : null;
  const doc = scope.ownerDocument;
  const nothingFocused = !element || element === doc.body || element === doc.documentElement;
  if (nothingFocused) {
    // Clicking transcript text leaves focus on <body>: the focused pane takes
    // the key, unless some overlay is open on top of it.
    if (doc.querySelector(OVERLAY)) return false;
    // With text selected, Esc dismisses the selection (and its Quote button).
    const selection = doc.defaultView?.getSelection?.();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return false;
    const pane = scope.closest(WORKBENCH_PANE);
    return !pane || pane.getAttribute("data-workbench-pane-focused") === "true";
  }
  if (element.closest(OVERLAY)) return false;
  if (!scope.contains(element)) return false;
  // Inline editors in the transcript (message edit, goal edit, find bar) use
  // Esc to cancel themselves.
  if (element.closest(EDITABLE_TARGET) && !composerInput?.contains(element)) return false;
  return true;
}

export function useEscapeToStopRun(options: {
  enabled: boolean;
  onStop: () => void;
  /** Any element inside the conversation scope (the composer layer). */
  anchorRef: RefObject<Element | null>;
  composerInputRef: RefObject<Element | null>;
}) {
  const { enabled, anchorRef, composerInputRef } = options;
  const onStopRef = useRef(options.onStop);
  onStopRef.current = options.onStop;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const anchor = anchorRef.current;
      const scope = anchor?.closest(ESCAPE_STOP_RUN_SCOPE) ?? null;
      if (!shouldEscapeStopRun(event, { scope, composerInput: composerInputRef.current })) return;
      event.preventDefault();
      onStopRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anchorRef, composerInputRef, enabled]);
}
