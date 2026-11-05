/**
 * Keyboard accelerator primitives shared by the desktop system-wide hotkeys and
 * the in-app shortcut commands.
 *
 * An accelerator is written as `Ctrl+Shift+KeyA`: modifiers are Ctrl / Shift /
 * Alt / Super, the main key is a W3C `KeyboardEvent.code`. Defaults may use the
 * virtual `Mod` modifier, which means Super (⌘) on macOS and Ctrl elsewhere.
 */

import { isMacLikePlatform } from "../shared/platform";

export const SHORTCUT_MODIFIER_ORDER = ["Ctrl", "Shift", "Alt", "Super"] as const;
export type ShortcutModifier = (typeof SHORTCUT_MODIFIER_ORDER)[number];

/** Platform primary modifier: ⌘ on macOS, Ctrl elsewhere. Only valid in defaults. */
export const SHORTCUT_PRIMARY_MODIFIER = "Mod";

const MODIFIER_SET = new Set<string>(SHORTCUT_MODIFIER_ORDER);

export function isShortcutModifierToken(token: string): token is ShortcutModifier {
  return MODIFIER_SET.has(token);
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

// ---------------------------------------------------------------------------
// Display. Every shortcut label in the UI (Kbd caps, tooltips, menus, settings,
// native titles) goes through the functions below, so one chord always reads
// the same: ⌃⌥⇧⌘ glyphs in macOS menu order, "Ctrl+Shift+Alt+Win" elsewhere.
// `isMac` defaults to the browser platform; hosts that know better (the
// desktop runtime platform) pass it explicitly.
//
// Display chords accept the accelerator syntax above plus a few hand-written
// spellings: modifiers are case-insensitive and may be written Control, Option,
// Meta, Cmd or Command; the key may be a plain label ("K", "/", "?", "Esc"); a
// trailing "++" is the plus key itself ("Ctrl++").
// ---------------------------------------------------------------------------

const DISPLAY_MODIFIER_ALIASES: Record<
  string,
  ShortcutModifier | typeof SHORTCUT_PRIMARY_MODIFIER
> = {
  mod: SHORTCUT_PRIMARY_MODIFIER,
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  super: "Super",
  meta: "Super",
  cmd: "Super",
  command: "Super",
};

// macOS menus list modifiers as ⌃⌥⇧⌘; other platforms write Ctrl+Shift+Alt+Win.
const MAC_DISPLAY_MODIFIER_ORDER: readonly ShortcutModifier[] = ["Ctrl", "Alt", "Shift", "Super"];

const MAC_MODIFIER_DISPLAY: Record<ShortcutModifier, string> = {
  Ctrl: "⌃",
  Shift: "⇧",
  Alt: "⌥",
  Super: "⌘",
};

const OTHER_MODIFIER_DISPLAY: Record<ShortcutModifier, string> = {
  Ctrl: "Ctrl",
  Shift: "Shift",
  Alt: "Alt",
  Super: "Win",
};

const ARIA_MODIFIERS: Record<ShortcutModifier, string> = {
  Ctrl: "Control",
  Shift: "Shift",
  Alt: "Alt",
  Super: "Meta",
};

/** Hand-written key names -> the KeyboardEvent.code (or label) they stand for. */
const KEY_ALIASES: Record<string, string> = {
  Esc: "Escape",
  Return: "Enter",
  Del: "Delete",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Plus: "+",
};

/** Keys whose conventional label differs between macOS and other platforms. */
const PLATFORM_KEY_DISPLAY: Record<string, { mac: string; other: string }> = {
  Enter: { mac: "↩", other: "Enter" },
  NumpadEnter: { mac: "⌤", other: "Num Enter" },
  Backspace: { mac: "⌫", other: "Backspace" },
  Delete: { mac: "⌦", other: "Del" },
};

const SHORTCUT_CODE_DISPLAY: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Escape: "Esc",
  CapsLock: "Caps",
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
};

