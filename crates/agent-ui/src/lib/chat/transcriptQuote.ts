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
  "[data-transcript-selection-actions]",
  "[data-composer-comment-editor]",
].join(",");

/** Code blocks inside a quote source: selections wholly inside one are
 *  commented on as code (fenced, indentation kept) rather than prose. */
const TRANSCRIPT_CODE_BLOCK_SELECTOR = "pre, [data-streamdown='code-block']";

export type TranscriptQuoteSource = "user" | "assistant";

export type TranscriptQuoteSelection = {
  text: string;
  source: TranscriptQuoteSource;
  /** Set when the selection lies inside a single code block. */
  code?: { language?: string };
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
};

/** Normalize line endings and ignore blank lines around the selection. */
export function normalizeQuoteText(raw: string) {
  const lines = raw.replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines.join("\n");
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
 *  followed by a blank line to separate any following instruction. */
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
  const code = resolveSelectionCodeBlock(startElement, endElement, startSource);
  // Layout-less DOMs (tests, detached nodes) have no Range geometry.
  const box =
    typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  return {
    text,
    source,
    ...(code ? { code } : {}),
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

function codeBlockLanguage(block: Element, source: Element) {
  const codeElement = block.matches("code") ? block : block.querySelector("code");
  // Rendered markdown puts the language on a wrapper (data-language) and on
  // the <pre> class; plain markup puts it on <code class="language-x">.
  const wrapper = block.closest("[data-language]");
  const explicit =
    block.getAttribute("data-language") ??
    codeElement?.getAttribute("data-language") ??
    (wrapper && source.contains(wrapper) ? wrapper.getAttribute("data-language") : null) ??
    "";
  if (explicit.trim()) return explicit.trim();
  for (const element of [codeElement, block]) {
    const match = element?.className.match(/(?:^|\s)language-([^\s]+)/);
    if (match?.[1]) return match[1];
  }
  return "";
}

function resolveSelectionCodeBlock(
  startElement: Element,
  endElement: Element,
  source: Element,
): { language?: string } | null {
  const block = startElement.closest(TRANSCRIPT_CODE_BLOCK_SELECTOR);
  if (!block || block !== endElement.closest(TRANSCRIPT_CODE_BLOCK_SELECTOR)) return null;
  if (!source.contains(block)) return null;
  const language = codeBlockLanguage(block, source);
  return language ? { language } : {};
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
