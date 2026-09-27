import type { CSSProperties } from "react";
import { Check, Circle } from "../../components/IconSet";
import { planningDateLocale, translate } from "../../lib/planning/i18n";
import { taskListColor, taskListLayer } from "../../lib/planning/taskLists";
import { addDays, dayStart, eventTitle, timeBounds, zonedParts } from "../../lib/planning/time";
import type { PlanningEvent, PlanningSnapshot, Todo } from "../../lib/planning/types";
import { activeEvent, calendarLayer, lunarDate } from "./calendarDisplay";
import { eventColor } from "./eventAppearance";

type Item =
  | { kind: "event"; key: string; start: number; allDay: boolean; event: PlanningEvent }
  | { kind: "due"; key: string; start: number; allDay: boolean; todo: Todo };

/** Google Calendar's "Schedule" view: one row per item, grouped by day, empty days skipped. */
export function AgendaView({
  days,
  today,
  snapshot,
  hidden,
  showLunar,
  showCompleted,
  onSelect,
  onSelectTodo,
  onOpenDay,
}: {
  days: string[];
  today: string;
  snapshot: PlanningSnapshot;
  hidden: Set<string>;
  showLunar: boolean;
  showCompleted: boolean;
  onSelect(event: PlanningEvent, anchor: HTMLElement): void;
  onSelectTodo(todo: Todo): void;
  onOpenDay(day: string): void;
}) {
  const zone = snapshot.timeZone;
  const now = Date.now();
  const completed = (todoId?: string | null) =>
    snapshot.todos.some((t) => t.id === todoId && t.status === "completed");
  const groups = days
    .map((day) => {
      const from = dayStart(day, zone),
        to = dayStart(addDays(day, 1), zone);
      const items: Item[] = [
        ...snapshot.events
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
          .map((event) => ({
            kind: "event" as const,
            key: event.id,
            start: event.time.kind === "timed" ? Math.max(event.time.startAt, from) : from - 1,
            allDay: event.time.kind === "allDay",
            event,
          })),
        ...snapshot.todos
          .filter(
            (t) =>
              !t.deletedAt &&
              !hidden.has(taskListLayer(t.groupId)) &&
              (showCompleted || t.status === "open") &&
              ((t.dueAt != null && t.dueAt >= from && t.dueAt < to) || t.dueDate === day),
          )
          .map((todo) => ({
            kind: "due" as const,
            key: `due:${todo.id}`,
            start: todo.dueAt ?? from - 1,
            allDay: todo.dueAt == null,
            todo,
          })),
      ].sort((a, b) => a.start - b.start);
      return { day, items };
    })
    .filter((g) => g.items.length || g.day === today);
  return (
    <ol className="planning-agenda" aria-label={translate("planner.view.agenda")}>
      {groups.map(({ day, items }) => {
        const weekday = new Intl.DateTimeFormat(planningDateLocale(), {
          weekday: "short",
          timeZone: "UTC",
        }).format(new Date(`${day}T12:00:00Z`));
        let nowShown = day !== today;
        return (
          <li key={day} className="planning-agenda-day">
            <button
              type="button"
              className={`planning-agenda-date ${day === today ? "is-today" : ""}`}
              aria-label={translate("planner.grid.openDay", { day })}
              onClick={() => onOpenDay(day)}
            >
              <span className="planning-agenda-num">{Number(day.slice(-2))}</span>
              <span className="planning-agenda-meta">
                {translate("planner.agenda.dayMeta", {
                  month: new Intl.DateTimeFormat(planningDateLocale(), {
                    month: "short",
                    timeZone: "UTC",
                  }).format(new Date(`${day}T12:00:00Z`)),
                  weekday,
                })}
                {showLunar && <span className="block">{lunarDate(day)}</span>}
              </span>
            </button>
            <ul className="min-w-0 flex-1">
              {!items.length && (
                <li className="planning-agenda-row text-muted-foreground">
                  {translate("planner.agenda.emptyToday")}
                </li>
              )}
              {items.map((item) => {
                const nowLine = !nowShown && !item.allDay && item.start > now;
                if (nowLine) nowShown = true;
                const done =
                  item.kind === "due"
                    ? item.todo.status === "completed"
                    : completed(item.event.todoId);
                const past = item.kind === "event" ? timeBounds(item.event.time)[1] < now : false;
                const color =
                  item.kind === "event"
                    ? (eventColor(item.event, snapshot) ?? "hsl(var(--muted-foreground))")
                    : taskListColor(item.todo, snapshot);
                const title =
                  item.kind === "event" ? eventTitle(item.event, snapshot.todos) : item.todo.title;
                const time = item.allDay
                  ? translate("planner.allDay")
                  : item.kind === "event" && item.event.time.kind === "timed"
                    ? `${zonedParts(item.event.time.startAt, zone).time} – ${zonedParts(item.event.time.endAt, zone).time}`
                    : zonedParts(item.start, zone).time;
                const isTask = item.kind === "due" || !!item.event.todoId;
                return (
                  <li key={item.key}>
                    {nowLine && (
                      <hr
                        className="planning-agenda-now"
                        aria-label={translate("planner.agenda.now")}
                      />
                    )}
                    <button
                      type="button"
                      className={`planning-agenda-row ${past || done ? "is-past" : ""}`}
                      onClick={(e) =>
                        item.kind === "event"
                          ? onSelect(item.event, e.currentTarget)
                          : onSelectTodo(item.todo)
                      }
                    >
                      {isTask ? (
                        <span
                          className="planning-agenda-dot is-task"
                          style={{ "--planning-accent": color } as CSSProperties}
                        >
                          {done ? (
                            <Check className="planning-task-mark" aria-hidden />
                          ) : (
                            <Circle className="planning-task-mark" aria-hidden />
                          )}
                        </span>
                      ) : (
                        <span className="planning-agenda-dot" style={{ backgroundColor: color }} />
                      )}
                      <span className="w-32 shrink-0 tabular-nums">{time}</span>
                      <span
                        className={`flex min-w-0 items-center gap-1.5 ${done ? "line-through" : ""}`}
                      >
                        {isTask && (
                          <span className="sr-only">{translate("planner.kind.task")}</span>
                        )}
                        <span className="truncate">
                          {item.kind === "due" && !item.allDay
                            ? translate("planner.agenda.due", { title })
                            : title}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {!nowShown && (
                <li>
                  <hr
                    className="planning-agenda-now"
                    aria-label={translate("planner.agenda.now")}
                  />
                </li>
              )}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
