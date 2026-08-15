import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";

// Range extractor that force-mounts every row at or after the live boundary.
// Streaming rows must never unmount mid-run — losing them would drop
// Streamdown parse state and shiki/mermaid output, and remounting a growing
// row mid-stream re-parses everything it has produced so far. Settled rows
// (below the boundary) virtualize normally.
export function extractLiveRange(range: Range, liveStartIndex: number): number[] {
  const base = defaultRangeExtractor(range);
  if (liveStartIndex < 0 || liveStartIndex >= range.count) {
    return base;
  }
  const indexes = new Set(base);
  for (let index = liveStartIndex; index < range.count; index += 1) {
    indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}