/** `aria-keyshortcuts` names for codes whose key value differs from the code. */
const ARIA_KEYS: Record<string, string> = {
  Space: "Space",
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
  NumpadDivide: "/",
  NumpadMultiply: "*",
  NumpadSubtract: "-",
  NumpadAdd: "+",
  NumpadDecimal: ".",
  NumpadEnter: "Enter",
};

export type ShortcutChord = {
  /** Modifiers in display order for the platform, `Mod` resolved. */
  modifiers: ShortcutModifier[];
  /** Main key as a KeyboardEvent.code or a plain label; null while only modifiers are held. */
  key: string | null;
};

/** Parses a display chord; see the syntax note above. */
export function parseShortcutChord(
  accelerator: string,
  isMac: boolean = isMacLikePlatform(),
): ShortcutChord {
  const modifiers = new Set<ShortcutModifier>();
  let key: string | null = null;
  const parts = accelerator.endsWith("++")
    ? [...accelerator.slice(0, -2).split("+"), "+"]
    : accelerator.split("+");
  for (const raw of parts) {
    const token = raw.trim();
    if (!token) continue;
    const modifier = DISPLAY_MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier === SHORTCUT_PRIMARY_MODIFIER) modifiers.add(isMac ? "Super" : "Ctrl");
    else if (modifier) modifiers.add(modifier);
    else key = KEY_ALIASES[token] ?? token;
  }
  const order = isMac ? MAC_DISPLAY_MODIFIER_ORDER : SHORTCUT_MODIFIER_ORDER;
  return { modifiers: order.filter((modifier) => modifiers.has(modifier)), key };
}

/** Label of one modifier: ⌘ / ⌥ / ⇧ / ⌃ on macOS, Ctrl / Shift / Alt / Win elsewhere. */
export function shortcutModifierDisplayLabel(modifier: ShortcutModifier, isMac: boolean): string {
  return (isMac ? MAC_MODIFIER_DISPLAY : OTHER_MODIFIER_DISPLAY)[modifier];
}

/** Label of one main key: "KeyK" -> "K", "Enter" -> "↩" (macOS) / "Enter", "Escape" -> "Esc". */
export function shortcutKeyDisplayLabel(key: string, isMac: boolean): string {
  const code = KEY_ALIASES[key] ?? key;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  const platform = PLATFORM_KEY_DISPLAY[code];
  if (platform) return isMac ? platform.mac : platform.other;
  return SHORTCUT_CODE_DISPLAY[code] ?? (code.length === 1 ? code.toUpperCase() : code);
}

/** Display tokens, one per key cap: ["⇧", "⌘", "O"] (macOS) or ["Ctrl", "Shift", "O"]. */
export function shortcutDisplayTokens(
  accelerator: string,
  isMac: boolean = isMacLikePlatform(),
): string[] {
  const { modifiers, key } = parseShortcutChord(accelerator, isMac);
  const tokens = modifiers.map((modifier) => shortcutModifierDisplayLabel(modifier, isMac));
  if (key) tokens.push(shortcutKeyDisplayLabel(key, isMac));
  return tokens;
}

/** Compact one-string label: "⇧⌘O" on macOS, "Ctrl+Shift+O" elsewhere; "" when empty. */
export function formatShortcutLabel(
  accelerator: string,
  isMac: boolean = isMacLikePlatform(),
): string {
  return shortcutDisplayTokens(accelerator, isMac).join(isMac ? "" : "+");
}

/** Value for `aria-keyshortcuts`, e.g. "Meta+Shift+O" or "Control+B". */
export function shortcutAriaKeys(
  accelerator: string,
  isMac: boolean = isMacLikePlatform(),
): string {
  const { modifiers, key } = parseShortcutChord(accelerator, isMac);
  const tokens = modifiers.map((modifier) => ARIA_MODIFIERS[modifier]);
  if (key) {
    if (/^Key[A-Z]$/.test(key)) tokens.push(key.slice(3));
    else if (/^Digit\d$/.test(key)) tokens.push(key.slice(5));
    else if (/^Numpad\d$/.test(key)) tokens.push(key.slice(6));
    else tokens.push(ARIA_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  }
  return tokens.join("+");
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
