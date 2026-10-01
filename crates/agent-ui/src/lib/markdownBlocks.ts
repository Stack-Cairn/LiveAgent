// Chat-tuned block splitter for Streamdown.
//
// Streamdown's default `parseMarkdownIntoBlocks` has a fast-path bail: any
// footnote-looking syntax (`[^ref]` / `[^ref]:`) anywhere in the document
// returns the WHOLE text as a single block. Block-level memoization then
// stops working entirely — during streaming every delta re-parses and
// re-renders the full accumulated text (a cliff: O(N) per frame).
//
// This variant keeps the default splitter's exact semantics (including its
// unclosed-`$$` parity merging) for everything BEFORE the first footnote
// marker, and merges only the suffix from that point on into one block:
//   - blocks before the first `[^` contain no footnote syntax, so splitting
//     them is safe and they stay memoizable;
//   - the merged suffix contains every footnote reference and definition
//     together, so remark resolves them within one tree exactly like the
//     upstream single-block path.
//
// Implementation trick: the default splitter guarantees lossless
// concatenation (blocks join back to the input). We run it over a
// length-preserving sanitized copy (`[^` → `(^`) so the footnote bail cannot
// trigger, then slice the ORIGINAL text by the returned block lengths —
// boundaries stay structural (blank lines / fences), content stays intact.
import { parseMarkdownIntoBlocks } from "streamdown";

// Any footnote-like bracket — reference or definition. Kept in sync with the
// pair of regexes used by Streamdown's fast-path bail.
const FOOTNOTE_MARKER = /\[\^[\w-]{1,200}\]/;

export function parseChatMarkdownBlocks(markdown: string): string[] {
  if (!FOOTNOTE_MARKER.test(markdown)) {
    return parseMarkdownIntoBlocks(markdown);
  }

  // `(^` renders as plain text and cannot look like a footnote; same length,
  // and block boundaries are structural so inline changes do not move them
  // in any way that matters — original slices stay lossless by construction.
  const sanitized = markdown.replaceAll("[^", "(^");
  const sanitizedBlocks = parseMarkdownIntoBlocks(sanitized);

  const blocks: string[] = [];
  let offset = 0;
  let mergeFrom = -1;
  for (const sanitizedBlock of sanitizedBlocks) {
    const block = markdown.slice(offset, offset + sanitizedBlock.length);
    offset += sanitizedBlock.length;
    if (mergeFrom === -1 && FOOTNOTE_MARKER.test(block)) {
      mergeFrom = blocks.length;
    }
    blocks.push(block);
  }
  if (mergeFrom !== -1 && mergeFrom < blocks.length - 1) {
    const merged = blocks.slice(mergeFrom).join("");
    blocks.length = mergeFrom;
    blocks.push(merged);
  }
  return blocks;
}
