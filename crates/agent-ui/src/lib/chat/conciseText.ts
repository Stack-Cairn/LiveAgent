/**
 * Short one-line targets for tool rows and tool-batch headers ("Ran pnpm test",
 * "Read App.tsx"). Widths are counted in terminal columns: CJK and other wide
 * characters take two, so a Chinese command or path is cut at the same visual
 * width as a Latin one. The full text always stays available elsewhere (the
 * native tooltip and the expanded row body); these helpers only shorten.
 */

/** Visual budget of a concise tool target, in columns. */
export const CONCISE_TARGET_MAX_COLUMNS = 48;

const ELLIPSIS = "…";

// East Asian Wide/Fullwidth blocks plus astral pictographs (emoji, CJK
// extensions). Precise enough for a title; a mis-measured rare character only
// shifts the cut by one column.
const WIDE_CHARACTER =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

export function characterColumns(character: string): number {
  return WIDE_CHARACTER.test(character) ? 2 : 1;
}

export function displayColumns(text: string): number {
  let columns = 0;
  for (const character of text) columns += characterColumns(character);
  return columns;
}

/** Collapses whitespace runs (newlines included) into single spaces. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Keeps the head of `text` within `maxColumns`, ending in "…" when cut. */
export function truncateColumns(text: string, maxColumns = CONCISE_TARGET_MAX_COLUMNS): string {
  if (displayColumns(text) <= maxColumns) return text;
  const budget = Math.max(1, maxColumns - 1);
  let used = 0;
  let kept = "";
  for (const character of text) {
    const width = characterColumns(character);
    if (used + width > budget) break;
    kept += character;
    used += width;
  }
  return `${kept.trimEnd()}${ELLIPSIS}`;
}

/**
 * Keeps the tail of a path ("…/chat/assistant-bubble/ToolTraceGroup.tsx"): the
 * file or folder name is the part a reader recognizes.
 */
export function truncatePathStart(path: string, maxColumns = CONCISE_TARGET_MAX_COLUMNS): string {
  const text = collapseWhitespace(path);
  if (displayColumns(text) <= maxColumns) return text;
  const characters = Array.from(text);
  const budget = Math.max(1, maxColumns - 1);
  let used = 0;
  let start = characters.length;
  while (start > 0) {
    const width = characterColumns(characters[start - 1] ?? "");
    if (used + width > budget) break;
    used += width;
    start -= 1;
  }
  let tail = characters.slice(start).join("");
  // Prefer cutting at a separator so the tail starts with a whole segment.
  const separator = tail.search(/[\\/]/);
  if (separator > 0 && separator < tail.length - 1) tail = tail.slice(separator);
  return `${ELLIPSIS}${tail}`;
}

// `cd /some/where && pnpm test` reads as `pnpm test`: the working directory is
// context, the program is the point. Only a leading cd joined by && or ; is
// dropped, and only when something follows it.
const LEADING_CD = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/;

/**
 * First command line, without a leading `cd …&&` and with a trailing line
 * continuation removed; " …" marks that more lines follow.
 */
export function conciseCommand(command: string, maxColumns = CONCISE_TARGET_MAX_COLUMNS): string {
  const lines = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0];
  if (!first) return "";
  let line = first.replace(/\s*\\$/, "");
  const withoutCd = line.replace(LEADING_CD, "");
  if (withoutCd) line = withoutCd;
  line = collapseWhitespace(line);
  const text = lines.length > 1 ? `${line} ${ELLIPSIS}` : line;
  return truncateColumns(text, maxColumns);
}

/** `https://www.example.com/docs/x?y` → `example.com/docs/x?y`, then cut. */
export function conciseUrl(url: string, maxColumns = CONCISE_TARGET_MAX_COLUMNS): string {
  const text = collapseWhitespace(url)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
  return truncateColumns(text, maxColumns);
}
