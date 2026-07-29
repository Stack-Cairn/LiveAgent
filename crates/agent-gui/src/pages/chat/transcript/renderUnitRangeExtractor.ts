import type { Range } from "@tanstack/react-virtual";

export const TRANSCRIPT_OVERSCAN_COST_BUDGET = 8;
export const TRANSCRIPT_OVERSCAN_MAX_UNITS = 5;

function normalizedCost(cost: number | undefined) {
  return Number.isFinite(cost) && (cost ?? 0) > 0 ? Math.ceil(cost ?? 1) : 1;
}

function addCostBoundedSide(
  indexes: Set<number>,
  start: number,
  direction: -1 | 1,
  count: number,
  getCost: (index: number) => number | undefined,
  budget: number,
  maxUnits: number,
) {
  let index = start;
  let remaining = budget;
  let added = 0;
  while (index >= 0 && index < count && added < maxUnits) {
    indexes.add(index);
    added += 1;
    remaining -= normalizedCost(getCost(index));
    if (remaining <= 0) break;
    index += direction;
  }
}

// Keeps one warm neighbor on each side, then spends a small render-cost
// budget. A giant Markdown unit therefore consumes the budget alone instead
// of dragging four more expensive offscreen siblings into WKWebView.
export function extractRenderUnitRange(
  range: Range,
  getCost: (index: number) => number | undefined,
  liveTailIndex: number,
  budget = TRANSCRIPT_OVERSCAN_COST_BUDGET,
  maxUnits = TRANSCRIPT_OVERSCAN_MAX_UNITS,
): number[] {
  const indexes = new Set<number>();
  const start = Math.max(0, range.startIndex);
  const end = Math.min(range.count - 1, range.endIndex);
  for (let index = start; index <= end; index += 1) indexes.add(index);

  addCostBoundedSide(indexes, start - 1, -1, range.count, getCost, budget, maxUnits);
  addCostBoundedSide(indexes, end + 1, 1, range.count, getCost, budget, maxUnits);

  if (liveTailIndex >= 0 && liveTailIndex < range.count) indexes.add(liveTailIndex);
  return [...indexes].sort((left, right) => left - right);
}
