/**
 * Find-in-conversation model. The transcript is virtualized, so the DOM only
 * holds the rows around the viewport: matches are counted on the row data
 * model (one entry per virtual row), the active match scrolls its row into
 * view, and only then is the rendered text highlighted in the DOM.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { matchesShortcutCommand } from "../shortcuts/shortcutCommands";

export type TranscriptFindEntry = {
  /** Virtual row key; the rendered row carries it as `data-row-key`. */
  rowKey: string;
  /** Text the row renders (markdown source is fine: see stripMarkdownForFind). */
  text: string;
};

export type TranscriptFindMatch = {
  rowKey: string;
  /** Zero-based occurrence of the query inside that row. */
  occurrence: number;
};

export function normalizeTranscriptFindQuery(query: string) {
  return foldTranscriptFindText(query.trim());
}

/**
 * Lower-cases without changing string length, so offsets found in the folded
 * text still address the original text (a few characters such as "İ" grow
 * when lower-cased; those are kept as-is).
 */
export function foldTranscriptFindText(text: string) {
  const folded = text.toLocaleLowerCase();
  if (folded.length === text.length) return folded;
  let result = "";
  for (const char of text) {
    const lower = char.toLocaleLowerCase();
    result += lower.length === char.length ? lower : char;
  }
  return result;
}

/** Non-overlapping occurrence offsets of a folded needle in folded text. */
export function findOccurrenceOffsets(foldedText: string, foldedNeedle: string): number[] {
  if (!foldedNeedle) return [];
  const offsets: number[] = [];
  let from = 0;
  while (from <= foldedText.length - foldedNeedle.length) {
    const index = foldedText.indexOf(foldedNeedle, from);
    if (index < 0) break;
    offsets.push(index);
    from = index + foldedNeedle.length;
  }
  return offsets;
}

/**
 * Drops the markdown syntax that never reaches the rendered text (link
 * targets, emphasis markers, code fences, heading markers), so counts on the
 * data model line up with what the DOM shows.
 *
 * Parsing costs far more than the regexes it replaced; callers that strip the
 * same message again and again (an open find bar rebuilds every row's text on
 * each streamed delta) use stripMarkdownForFindOf, which keeps the result on
 * the message object. This entry point keeps a bounded cache by source text.
 */
export function stripMarkdownForFind(markdown: string) {
  const cached = stripCache.get(markdown);
  if (cached !== undefined) {
    stripCache.delete(markdown);
    stripCache.set(markdown, cached);
    return cached;
  }
  const text = parseVisibleText(markdown);
  rememberStripped(markdown, text);
  return text;
}

const strippedByOwner = new WeakMap<object, { markdown: string; text: string }>();

/**
 * stripMarkdownForFind cached on the immutable object that owns the markdown
 * (a message block): a long conversation keeps every finished message's text
 * however large it is, the cache goes away with the message, and only a
 * message whose text changed is parsed again.
 */
export function stripMarkdownForFindOf(owner: object, markdown: string) {
  const cached = strippedByOwner.get(owner);
  if (cached !== undefined && cached.markdown === markdown) return cached.text;
  const text = parseVisibleText(markdown);
  strippedByOwner.set(owner, { markdown, text });
  return text;
}

function parseVisibleText(markdown: string) {
  return visibleText(
    fromMarkdown(markdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }),
  );
}

const STRIP_CACHE_MAX_ENTRIES = 1024;
const STRIP_CACHE_MAX_CHARS = 1024 * 1024;
const stripCache = new Map<string, string>();
let stripCacheChars = 0;

function rememberStripped(markdown: string, text: string) {
  const size = markdown.length + text.length;
  if (size > STRIP_CACHE_MAX_CHARS) return;
  stripCache.set(markdown, text);
  stripCacheChars += size;
  for (const [key, value] of stripCache) {
    if (stripCache.size <= STRIP_CACHE_MAX_ENTRIES && stripCacheChars <= STRIP_CACHE_MAX_CHARS) {
      break;
    }
    stripCache.delete(key);
    stripCacheChars -= key.length + value.length;
  }
}

type FindNode = {
  type: string;
  value?: string;
  alt?: string | null;
  children?: FindNode[];
};

function visibleText(node: FindNode): string {
  switch (node.type) {
    case "text":
    case "code":
    case "inlineCode":
      return node.value ?? "";
    case "html":
      return (node.value ?? "").replace(/<\/?[a-z][^>\n]*>/gi, "");
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "break":
      return "\n";
    default: {
      const block = ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(
        node.type,
      );
      return (node.children ?? []).map(visibleText).join(block ? "\n" : "");
    }
  }
}

type FoldedEntry = { text: string; folded: string; needle: string; count: number };
// Entries are rebuilt per published row change, but a row that did not
// change publishes the same entry object: its folded text and last count are
// reused, so a streamed delta only folds and scans the changed rows.
const foldedEntries = new WeakMap<TranscriptFindEntry, FoldedEntry>();

