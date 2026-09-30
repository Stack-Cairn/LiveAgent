import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Check, Circle } from "../../components/IconSet";
import { isCronEvent } from "../../lib/planning/cronLayer";
import { planningDateLocale, translate } from "../../lib/planning/i18n";
import { taskListColor, taskListLayer } from "../../lib/planning/taskLists";
import { addDays, dayStart, eventTitle, timeBounds, zonedParts } from "../../lib/planning/time";
import type { EventTime, PlanningEvent, PlanningSnapshot, Todo } from "../../lib/planning/types";
import { activeEvent, calendarLayer, isoWeek, lunarDate } from "./calendarDisplay";
import { eventAppearance, eventColor, taskAppearance } from "./eventAppearance";
import { useDayDrag } from "./useDayDrag";

// Row chrome: weekday (first row), date button and padding; each item is 22px + 2px gap.
const ROW_CHROME = 34;
const ITEM_HEIGHT = 24;
const MIN_ITEMS = 2;

export function MonthGrid({
  days,
  date,
  today,
  zone,
  snapshot,
  hidden,
  hoverDay,
  showLunar,
  showCompleted,
  showWeekNumbers,
  onSelect,
  onSelectTodo,
  onOpenDay,
  onCreate,
  onMove,
}: {
  days: string[];
  date: string;
  today: string;
  zone: string;
  snapshot: PlanningSnapshot;
  hidden: Set<string>;
  hoverDay: string | null;
  showLunar: boolean;
  showCompleted: boolean;
  showWeekNumbers: boolean;
  onSelect(event: PlanningEvent, anchor: HTMLElement): void;
  onSelectTodo(todo: Todo): void;
  onOpenDay(day: string): void;
  onCreate(time: EventTime, anchor: Element): void;
  /** Dropping a chip on another day moves it there, keeping its clock time. */
  onMove(event: PlanningEvent, time: EventTime): void;
}) {
  const now = Date.now();
  const allDay = (day: string): EventTime => ({
    kind: "allDay",
    startDate: day,
    endDateExclusive: addDays(day, 1),
    timeZone: zone,
  });
  const drag = useDayDrag({
    zone,
    canDrag: (e) =>
      !isCronEvent(e) && !snapshot.calendars.find((c) => c.id === e.calendarId)?.readOnly,
    onMove,
  });
  const completed = (todoId?: string | null) =>
    snapshot.todos.some((t) => t.id === todoId && t.status === "completed");
  const weeks = Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
  // Like Google Calendar, fit as many items as the cell height allows before "N more".
  const grid = useRef<HTMLDivElement>(null);
  const [maxItems, setMaxItems] = useState(4);
  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const measure = () => {
      const rowHeight = element.clientHeight / Math.max(1, weeks.length);
      setMaxItems(Math.max(MIN_ITEMS, Math.floor((rowHeight - ROW_CHROME) / ITEM_HEIGHT)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [weeks.length]);
  return (
    <div
      ref={grid}
      className="planning-month"
      style={{
        gridTemplateColumns: `${showWeekNumbers ? "1.5rem " : ""}repeat(7, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${weeks.length}, minmax(6rem, 1fr))`,
      }}
    >
      {weeks.map((week, row) => [
        showWeekNumbers && (
          <span key={`w${week[0]}`} className="planning-month-week">
            {isoWeek(week[0])}
          </span>
        ),
        ...week.map((day) => {
          const from = dayStart(day, zone),
            to = dayStart(addDays(day, 1), zone);
          const events = snapshot.events
            .filter((e) => {
              const [start, end] = timeBounds(e.time);
              return (
                activeEvent(e, snapshot) &&
                !hidden.has(calendarLayer(e, snapshot)) &&
                (showCompleted || !completed(e.todoId)) &&
                start < to &&
                end > from
              );
            })
            .sort(
              (a, b) =>
                Number(b.time.kind === "allDay") - Number(a.time.kind === "allDay") ||
                timeBounds(a.time)[0] - timeBounds(b.time)[0],
            );
          const due = snapshot.todos.filter(
            (t) =>
              !t.deletedAt &&
              !hidden.has(taskListLayer(t.groupId)) &&
              (showCompleted || t.status === "open") &&
              ((t.dueAt != null && t.dueAt >= from && t.dueAt < to) || t.dueDate === day),
          );
          const total = events.length + due.length;
          const limit = total > maxItems ? maxItems - 1 : maxItems;
          const weekday = new Intl.DateTimeFormat(planningDateLocale(), {
            weekday: "short",
            timeZone: "UTC",
          }).format(new Date(`${day}T12:00:00Z`));
          return (
            // A single click on empty cell space starts quick create, as in Google's month view;
            // keyboard users get the equivalent visually hidden button inside the cell.
            // biome-ignore lint/a11y/useKeyWithClickEvents: the sr-only button is the keyboard path
            <fieldset
              key={day}
              aria-label={translate("planner.month.cell", { day })}
              data-planning-all-day={day}
              className={`planning-month-cell ${hoverDay === day || drag.dragging?.target === day ? "planning-all-day-target" : ""} ${day === today ? "is-today" : ""} ${day.slice(0, 7) !== date.slice(0, 7) ? "is-outside" : ""}`}
              onClick={(e) => {
                if (e.target === e.currentTarget) onCreate(allDay(day), e.currentTarget);
              }}
            >
              {row === 0 && <small className="planning-month-weekday">{weekday}</small>}
              <button
                type="button"
                className="sr-only focus:not-sr-only"
                onClick={(e) => {
                  const cell = e.currentTarget.parentElement;
                  if (cell) onCreate(allDay(day), cell);
                }}
              >
                {translate("planner.grid.newAllDayOf", { day })}
              </button>
              <button
                type="button"
                aria-label={translate("planner.grid.openDay", { day })}
                className="planning-month-date"
                onClick={() => onOpenDay(day)}
              >
                <span className="planning-month-num">
                  {day.slice(8) === "01"
                    ? new Intl.DateTimeFormat(planningDateLocale(), {
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      }).format(new Date(`${day}T12:00:00Z`))
                    : Number(day.slice(8))}
                </span>
                {showLunar && <span className="text-muted-foreground">{lunarDate(day)}</span>}
              </button>
              {events.slice(0, limit).map((e) => {
                const color = eventColor(e, snapshot);
                const isPast = timeBounds(e.time)[1] < now;
                const done = completed(e.todoId);
                const mark = e.todoId ? (
                  done ? (
                    <Check
                      key="mark"
                      className="planning-task-mark"
                      aria-label={translate("planner.status.completed")}
                    />
                  ) : (
                    <Circle
                      key="mark"
                      className="planning-task-mark"
                      aria-label={translate("planner.kind.task")}
                    />
                  )
                ) : null;
                return e.time.kind === "allDay" ? (
                  <button
                    type="button"
                    key={e.id}
                    className={`planning-month-event is-filled ${drag.dragging?.id === e.id ? "is-dragging" : ""} ${e.todoId ? "planning-task-chip" : ""} ${isCronEvent(e) ? "planning-event-cron" : ""} ${isPast ? "is-past" : ""} ${done ? "is-completed" : ""}`}
                    title={eventTitle(e, snapshot.todos)}
                    style={
                      e.todoId
                        ? taskAppearance(color, "task", isPast)
                        : eventAppearance(color, isPast)
                    }
                    onPointerDown={(down) => drag.start(down, e, day)}
                    onClick={(click) => {
                      const anchor = click.currentTarget;
                      drag.click(() => onSelect(e, anchor));
                    }}
                  >
                    {mark}
                    <span className="truncate">{eventTitle(e, snapshot.todos)}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    key={e.id}
                    className={`planning-month-event ${drag.dragging?.id === e.id ? "is-dragging" : ""} ${isCronEvent(e) ? "planning-event-cron" : ""} ${isPast ? "is-past" : ""} ${done ? "is-completed" : ""}`}
                    title={eventTitle(e, snapshot.todos)}
                    style={e.todoId ? ({ "--planning-accent": color } as CSSProperties) : undefined}
                    onPointerDown={(down) => drag.start(down, e, day)}
                    onClick={(click) => {
                      const anchor = click.currentTarget;
                      drag.click(() => onSelect(e, anchor));
                    }}
                  >
                    {mark ?? (
                      <span className="planning-month-dot" style={{ backgroundColor: color }} />
                    )}
                    <span className="shrink-0 tabular-nums">
                      {zonedParts(Math.max(e.time.startAt, from), zone).time}
                    </span>
                    <span className="truncate">{eventTitle(e, snapshot.todos)}</span>
                  </button>
                );
              })}
              {due.slice(0, Math.max(0, limit - events.length)).map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={`planning-month-event planning-month-deadline ${(t.dueAt ?? to) < now ? "is-past" : ""} ${t.status === "completed" ? "is-completed" : ""}`}
                  style={taskAppearance(
                    taskListColor(t, snapshot),
                    "deadline",
                    (t.dueAt ?? to) < now,
                  )}
                  title={translate("planner.task.rowLabel", { title: t.title })}
                  onClick={() => onSelectTodo(t)}
                >
                  {t.status === "completed" ? (
                    <Check
                      key="mark"
                      className="planning-task-mark"
                      aria-label={translate("planner.status.completed")}
                    />
                  ) : (
                    <Circle
                      key="mark"
                      className="planning-task-mark"
                      aria-label={translate("planner.kind.task")}
                    />
                  )}
                  <span className="truncate">{t.title}</span>
                  <span className="planning-deadline-time">
                    {t.dueAt != null
                      ? translate("planner.grid.dueAt", { time: zonedParts(t.dueAt, zone).time })
                      : translate("planner.month.due")}
                  </span>
                </button>
              ))}
              {total > limit && (
                <button
                  type="button"
                  className="planning-month-more"
                  onClick={() => onOpenDay(day)}
                >
                  {translate("planner.month.more", { count: total - limit })}
                </button>
              )}
            </fieldset>
          );
        }),
      ])}
    </div>
  );
}
