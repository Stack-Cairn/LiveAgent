// Pure decision logic for the app-wide native-input context menu. Kept free
// of DOM and module imports so the node test loader can exercise it directly.

/**
 * Input types whose selection API (selectionStart/setSelectionRange) is
 * supported per WHATWG. number/time/email/date either throw or return null in
 * Chromium and WebKit, so those inputs keep the plain suppressed-menu
 * behavior instead of a menu acting on an unknowable selection.
 */
export const TEXT_SELECTION_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "url",
  "tel",
  "password",
]);

/**
 * Whether a right-clicked element should get the shared input context menu.
 * Structurally typed so tests can pass plain objects instead of DOM nodes.
 */
export function isMenuEligibleTarget(el: {
  tagName?: unknown;
  type?: unknown;
  disabled?: unknown;
}): boolean {
  if (el.disabled === true) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  const type = typeof el.type === "string" && el.type ? el.type.toLowerCase() : "text";
  return TEXT_SELECTION_INPUT_TYPES.has(type);
}

export type InputMenuSnapshot = {
  x: number;
  y: number;
  /** Selection captured when the menu opened; actions restore it. */
  start: number;
  end: number;
  hasSelection: boolean;
  hasContent: boolean;
  readOnly: boolean;
  isPassword: boolean;
};

export type InputMenuItems = {
  canCopy: boolean;
  canCut: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
};

export function computeMenuItems(snapshot: InputMenuSnapshot): InputMenuItems {
  // Passwords never reach the clipboard in plaintext — native menus agree.
  const canCopy = snapshot.hasSelection && !snapshot.isPassword;
  return {
    canCopy,
    canCut: canCopy && !snapshot.readOnly,
    // Optimistic: clipboard contents are unknowable synchronously.
    canPaste: !snapshot.readOnly,
    // readOnly still allows selecting, so only emptiness disables it.
    canSelectAll: snapshot.hasContent,
  };
}

/**
 * Selection the menu should act on when it opens. A focused input keeps its
 * live selection; an unfocused one collapses the caret to the end — surfacing
 * a stale selection (or an onFocus select-all) on right-click reads as the
 * menu selecting text by itself.
 */
export function resolveOpenSelection(
  wasFocused: boolean,
  selectionStart: number | null,
  selectionEnd: number | null,
  valueLength: number,
): { start: number; end: number } {
  if (!wasFocused) return { start: valueLength, end: valueLength };
  return {
    start: selectionStart ?? valueLength,
    end: selectionEnd ?? valueLength,
  };
}

export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
  const maxTop = Math.max(margin, viewportHeight - menuHeight - margin);
  return {
    left: Math.min(Math.max(margin, x), maxLeft),
    top: Math.min(Math.max(margin, y), maxTop),
  };
}
