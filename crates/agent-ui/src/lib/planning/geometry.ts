import { HOUR, MINUTE, timeBounds } from "./time";
import type { EventTime, PlanningEvent } from "./types";
export const SNAP_MINUTES = 15;
export type DragKind = "todo" | "create" | "move" | "start" | "end";
export interface DragState {
  kind: DragKind;
  pointerId: number;
  originX: number;
  originY: number;
  original?: Extract<EventTime, { kind: "timed" }>;
  grabOffsetMs: number;
  event?: PlanningEvent;
  todoId?: string;
  durationMinutes: number;
}
export function snapDelta(milliseconds: number) {
  return Math.round(milliseconds / (SNAP_MINUTES * MINUTE)) * SNAP_MINUTES * MINUTE;
}
export function dragTime(
  drag: DragState,
  targetEpoch: number,
  zone: string,
): Extract<EventTime, { kind: "timed" }> {
  if (!drag.original) {
    const startAt = Math.round(targetEpoch / (15 * MINUTE)) * 15 * MINUTE;
    return {
      kind: "timed",
      startAt,
      endAt: startAt + Math.max(15, drag.durationMinutes) * MINUTE,
      timeZone: zone,
    };
  }
  const t = drag.original;
  if (drag.kind === "move") {
    const delta = snapDelta(targetEpoch - drag.grabOffsetMs - t.startAt);
    return { ...t, startAt: t.startAt + delta, endAt: t.endAt + delta };
  }
  if (drag.kind === "start")
    return {
      ...t,
      startAt: Math.min(t.endAt - 15 * MINUTE, t.startAt + snapDelta(targetEpoch - t.startAt)),
    };
  return {
    ...t,
    endAt: Math.max(t.startAt + 15 * MINUTE, t.endAt + snapDelta(targetEpoch - t.endAt)),
  };
}
export interface EventPlacement {
  event: PlanningEvent;
  top: number;
  height: number;
  column: number;
  columns: number;
  /** Columns to the right that are free for this block's whole duration (Google-style expansion). */
  span: number;
  startsHere: boolean;
  endsHere: boolean;
}
export function layoutEvents(
  events: readonly PlanningEvent[],
  from: number,
  to: number,
  hourHeight: number,
): EventPlacement[] {
  const timed = events
    .filter((e) => e.time.kind === "timed")
    .map((event) => ({ event, bounds: timeBounds(event.time) }))
    .filter(({ bounds: [s, e] }) => s < to && e > from)
    // Same start: the longer item takes the left column (Google), so a task chip that shares a
    // start with an event sits to its right.
    .sort(
      (a, b) =>
        a.bounds[0] - b.bounds[0] ||
        b.bounds[1] - a.bounds[1] ||
        a.event.id.localeCompare(b.event.id),
    );
  const result: EventPlacement[] = [];
  let cluster: (EventPlacement & { start: number; end: number })[] = [];
  let ends: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const placement of cluster) {
      placement.columns = ends.length;
      let span = 1;
      for (let next = placement.column + 1; next < ends.length; next++) {
        const blocked = cluster.some(
          (other) =>
            other.column === next && other.start < placement.end && other.end > placement.start,
        );
        if (blocked) break;
        span++;
      }
      placement.span = span;
    }
    result.push(...cluster.map(({ start: _start, end: _end, ...placement }) => placement));
    cluster = [];
    ends = [];
  };
  for (const {
    event,
    bounds: [start, end],
  } of timed) {
    if (start >= clusterEnd) flush();
    let column = ends.findIndex((previous) => previous <= start);
    if (column < 0) column = ends.length;
    ends[column] = end;
    clusterEnd = Math.max(cluster.length ? clusterEnd : -Infinity, end);
    cluster.push({
      start,
      end,
      span: 1,
      event,
      top: ((Math.max(start, from) - from) / HOUR) * hourHeight,
      height: ((Math.min(end, to) - Math.max(start, from)) / HOUR) * hourHeight,
      column,
      columns: 1,
      startsHere: start >= from,
      endsHere: end <= to,
    });
  }
  flush();
  return result;
}
export function edgeScroll(y: number, top: number, bottom: number) {
  if (y < top + 32) return -Math.min(14, Math.max(0, (top + 32 - y) / 2));
  if (y > bottom - 32) return Math.min(14, Math.max(0, (y - bottom + 32) / 2));
  return 0;
}
