type Row = { key: string; estimate: number; gapAfter: number };
type Measurement = { key: string | number | bigint; size: number };

export type TranscriptScrollPosition = {
  offset: number;
  following: boolean;
  anchorKey?: string | number | bigint;
  anchorOffset?: number;
  anchorViewportTop?: number;
};
const positions = new Map<string, TranscriptScrollPosition>();
export function readTranscriptScrollPosition(id: string) {
  return positions.get(id);
}
export function saveTranscriptScrollPosition(id: string, value: TranscriptScrollPosition) {
  positions.delete(id);
  positions.set(id, value);
  const oldest = positions.keys().next().value;
  if (positions.size > 100 && oldest !== undefined) positions.delete(oldest);
}

// Seed the first virtual range at the tail, rather than rendering the first
// messages and correcting to the bottom after the browser has painted.
export function initialTranscriptLayout(
  rows: readonly Row[],
  measurements: readonly Measurement[],
  viewportHeight: number,
  position?: TranscriptScrollPosition,
) {
  const sizes = new Map(measurements.map((item) => [item.key, item.size]));
  const heights = rows.map(
    (row, index) =>
      sizes.get(row.key) ?? row.estimate + (index < rows.length - 1 ? row.gapAfter : 0),
  );
  const total = heights.reduce((sum, height) => sum + height, 0);
  let offset = Math.max(0, total - viewportHeight);
  if (position && !position.following) {
    const index = rows.findIndex((row) => row.key === position.anchorKey);
    offset =
      index < 0
        ? position.offset
        : heights.slice(0, index).reduce((sum, height) => sum + height, 0) +
          (position.anchorOffset ?? 0);
    offset = Math.max(0, Math.min(offset, Math.max(0, total - viewportHeight)));
  }
  let start = 0;
  let measuredViewport = viewportHeight > 0 && rows.length > 0;
  for (let index = 0; index < rows.length && start < offset + viewportHeight; index++) {
    const end = start + heights[index];
    if (end > offset && !sizes.has(rows[index].key)) measuredViewport = false;
    start = end;
  }
  return { offset, measuredViewport };
}
