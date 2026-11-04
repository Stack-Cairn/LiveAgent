/**
 * Keyboard accelerator primitives shared by the desktop system-wide hotkeys and
 * the in-app shortcut commands.
 *
 * An accelerator is written as `Ctrl+Shift+KeyA`: modifiers are Ctrl / Shift /
 * Alt / Super, the main key is a W3C `KeyboardEvent.code`. Defaults may use the
 * virtual `Mod` modifier, which means Super (⌘) on macOS and Ctrl elsewhere.
 */

export const SHORTCUT_MODIFIER_ORDER = ["Ctrl", "Shift", "Alt", "Super"] as const;
export type ShortcutModifier = (typeof SHORTCUT_MODIFIER_ORDER)[number];

/** Platform primary modifier: ⌘ on macOS, Ctrl elsewhere. Only valid in defaults. */
export const SHORTCUT_PRIMARY_MODIFIER = "Mod";

const MODIFIER_SET = new Set<string>(SHORTCUT_MODIFIER_ORDER);

const SHORTCUT_CODE_DISPLAY: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Enter: "↵",
  Escape: "Esc",
  CapsLock: "Caps",
  Backspace: "⌫",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Insert: "Ins",
  Delete: "Del",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  PrintScreen: "PrtSc",
  ScrollLock: "ScrLk",
  Pause: "Pause",
  ContextMenu: "Menu",
  NumLock: "NumLock",
  NumpadDivide: "Num /",
  NumpadMultiply: "Num *",
  NumpadSubtract: "Num -",
  NumpadAdd: "Num +",
  NumpadDecimal: "Num .",
  Numpad0: "Num 0",
  Numpad1: "Num 1",
  Numpad2: "Num 2",
  Numpad3: "Num 3",
  Numpad4: "Num 4",
  Numpad5: "Num 5",
  Numpad6: "Num 6",
  Numpad7: "Num 7",
  Numpad8: "Num 8",
  Numpad9: "Num 9",
};

const MAC_MODIFIER_DISPLAY: Record<ShortcutModifier, string> = {
  Ctrl: "⌃",
  Shift: "⇧",
  Alt: "⌥",
  Super: "⌘",
};

export function isShortcutModifierToken(token: string): token is ShortcutModifier {
  return MODIFIER_SET.has(token);
}

export function globalShortcutKeyDisplayLabel(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return SHORTCUT_CODE_DISPLAY[code] ?? code;
}

export function globalShortcutDisplayToken(token: string, isMac: boolean): string {
  if (isShortcutModifierToken(token)) {
    if (isMac) return MAC_MODIFIER_DISPLAY[token];
    return token === "Super" ? "Win" : token;
  }
  return globalShortcutKeyDisplayLabel(token);
}

/** KeyboardEvent.code -> modifier token; null for non-modifier keys. */
export function modifierFromEventCode(code: string): ShortcutModifier | null {
  switch (code) {
    case "ControlLeft":
    case "ControlRight":
      return "Ctrl";
    case "ShiftLeft":
    case "ShiftRight":
      return "Shift";
    case "AltLeft":
    case "AltRight":
      return "Alt";
    case "MetaLeft":
    case "MetaRight":
      return "Super";
    default:
      return null;
  }
}

/**
 * Resolves `Mod` for the platform and puts modifiers in canonical order, so two
 * spellings of one chord compare equal. Returns "" for an empty accelerator.
 */
export function resolveAccelerator(accelerator: string, isMac: boolean): string {
  const tokens = accelerator
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => (token === SHORTCUT_PRIMARY_MODIFIER ? (isMac ? "Super" : "Ctrl") : token));
  const modifiers = SHORTCUT_MODIFIER_ORDER.filter((modifier) => tokens.includes(modifier));
  const main = tokens.filter((token) => !isShortcutModifierToken(token));
  return [...modifiers, ...main].join("+");
}

/** Display tokens such as ["⌘", "⇧", "O"] (macOS) or ["Ctrl", "Shift", "O"]. */
export function shortcutDisplayTokens(accelerator: string, isMac: boolean): string[] {
  const resolved = resolveAccelerator(accelerator, isMac);
  if (!resolved) return [];
  const tokens = resolved.split("+");
  // macOS menus list modifiers as ⌃⌥⇧⌘; other platforms keep Ctrl+Shift+Alt+Win.
  const ordered = isMac
    ? [
        ...MAC_DISPLAY_MODIFIER_ORDER.filter((modifier) => tokens.includes(modifier)),
        ...tokens.filter((token) => !MODIFIER_SET.has(token)),
      ]
    : tokens;
  return ordered.map((token) => globalShortcutDisplayToken(token, isMac));
}

const MAC_DISPLAY_MODIFIER_ORDER: readonly ShortcutModifier[] = ["Ctrl", "Alt", "Shift", "Super"];

