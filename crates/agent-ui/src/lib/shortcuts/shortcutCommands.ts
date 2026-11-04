import { useSyncExternalStore } from "react";
import {
  areInAppShortcutsSuspended,
  canShortcutFireFromTarget,
  formatShortcutLabel,
  matchesAccelerator,
  resolveAccelerator,
} from "./shortcutKeys";

/**
 * The single table of in-app shortcut commands. Desktop and WebUI share it:
 * every place that handles a shortcut, lists it in the command palette or shows
 * it in settings reads the binding from here.
 *
 * Bindings use `Mod` for ⌘ (macOS) / Ctrl (elsewhere). Defaults avoid chords
 * the browser keeps for itself (Ctrl/⌘+N/T/W, Ctrl+Tab, ⌘⇧[ ]) and text
 * editing chords inside the composer.
 */
export type ShortcutCommandId =
  | "commandPalette"
  | "searchConversations"
  | "findInConversation"
  | "newConversation"
  | "previousConversation"
  | "nextConversation"
  | "focusComposer"
  | "openModelPicker"
  | "toggleSidebar"
  | "toggleRightPanel"
  | "openSettings";

export type ShortcutCommandGroup = "general" | "navigation" | "composer" | "view";

export type ShortcutCommand = {
  id: ShortcutCommandId;
  group: ShortcutCommandGroup;
  labelKey: string;
  /** Accelerator such as `Mod+Shift+KeyO`; null when unbound by default. */
  defaultBinding: string | null;
  /** Command palette row that runs the same action. */
  paletteActionId?: string;
};

export const SHORTCUT_COMMAND_GROUP_ORDER: readonly ShortcutCommandGroup[] = [
  "general",
  "navigation",
  "composer",
  "view",
];

export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  {
    id: "commandPalette",
    group: "general",
    labelKey: "shortcuts.command.commandPalette",
    defaultBinding: "Mod+KeyK",
  },
  {
    id: "newConversation",
    group: "general",
    labelKey: "shortcuts.command.newConversation",
    defaultBinding: "Mod+Shift+KeyO",
    paletteActionId: "new-conversation",
  },
  {
    id: "openSettings",
    group: "general",
    labelKey: "shortcuts.command.openSettings",
    defaultBinding: "Mod+Comma",
    paletteActionId: "open-settings",
  },
  {
    id: "searchConversations",
    group: "navigation",
    labelKey: "shortcuts.command.searchConversations",
    defaultBinding: null,
  },
  {
    id: "previousConversation",
    group: "navigation",
    labelKey: "shortcuts.command.previousConversation",
    defaultBinding: "Mod+Alt+BracketLeft",
    paletteActionId: "previous-conversation",
  },
  {
    id: "nextConversation",
    group: "navigation",
    labelKey: "shortcuts.command.nextConversation",
    defaultBinding: "Mod+Alt+BracketRight",
    paletteActionId: "next-conversation",
  },
  {
    id: "findInConversation",
    group: "navigation",
    labelKey: "shortcuts.command.findInConversation",
    defaultBinding: "Mod+KeyF",
  },
  {
    id: "focusComposer",
    group: "composer",
    labelKey: "shortcuts.command.focusComposer",
    defaultBinding: "Slash",
  },
  {
    id: "openModelPicker",
    group: "composer",
    labelKey: "shortcuts.command.openModelPicker",
    defaultBinding: "Mod+Slash",
  },
  {
    id: "toggleSidebar",
    group: "view",
    labelKey: "shortcuts.command.toggleSidebar",
    defaultBinding: "Mod+KeyB",
    paletteActionId: "toggle-sidebar",
  },
  {
    id: "toggleRightPanel",
    group: "view",
    labelKey: "shortcuts.command.toggleRightPanel",
    defaultBinding: "Mod+Alt+KeyB",
    paletteActionId: "toggle-project-tools",
  },
];

const COMMANDS_BY_ID = new Map(SHORTCUT_COMMANDS.map((command) => [command.id, command]));
const COMMANDS_BY_PALETTE_ACTION = new Map(
  SHORTCUT_COMMANDS.flatMap((command) =>
    command.paletteActionId ? [[command.paletteActionId, command] as const] : [],
  ),
);

export function getShortcutCommand(id: ShortcutCommandId): ShortcutCommand | undefined {
  return COMMANDS_BY_ID.get(id);
}

export function isShortcutCommandId(value: unknown): value is ShortcutCommandId {
  return typeof value === "string" && COMMANDS_BY_ID.has(value as ShortcutCommandId);
}

/**
 * User overrides, stored on the device only (shortcuts are a device preference,
 * not part of settings sync). A string replaces the default; "" unbinds the
 * command. Commands without an entry use their default.
 */
export type ShortcutOverrides = Partial<Record<ShortcutCommandId, string>>;

export const SHORTCUT_OVERRIDES_STORAGE_KEY = "liveagent.shortcuts.v1";

