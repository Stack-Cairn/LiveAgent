const MEDIUM_STREAM_CHARACTERS = 12_000;
const LARGE_STREAM_CHARACTERS = 48_000;
const VERY_LARGE_STREAM_CHARACTERS = 160_000;

/**
 * Keep short replies feeling immediate, then progressively trade visual
 * update frequency for main-thread headroom as the mutable Markdown tail
 * becomes more expensive to parse and lay out.
 */
export function resolveStreamingRenderDelay(characterCount: number): number {
  if (characterCount < MEDIUM_STREAM_CHARACTERS) return 0;
  if (characterCount < LARGE_STREAM_CHARACTERS) return 32;
  if (characterCount < VERY_LARGE_STREAM_CHARACTERS) return 64;
  return 96;
}

// A streaming thinking segment is watched through a bottom-pinned viewport a
// few hundred pixels tall: only the tail is ever visible, yet re-rendering the
// disclosure re-parses the whole accumulated markdown every flush. While a
// segment is actively streaming, only this much of its tail is handed to
// Markdown; the full text renders once the segment settles (or is reopened).
const STREAMING_TAIL_BUDGET_CHARS = 8_000;
// Cutting right at the budget boundary would split a paragraph mid-word;
// prefer the nearest paragraph break unless it sits too close to the end.
const STREAMING_TAIL_MIN_CHARS = 64;

/**
 * Tail window of a streaming markdown text. Cuts at a paragraph boundary and
 * re-opens a code fence when the cut lands inside one, so the visible tail
 * still renders as code. Fence counting scans the dropped prefix with
 * `indexOf` (memchr-fast), which is orders of magnitude cheaper than parsing.
 */
export function sliceStreamingMarkdownTail(
  text: string,
  budget = STREAMING_TAIL_BUDGET_CHARS,
): string {
  if (text.length <= budget) return text;
  let cut = text.indexOf("\n\n", text.length - budget);
  if (cut === -1 || cut >= text.length - STREAMING_TAIL_MIN_CHARS) {
    cut = text.length - budget;
  } else {
    cut += 2;
  }
  let fences = 0;
  for (let index = text.indexOf("```"); index !== -1 && index < cut; ) {
    fences += 1;
    index = text.indexOf("```", index + 3);
  }
  const tail = text.slice(cut);
  return fences % 2 === 1 ? `\`\`\`\n${tail}` : `\u2026\n\n${tail}`;
}