/** Compact label: "⇧⌘O" on macOS, "Ctrl+Shift+O" elsewhere. */
export function formatShortcutLabel(accelerator: string, isMac: boolean): string {
  return shortcutDisplayTokens(accelerator, isMac).join(isMac ? "" : "+");
}

/** True when the chord holds Ctrl or ⌘ — such chords never type text. */
export function acceleratorHasPrimaryModifier(accelerator: string): boolean {
  const tokens = accelerator.split("+").map((token) => token.trim());
  return tokens.includes("Ctrl") || tokens.includes("Super") || tokens.includes("Mod");
}

function acceleratorMainKey(accelerator: string): string | undefined {
  const main = accelerator
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token && !isShortcutModifierToken(token) && token !== "Mod");
  return main.length === 1 ? main[0] : undefined;
}

export function isFunctionKeyCode(code: string | undefined): boolean {
  return Boolean(code && /^F\d{1,2}$/.test(code));
}

type ShortcutMatchEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
>;

/**
 * Exact modifier match on the physical key. Letter keys also match on
 * `event.key` so non-QWERTY Latin layouts keep the printed letter.
 */
export function matchesAccelerator(
  event: ShortcutMatchEvent,
  accelerator: string,
  isMac: boolean,
): boolean {
  const resolved = resolveAccelerator(accelerator, isMac);
  if (!resolved) return false;
  const tokens = resolved.split("+");
  const main = acceleratorMainKey(resolved);
  if (!main) return false;
  if (
    tokens.includes("Ctrl") !== event.ctrlKey ||
    tokens.includes("Shift") !== event.shiftKey ||
    tokens.includes("Alt") !== event.altKey ||
    tokens.includes("Super") !== event.metaKey
  ) {
    return false;
  }
  if (event.code === main) return true;
  return (
    main.startsWith("Key") &&
    main.length === 4 &&
    typeof event.key === "string" &&
    event.key.toLowerCase() === main.slice(3).toLowerCase()
  );
}

/** Builds an accelerator from a recorded keydown; null while only modifiers are held. */
export function acceleratorFromEvent(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
): string | null {
  if (!event.code || modifierFromEventCode(event.code)) return null;
  const modifiers: ShortcutModifier[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.altKey) modifiers.push("Alt");
  if (event.metaKey) modifiers.push("Super");
  return [...modifiers, event.code].join("+");
}

/** Editors and terminals own their own chords (Monaco Cmd+K, terminal Ctrl+…). */
export const SHORTCUT_IGNORED_TARGETS = ".monaco-editor, .xterm";

export const SHORTCUT_EDITABLE_TARGETS =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';

function targetElement(target: EventTarget | null | undefined): Element | null {
  return target && typeof (target as Element).closest === "function" ? (target as Element) : null;
}

export function isEditableShortcutTarget(target: EventTarget | null | undefined): boolean {
  return Boolean(targetElement(target)?.closest(SHORTCUT_EDITABLE_TARGETS));
}

/**
 * Typing guard shared by every in-app shortcut: never during IME composition,
 * never inside Monaco / xterm, and a chord without Ctrl/⌘ (bare keys, Alt or
 * Shift chords that type characters on some layouts) never fires from a text
 * field. Function keys are allowed everywhere.
 */
export function canShortcutFireFromTarget(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode" | "target">,
  accelerator: string,
): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  const element = targetElement(event.target);
  if (element?.closest(SHORTCUT_IGNORED_TARGETS)) return false;
  if (
    element?.closest(SHORTCUT_EDITABLE_TARGETS) &&
    !acceleratorHasPrimaryModifier(accelerator) &&
    !isFunctionKeyCode(acceleratorMainKey(accelerator))
  ) {
    return false;
  }
  return true;
}

// Hosts that cancel browser accelerators in the capture phase (the desktop
// webview guard cancels Ctrl/Cmd+O, +S, +P, …) mark those events here so app
// shortcuts bound to the same chords still run.
const hostBlockedKeyEvents = new WeakSet<Event>();

export function markKeyEventDefaultBlockedByHost(event: Event): void {
  hostBlockedKeyEvents.add(event);
}

export function wasKeyEventDefaultBlockedByHost(event: Event): boolean {
  return hostBlockedKeyEvents.has(event);
}

/** True when another handler already consumed the key (not just the host guard). */
export function isKeyEventHandledElsewhere(event: KeyboardEvent): boolean {
  return event.defaultPrevented && !wasKeyEventDefaultBlockedByHost(event);
}

let shortcutsSuspended = false;

/** Recording a new binding suspends every in-app shortcut. */
export function setInAppShortcutsSuspended(suspended: boolean): void {
  shortcutsSuspended = suspended;
}

export function areInAppShortcutsSuspended(): boolean {
  return shortcutsSuspended;
}
