/**
 * Shell-style ↑/↓ recall of prompts previously sent in the conversation.
 *
 * The decision logic is a pure step function so both composers stay in
 * lockstep: the caller reports where the caret sits, the step answers whether
 * the key browses history, restores the stashed draft, or falls through to
 * plain caret movement. Recall only triggers while the caret sits on the
 * first (↑) or last (↓) logical line, so arrow keys keep moving the caret
 * inside multi-line drafts; any edit must reset the session because cursor
 * and stash are only meaningful while the recalled text is untouched.
 *
 * GUI 与 WebUI 共同复用此状态机。
 */

export type PromptHistoryStash<TPaste> = {
  /**
   * Editor innerHTML captured when recall began. Composer chips carry no
   * per-node listeners, so an innerHTML round-trip restores them losslessly.
   */
  html: string;
  /** Large-paste registry entries backing the stashed chips. */
  pastes: ReadonlyArray<readonly [string, TPaste]>;
};

export type PromptHistorySession<TPaste> = {
  /** Recallable prompts, oldest → newest, frozen at session entry. */
  entries: readonly string[];
  /** Index into entries of the prompt currently shown in the editor. */
  cursor: number;
  /** Draft to restore when ↓ walks past the newest entry. */
  stash: PromptHistoryStash<TPaste>;
};

export type PromptHistoryStep<TPaste> =
  /** Not a history move — let the browser handle the key. */
  | { type: "pass" }
  /** A history move with nowhere to go (already at the oldest entry). */
  | { type: "consume" }
  | { type: "apply"; text: string; session: PromptHistorySession<TPaste> }
  | { type: "restore"; stash: PromptHistoryStash<TPaste> };

export const PROMPT_HISTORY_MAX_ENTRIES = 200;

/**
 * Drops blank prompts, keeps only the most recent occurrence of duplicates,
 * and caps the list at PROMPT_HISTORY_MAX_ENTRIES (newest win). Order stays
 * oldest → newest.
 */
export function normalizePromptHistoryEntries(raw: readonly string[]): string[] {
  const newestFirst: string[] = [];
  const seen = new Set<string>();
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    const entry = raw[index];
    if (!entry || entry.trim().length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    newestFirst.push(entry);
    if (newestFirst.length >= PROMPT_HISTORY_MAX_ENTRIES) break;
  }
  return newestFirst.reverse();
}

export function stepPromptHistory<TPaste>(args: {
  direction: "prev" | "next";
  session: PromptHistorySession<TPaste> | null;
  caretOnFirstLine: boolean;
  caretOnLastLine: boolean;
  /** Called lazily, only when ↑ actually enters a recall session. */
  loadEntries: () => readonly string[];
  /** Called lazily, only when ↑ actually enters a recall session. */
  makeStash: () => PromptHistoryStash<TPaste>;
}): PromptHistoryStep<TPaste> {
  const { direction, session } = args;

  if (direction === "prev") {
    if (!args.caretOnFirstLine) return { type: "pass" };
    if (session) {
      if (session.cursor <= 0) return { type: "consume" };
      const next = { ...session, cursor: session.cursor - 1 };
      return { type: "apply", text: next.entries[next.cursor], session: next };
    }
    const entries = normalizePromptHistoryEntries(args.loadEntries());
    if (entries.length === 0) return { type: "pass" };
    const entered: PromptHistorySession<TPaste> = {
      entries,
      cursor: entries.length - 1,
      stash: args.makeStash(),
    };
    return { type: "apply", text: entries[entered.cursor], session: entered };
  }

  if (!session || !args.caretOnLastLine) return { type: "pass" };
  if (session.cursor >= session.entries.length - 1) {
    return { type: "restore", stash: session.stash };
  }
  const next = { ...session, cursor: session.cursor + 1 };
  return { type: "apply", text: next.entries[next.cursor], session: next };
}

export type PromptHistoryCaretLine = {
  onFirstLine: boolean;
  onLastLine: boolean;
};

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const DOCUMENT_FRAGMENT_NODE = 11;

function appendLineText(node: Node, out: string[]) {
  if (node.nodeType === TEXT_NODE) {
    out.push((node as Text).data);
    return;
  }
  if (node.nodeType !== ELEMENT_NODE && node.nodeType !== DOCUMENT_FRAGMENT_NODE) return;
  if (node.nodeType === ELEMENT_NODE) {
    const element = node as Element;
    if (element.tagName === "BR") {
      out.push("\n");
      return;
    }
    // Chips are atomic inline tokens: whatever text they render internally
    // never contributes logical line breaks.
    if (element.getAttribute("contenteditable") === "false") return;
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    appendLineText(child, out);
  }
}

/** Text with <br> mapped to \n and non-editable chips treated as opaque. */
export function collectPromptLineText(root: Node): string {
  const out: string[] = [];
  appendLineText(root, out);
  return out.join("");
}

/**
 * Where the collapsed caret sits inside the editor, in logical lines
 * (segments split by <br>; soft-wrapped long lines count as one line).
 * Returns null when the selection is missing, non-collapsed, or outside.
 */
export function caretPromptHistoryLine(root: HTMLElement): PromptHistoryCaretLine | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  if (container !== root && !root.contains(container)) return null;

  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);

  const beforeText = collectPromptLineText(before.cloneContents());
  // A single trailing <br> is the contenteditable's invisible line
  // terminator, not a real empty last line — ignore exactly one.
  const afterText = collectPromptLineText(after.cloneContents()).replace(/\n$/, "");
  return {
    onFirstLine: !beforeText.includes("\n"),
    onLastLine: !afterText.includes("\n"),
  };
}
