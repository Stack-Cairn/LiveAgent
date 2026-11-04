// Quote-to-composer: text selected inside a transcript message bubble can be
// pushed into the composer as a Markdown blockquote. This module holds the
// pure pieces (selection eligibility, quote formatting) so both hosts — the
// desktop transcript and the WebUI transcript — share one policy.

/** Marks a transcript region whose text may be quoted ("user" | "assistant"). */
export const TRANSCRIPT_QUOTE_SOURCE_ATTR = "data-quote-source";
export const TRANSCRIPT_QUOTE_SOURCE_SELECTOR = `[${TRANSCRIPT_QUOTE_SOURCE_ATTR}]`;

/** Selection endpoints inside these never offer a quote: editors, terminals,
 *  form controls, interactive chrome, and the quote button itself. */
export const TRANSCRIPT_QUOTE_EXCLUDED_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='button']",
  ".monaco-editor",
  ".xterm",
  "[data-quote-exclude]",
  "[data-transcript-quote-button]",
].join(",");

/** Upper bound on quoted text; longer selections are truncated with an ellipsis. */
export const TRANSCRIPT_QUOTE_MAX_CHARS = 8000;

export type TranscriptQuoteSource = "user" | "assistant";

export type TranscriptQuoteSelection = {
  text: string;
  source: TranscriptQuoteSource;
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
};

/** Normalize selected text: unify line endings, drop trailing spaces per
 *  line, trim surrounding blank lines and collapse runs of blank lines. */
export function normalizeQuoteText(raw: string) {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""));
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
  const collapsed: string[] = [];
  for (const line of lines) {
    if (!line.trim() && !collapsed[collapsed.length - 1]?.trim()) continue;
    collapsed.push(line);
  }
  let text = collapsed.join("\n");
  const chars = [...text];
  if (chars.length > TRANSCRIPT_QUOTE_MAX_CHARS) {
    text = `${chars.slice(0, TRANSCRIPT_QUOTE_MAX_CHARS).join("").replace(/\s+$/u, "")}…`;
  }
  return text;
}

/** Format text as a Markdown blockquote ("> " per line, bare ">" for blanks). */
export function formatMarkdownBlockquote(raw: string) {
  const text = normalizeQuoteText(raw);
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** Text to append to a composer whose current serialized content is
 *  `existing`: the blockquote, separated from prior content by a blank line,
 *  followed by a blank line so the caret lands where the reply goes. */
export function buildComposerQuoteInsertion(existing: string, raw: string) {
  const quote = formatMarkdownBlockquote(raw);
  if (!quote) return "";
  let prefix = "";
  if (existing.trim()) {
    if (existing.endsWith("\n\n")) prefix = "";
    else if (existing.endsWith("\n")) prefix = "\n";
    else prefix = "\n\n";
  }
  return `${prefix}${quote}\n\n`;
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** Resolve the current selection into a quotable candidate, or null when the
 *  selection is collapsed, leaves the transcript root, spans more than one
 *  quote source, or touches an excluded region (code editor, terminal,
 *  controls). */
export function resolveTranscriptQuoteSelection(
  root: HTMLElement | null,
  selection: Selection | null,
): TranscriptQuoteSelection | null {
  if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const startElement = elementOf(range.startContainer);
  const endElement = elementOf(range.endContainer);
  if (!startElement || !endElement) return null;
  if (
    startElement.closest(TRANSCRIPT_QUOTE_EXCLUDED_SELECTOR) ||
    endElement.closest(TRANSCRIPT_QUOTE_EXCLUDED_SELECTOR)
  ) {
    return null;
  }
  const startSource = startElement.closest(TRANSCRIPT_QUOTE_SOURCE_SELECTOR);
  const endSource = endElement.closest(TRANSCRIPT_QUOTE_SOURCE_SELECTOR);
  if (!startSource || startSource !== endSource || !root.contains(startSource)) return null;
  const sourceValue = startSource.getAttribute(TRANSCRIPT_QUOTE_SOURCE_ATTR);
  const source: TranscriptQuoteSource = sourceValue === "user" ? "user" : "assistant";
  const text = normalizeQuoteText(selection.toString());
  if (!text) return null;
  // Layout-less DOMs (tests, detached nodes) have no Range geometry.
  const box =
    typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  return {
    text,
    source,
    rect: {
      left: box?.left ?? 0,
      top: box?.top ?? 0,
      right: box?.right ?? 0,
      bottom: box?.bottom ?? 0,
      width: box?.width ?? 0,
      height: box?.height ?? 0,
    },
  };
}

/** Fixed-position placement for the floating quote button: centered above
 *  the selection, flipped below when there is no room, clamped to the
 *  viewport. */
export function resolveQuoteButtonPosition(
  rect: TranscriptQuoteSelection["rect"],
  button: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
  margin = 8,
) {
  const center = rect.left + rect.width / 2;
  const left = Math.max(
    margin,
    Math.min(viewport.width - button.width - margin, center - button.width / 2),
  );
  const above = rect.top - button.height - gap;
  const preferred = above >= margin ? above : rect.bottom + gap;
  const top = Math.max(margin, Math.min(viewport.height - button.height - margin, preferred));
  return { left, top };
}