function countEntryMatches(entry: TranscriptFindEntry, needle: string) {
  let folded = foldedEntries.get(entry);
  if (folded === undefined || folded.text !== entry.text) {
    folded = { text: entry.text, folded: foldTranscriptFindText(entry.text), needle: "", count: 0 };
    foldedEntries.set(entry, folded);
  }
  if (folded.needle !== needle) {
    folded.needle = needle;
    folded.count = findOccurrenceOffsets(folded.folded, needle).length;
  }
  return folded.count;
}

export function buildTranscriptFindMatches(
  entries: readonly TranscriptFindEntry[],
  query: string,
): TranscriptFindMatch[] {
  const needle = normalizeTranscriptFindQuery(query);
  if (!needle) return [];
  const matches: TranscriptFindMatch[] = [];
  for (const entry of entries) {
    if (!entry.text) continue;
    const count = countEntryMatches(entry, needle);
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      matches.push({ rowKey: entry.rowKey, occurrence });
    }
  }
  return matches;
}

export function transcriptFindMatchId(match: TranscriptFindMatch) {
  return `${match.rowKey}\u0000${match.occurrence}`;
}

/** Wrapping step through the matches: +1 next, -1 previous. */
export function stepTranscriptFindIndex(current: number, total: number, direction: 1 | -1) {
  if (total <= 0) return -1;
  if (current < 0) return direction > 0 ? 0 : total - 1;
  return (current + direction + total) % total;
}

export { isMacLikePlatform } from "../shared/platform";

type FindShortcutEvent = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "metaKey"
  | "ctrlKey"
  | "altKey"
  | "shiftKey"
  | "isComposing"
  | "keyCode"
  | "target"
>;

/**
 * The find binding from the shortcut table (default Cmd+F on macOS, Ctrl+F
 * elsewhere). `defaultPrevented` is deliberately not checked: the desktop
 * webview guard cancels the browser's own Cmd/Ctrl+F in the capture phase
 * before any app handler runs.
 */
export function isTranscriptFindShortcut(event: FindShortcutEvent, isMac: boolean) {
  // Same guard as every other table command: a rebinding to a bare key must
  // not fire while the user is typing in a field.
  return matchesShortcutCommand(event, "findInConversation", isMac);
}

/** Editors and terminals bring their own find widget. */
export const TRANSCRIPT_FIND_IGNORED_TARGETS = ".monaco-editor, .xterm";

const EDITABLE_TARGET =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';

/** Element that scopes one conversation (its transcript plus its composer). */
export const TRANSCRIPT_FIND_SCOPE = "[data-workbench-pane-id]";
const WORKBENCH_PANE = "[data-workbench-pane]";
// Selector for modal surfaces (shared Dialog/AlertDialog render these roles).
const DIALOG = "[role=dialog], [role=alertdialog], [aria-modal=true]";
const CHAT_SHELL = '[data-slot="sidebar-wrapper"]';

/**
 * Decides whether the transcript rooted at `root` owns a Cmd/Ctrl+F press.
 *
 * - never inside Monaco or xterm (their own find widget handles it);
 * - a press inside a conversation (its transcript, its composer, or the find
 *   input itself) belongs to that conversation only;
 * - other text fields, dialogs and overlays outside the chat shell (settings)
 *   keep the key;
 * - pane chrome routes to its own pane;
 * - with nothing (or a sidebar row) focused, the focused workbench pane takes it.
 */
export function shouldTranscriptHandleFindShortcut(
  target: EventTarget | null,
  root: Element | null,
): boolean {
  if (!root) return false;
  const element =
    target && typeof (target as Element).closest === "function" ? (target as Element) : null;
  const doc = element?.ownerDocument;
  const nothingFocused = !element || element === doc?.body || element === doc?.documentElement;
  if (element && !nothingFocused) {
    if (element.closest(TRANSCRIPT_FIND_IGNORED_TARGETS)) return false;
    const scope = root.closest(TRANSCRIPT_FIND_SCOPE) ?? root;
    if (scope.contains(element)) return true;
    if (element.closest(EDITABLE_TARGET) || element.closest(DIALOG)) return false;
    const targetPane = element.closest(WORKBENCH_PANE);
    if (targetPane) return targetPane.contains(root);
    // A sidebar button keeps focus after opening a conversation: the chat
    // shell (sidebar + panes) still routes the key to the focused pane, while
    // overlays outside it (settings) keep it.
    if (!element.closest(CHAT_SHELL)?.contains(root)) return false;
  }
  const pane = root.closest(WORKBENCH_PANE);
  return !pane || pane.getAttribute("data-workbench-pane-focused") === "true";
}
