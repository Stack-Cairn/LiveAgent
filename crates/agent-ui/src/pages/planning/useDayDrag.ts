import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { addDays, localEpoch, zonedParts } from "../../lib/planning/time";
import type { EventTime, PlanningEvent } from "../../lib/planning/types";

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Move a time by whole days, keeping the wall-clock times in `zone` (safe across DST). */
export function shiftTime(time: EventTime, days: number, zone: string): EventTime {
  if (time.kind === "allDay")
    return {
      ...time,
      startDate: addDays(time.startDate, days),
      endDateExclusive: addDays(time.endDateExclusive, days),
    };
  const start = zonedParts(time.startAt, zone),
    end = zonedParts(time.endAt, zone);
  return {
    ...time,
    startAt: localEpoch(addDays(start.date, days), start.time, zone),
    endAt: localEpoch(addDays(end.date, days), end.time, zone),
  };
}

/**
 * Drag event chips between day cells (`[data-planning-all-day]`), as in Google's month view
 * and all-day row. A press that does not travel 5px stays a click.
 */
export function useDayDrag({
  zone,
  canDrag,
  onMove,
}: {
  zone: string;
  canDrag(event: PlanningEvent): boolean;
  onMove(event: PlanningEvent, time: EventTime): void;
}) {
  const [dragging, setDragging] = useState<{ id: string; target: string | null } | null>(null);
  const suppressClick = useRef(false);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  const start = (e: ReactPointerEvent, event: PlanningEvent, day: string) => {
    if (e.button !== 0 || !canDrag(event)) return;
    const origin = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    let moved = false;
    let target: string | null = null;
    const dayAt = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-planning-all-day]")?.dataset
        .planningAllDay ?? null;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== origin.pointerId) return;
      if (!moved && Math.hypot(m.clientX - origin.x, m.clientY - origin.y) < 5) return;
      moved = true;
      m.preventDefault();
      target = dayAt(m.clientX, m.clientY);
      setDragging({ id: event.id, target });
    };
    const end = (u: PointerEvent) => {
      if (u.pointerId !== origin.pointerId) return;
      cleanup.current();
      if (!moved) return;
      // The click that follows the drop must not open the preview.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (target && target !== day)
        onMove(event, shiftTime(event.time, daysBetween(day, target), zone));
    };
    const key = (k: KeyboardEvent) => {
      if (k.key === "Escape") cleanup.current();
    };
    const cancel = () => cleanup.current();
    cleanup.current = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", cancel);
      cleanup.current = () => {};
      setDragging(null);
    };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", cancel);
  };
  /** Wrap a chip's click so a finished drag does not also select it. */
  const click = (fn: () => void) => {
    if (!suppressClick.current) fn();
  };
  return { start, click, dragging };
}
