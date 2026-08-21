import type { Range } from "@tanstack/react-virtual";

export const LIVE_RANGE_OVERSCAN_COST_BUDGET = 6;
export const LIVE_RANGE_OVERSCAN_MAX_ROWS = 3;

function normalizedCost(cost: number | undefined) {
  return Number.isFinite(cost) && (cost ?? 0) > 0 ? Math.ceil(cost ?? 1) : 1;
}

function addCostBoundedSide(
  indexes: Set<number>,
  start: number,
  direction: -1 | 1,
  range: Range,
  getCost: (index: number) => number | undefined,
) {
  let index = start;
  let remaining = LIVE_RANGE_OVERSCAN_COST_BUDGET;
  let added = 0;
  while (index >= 0 && index < range.count && added < LIVE_RANGE_OVERSCAN_MAX_ROWS) {
    indexes.add(index);
    added += 1;
    remaining -= normalizedCost(getCost(index));
    if (remaining <= 0) break;
    index += direction;
  }
}

// Range extractor that force-mounts every row at or after the live boundary.
// Streaming rows must never unmount mid-run — losing them would drop
// Streamdown parse state and shiki/mermaid output, and remounting a growing
// row mid-stream re-parses everything it has produced so far. Settled rows
// (below the boundary) virtualize normally.
export function extractLiveRange(
  range: Range,
  liveStartIndex: number,
  getCost: (index: number) => number | undefined = () => 1,
): number[] {
  const start = Math.max(0, range.startIndex);
  const end = Math.min(range.count - 1, range.endIndex);
  const base = new Set<number>();
  for (let index = start; index <= end; index += 1) base.add(index);
  addCostBoundedSide(base, start - 1, -1, range, getCost);
  addCostBoundedSide(base, end + 1, 1, range, getCost);
  if (liveStartIndex < 0 || liveStartIndex >= range.count) {
    return [...base].sort((a, b) => a - b);
  }
  for (let index = liveStartIndex; index < range.count; index += 1) {
    base.add(index);
  }
  return [...base].sort((a, b) => a - b);
}
