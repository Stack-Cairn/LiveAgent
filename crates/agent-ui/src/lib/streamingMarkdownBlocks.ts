// Incremental block splitting for a Markdown text that only grows at the end.
//
// In streaming mode Streamdown runs two passes over the whole text on every
// update before it can tell which blocks changed: remend (repairs unfinished
// syntax) and the block lexer. Both are O(text) although only the end of the
// text moved, and the streaming tail is up to ~10k characters, updated once a
// frame.
//
// This parser keeps the blocks of the previous call, re-lexes only from the
// start of the last REPARSE_CONTENT_BLOCKS non-blank blocks, and repairs only
// the final block:
//   - Block boundaries are top-level and lossless (blocks join back to the
//     input), so lexing a suffix that starts on a boundary yields the blocks a
//     full lex would. The look-back covers the cases where new text changes
//     how the previous block ends (a paragraph turning into a setext heading,
//     a list absorbing an indented continuation).
//   - Only the last block can hold unfinished syntax. Blocks render
//     independently, so a repair computed over the whole text (which counts
//     markers in earlier, finished blocks) is no more correct than one over
//     the last block, and costs O(text) instead of O(block).
// Anything that is not a pure append (the tail moved into a frozen segment,
// a rewrite) falls back to a full parse.
import remend from "remend";
import { parseChatMarkdownBlocks } from "./markdownBlocks";

// Blank-line runs are blocks of their own; only blocks with content count.
const REPARSE_CONTENT_BLOCKS = 2;

export type MarkdownBlockParser = (markdown: string) => string[];

export function createStreamingBlockParser(
  parseBlocks: MarkdownBlockParser = parseChatMarkdownBlocks,
  repair: (markdown: string) => string = remend,
): MarkdownBlockParser {
  let previousInput = "";
  let previousBlocks: string[] = [];

  const split = (markdown: string): string[] => {
    let keep = previousBlocks.length;
    for (let content = 0; keep > 0 && content < REPARSE_CONTENT_BLOCKS; ) {
      keep -= 1;
      if (previousBlocks[keep].trim()) content += 1;
    }
    if (keep <= 0 || !markdown.startsWith(previousInput)) return parseBlocks(markdown);
    let offset = 0;
    for (let index = 0; index < keep; index += 1) offset += previousBlocks[index].length;
    const reparsed = parseBlocks(markdown.slice(offset));
    return previousBlocks.slice(0, keep).concat(reparsed);
  };

  return (markdown) => {
    const blocks = split(markdown);
    previousInput = markdown;
    previousBlocks = blocks;
    if (blocks.length === 0) return blocks;
    const repaired = blocks.slice();
    const last = repaired.length - 1;
    repaired[last] = repair(repaired[last]);
    return repaired;
  };
}
