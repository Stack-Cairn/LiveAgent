import type { TrajectoryTimeRange } from "./timeline";

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function normalizeTimelineViewport(
  model: TrajectoryTimeRange,
  range: TrajectoryTimeRange | null,
): TrajectoryTimeRange {
  if (range === null) return model;
  const lower = clamp(Math.min(range.start, range.end), model.start, model.end);
  const upper = clamp(Math.max(range.start, range.end), model.start, model.end);
  return upper > lower ? { start: lower, end: upper } : model;
}

export function zoomTimelineViewport(params: {
  model: TrajectoryTimeRange;
  viewport: TrajectoryTimeRange;
  anchorFraction: number;
  wheelDeltaY: number;
  minimumSpan: number;
}): TrajectoryTimeRange | null {
  const fullSpan = params.model.end - params.model.start;
  const currentSpan = params.viewport.end - params.viewport.start;
  if (!(fullSpan > 0) || !(currentSpan > 0)) return null;
  const factor = Math.exp(params.wheelDeltaY * 0.0015);
  const nextSpan = clamp(currentSpan * factor, params.minimumSpan, fullSpan);
  if (nextSpan >= fullSpan * 0.999999) return null;

  const anchorFraction = clamp(params.anchorFraction, 0, 1);
  const anchor = params.viewport.start + currentSpan * anchorFraction;
  let start = anchor - nextSpan * anchorFraction;
  let end = start + nextSpan;
  if (start < params.model.start) {
    start = params.model.start;
    end = start + nextSpan;
  }
  if (end > params.model.end) {
    end = params.model.end;
    start = end - nextSpan;
  }
  return { start, end };
}