let cachedOverrides: ShortcutOverrides | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parseOverrides(raw: string | null): ShortcutOverrides {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const overrides: ShortcutOverrides = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isShortcutCommandId(id) || typeof value !== "string") continue;
      overrides[id] = value.trim();
    }
    return overrides;
  } catch {
    return {};
  }
}

export function readShortcutOverrides(): ShortcutOverrides {
  if (cachedOverrides) return cachedOverrides;
  cachedOverrides = parseOverrides(storage()?.getItem(SHORTCUT_OVERRIDES_STORAGE_KEY) ?? null);
  return cachedOverrides;
}

function notify() {
  for (const listener of listeners) listener();
}

export function writeShortcutOverrides(overrides: ShortcutOverrides): void {
  const next: ShortcutOverrides = {};
  for (const command of SHORTCUT_COMMANDS) {
    const value = overrides[command.id];
    if (value === undefined) continue;
    // Storing the default again is the same as having no override.
    if (value === (command.defaultBinding ?? "")) continue;
    next[command.id] = value;
  }
  cachedOverrides = next;
  try {
    const store = storage();
    if (Object.keys(next).length === 0) store?.removeItem(SHORTCUT_OVERRIDES_STORAGE_KEY);
    else store?.setItem(SHORTCUT_OVERRIDES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode): keep the in-memory value for this session.
  }
  notify();
}

/** Drops the cache so the next read sees storage again (other tabs, tests). */
export function invalidateShortcutOverrides(): void {
  cachedOverrides = null;
  notify();
}

export function subscribeShortcutOverrides(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === SHORTCUT_OVERRIDES_STORAGE_KEY) {
    invalidateShortcutOverrides();
  }
}

/** Raw binding (may contain `Mod`); "" when the command is unbound. */
export function getShortcutBinding(
  id: ShortcutCommandId,
  overrides: ShortcutOverrides = readShortcutOverrides(),
): string {
  const override = overrides[id];
  if (override !== undefined) return override;
  return getShortcutCommand(id)?.defaultBinding ?? "";
}

export function isShortcutOverridden(
  id: ShortcutCommandId,
  overrides: ShortcutOverrides = readShortcutOverrides(),
): boolean {
  return overrides[id] !== undefined;
}

/** Concrete binding for the platform (`Mod` resolved); "" when unbound. */
export function getResolvedShortcutBinding(
  id: ShortcutCommandId,
  isMac: boolean,
  overrides?: ShortcutOverrides,
): string {
  return resolveAccelerator(getShortcutBinding(id, overrides), isMac);
}

/** Display label such as "⇧⌘O" / "Ctrl+Shift+O"; undefined when unbound. */
export function formatShortcutCommand(
  id: ShortcutCommandId,
  isMac: boolean,
  overrides?: ShortcutOverrides,
): string | undefined {
  const binding = getShortcutBinding(id, overrides);
  return binding ? formatShortcutLabel(binding, isMac) : undefined;
}

/** Shortcut label for a command palette row, if a command runs that row. */
export function formatPaletteActionShortcut(
  paletteActionId: string,
  isMac: boolean,
): string | undefined {
  const command = COMMANDS_BY_PALETTE_ACTION.get(paletteActionId);
  return command ? formatShortcutCommand(command.id, isMac) : undefined;
}

type ShortcutCommandEvent = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "ctrlKey"
  | "shiftKey"
  | "altKey"
  | "metaKey"
  | "isComposing"
  | "keyCode"
  | "target"
>;

/**
 * Full check for a handler: the chord matches, shortcuts are not suspended
 * (recording), no IME composition, and the typing guard allows the target.
 */
export function matchesShortcutCommand(
  event: ShortcutCommandEvent,
  id: ShortcutCommandId,
  isMac: boolean,
): boolean {
  if (areInAppShortcutsSuspended()) return false;
  const binding = getShortcutBinding(id);
  if (!binding || !matchesAccelerator(event, binding, isMac)) return false;
  return canShortcutFireFromTarget(event, resolveAccelerator(binding, isMac));
}

/** Command ids sharing one concrete chord; every id maps to the others it collides with. */
export function findShortcutConflicts(
  bindings: ReadonlyArray<{ id: string; accelerator: string }>,
  isMac: boolean,
): Map<string, string[]> {
  const byChord = new Map<string, string[]>();
  for (const { id, accelerator } of bindings) {
    const chord = resolveAccelerator(accelerator, isMac);
    if (!chord) continue;
    const ids = byChord.get(chord) ?? [];
    ids.push(id);
    byChord.set(chord, ids);
  }
  const conflicts = new Map<string, string[]>();
  for (const ids of byChord.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      conflicts.set(
        id,
        ids.filter((other) => other !== id),
      );
    }
  }
  return conflicts;
}

/** Re-renders when overrides change (settings page, other tabs). */
export function useShortcutOverrides(): ShortcutOverrides {
  return useSyncExternalStore(
    subscribeShortcutOverrides,
    readShortcutOverrides,
    readShortcutOverrides,
  );
}
