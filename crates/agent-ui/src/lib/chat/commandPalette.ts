import type { ComponentType } from "react";
import { matchesShortcutCommand } from "../shortcuts/shortcutCommands";
import { SHORTCUT_IGNORED_TARGETS } from "../shortcuts/shortcutKeys";

/**
 * Cmd/Ctrl+K command palette model. The palette lives inside the conversation
 * search dialog: hosts hand over a snapshot of actions that already exist in
 * the app (new conversation, settings, panels, ...) and the dialog lists them
 * next to the conversation search results.
 */

export type CommandPaletteGroupId = "suggested" | "navigation" | "view" | "settings" | "models";

export const COMMAND_PALETTE_GROUP_ORDER: readonly CommandPaletteGroupId[] = [
  "suggested",
  "navigation",
  "view",
  "settings",
  "models",
];

export type CommandPaletteAction = {
  id: string;
  group: CommandPaletteGroupId;
  label: string;
  /** Extra search terms (English aliases, section ids, ...). */
  keywords?: readonly string[];
  icon?: ComponentType<{ className?: string }>;
  /** Display-only shortcut hint such as "⌘B". */
  shortcut?: string;
  /** Marks the current choice (active model, active mode, ...). */
  active?: boolean;
  /** Only listed once the user types a query (long lists such as models). */
  searchOnly?: boolean;
  run: () => void;
};

/** Read lazily when the palette opens so hosts never re-render the sidebar for it. */
export type CommandPaletteActionsProvider = () => readonly CommandPaletteAction[];

/** `>` restricts the palette to actions, like editor command palettes. */
export const COMMAND_PALETTE_ACTIONS_PREFIX = ">";

export function parseCommandPaletteQuery(raw: string): { actionsOnly: boolean; query: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith(COMMAND_PALETTE_ACTIONS_PREFIX)) {
    return {
      actionsOnly: true,
      query: trimmed.slice(COMMAND_PALETTE_ACTIONS_PREFIX.length).trim(),
    };
  }
  return { actionsOnly: false, query: trimmed };
}

function normalize(value: string) {
  return value.toLocaleLowerCase();
}

function actionScore(action: CommandPaletteAction, tokens: readonly string[]): number {
  const label = normalize(action.label);
  const haystack = [label, ...(action.keywords ?? []).map(normalize)].join("\n");
  if (!tokens.every((token) => haystack.includes(token))) return -1;
  const phrase = tokens.join(" ");
  if (label.startsWith(phrase)) return 3;
  if (label.split(/[\s/:·-]+/).some((word) => word.startsWith(tokens[0] ?? ""))) return 2;
  if (label.includes(phrase)) return 1;
  return 0;
}

/**
 * Case-insensitive, all-tokens-must-match filter. An empty query lists the
 * non search-only actions in group order; a query ranks label prefix matches
 * first and keeps the host order for ties.
 */
export function filterCommandPaletteActions(
  actions: readonly CommandPaletteAction[],
  query: string,
): CommandPaletteAction[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  const groupIndex = (action: CommandPaletteAction) =>
    COMMAND_PALETTE_GROUP_ORDER.indexOf(action.group);
  if (tokens.length === 0) {
    return actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => !action.searchOnly)
      .sort((a, b) => groupIndex(a.action) - groupIndex(b.action) || a.index - b.index)
      .map(({ action }) => action);
  }
  return actions
    .map((action, index) => ({ action, index, score: actionScore(action, tokens) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (a, b) =>
        b.score - a.score || groupIndex(a.action) - groupIndex(b.action) || a.index - b.index,
    )
    .map(({ action }) => action);
}

export { isMacLikePlatform } from "../shared/platform";

type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "metaKey"
  | "ctrlKey"
  | "altKey"
  | "shiftKey"
  | "isComposing"
  | "keyCode"
  | "repeat"
  | "defaultPrevented"
  | "target"
>;

/**
 * Editors and terminals own their own chords (Monaco uses Cmd+K as a chord
 * prefix, terminals use it to clear); never steal the key from them.
 */
export const COMMAND_PALETTE_IGNORED_TARGETS = SHORTCUT_IGNORED_TARGETS;

/**
 * The palette binding from the shortcut table (default Cmd+K on macOS, Ctrl+K
 * elsewhere). Ctrl+K on macOS stays the native "kill to end of line" binding.
 */
export function isCommandPaletteShortcut(event: ShortcutKeyEvent, isMac: boolean): boolean {
  if (event.defaultPrevented) return false;
  return matchesShortcutCommand(event, "commandPalette", isMac);
}

/** Surfaces that cover the chat (the desktop settings overlay) opt out of the shortcut. */
export const COMMAND_PALETTE_SUPPRESSED_ATTRIBUTE = "data-command-palette-suppressed";

export function isCommandPaletteSuppressed(doc: Document | undefined = globalThis.document) {
  return Boolean(doc?.querySelector(`[${COMMAND_PALETTE_SUPPRESSED_ATTRIBUTE}]`));
}
