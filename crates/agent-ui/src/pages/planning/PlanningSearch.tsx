import { useMemo, useState } from "react";
import { Circle, Search } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { SearchHighlight } from "../../components/ui/search-highlight";
import { planningDateLocale } from "../../lib/planning/i18n";
import { taskListColor } from "../../lib/planning/taskLists";
import { eventTitle, timeBounds, timeLabel, zonedParts } from "../../lib/planning/time";
import type { PlanningEvent, PlanningSnapshot, Todo } from "../../lib/planning/types";
import { activeEvent } from "./calendarDisplay";
import { eventColor } from "./eventAppearance";
import { usePlanningT } from "./usePlanningT";

const LIMIT = 30;

/** Title and notes search over events and tasks, like Google Calendar's toolbar search. */
export function PlanningSearch({
  snapshot,
  open,
  onOpenChange,
  onOpenEvent,
  onOpenTodo,
}: {
  snapshot: PlanningSnapshot;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** `date` is the occurrence to show: the next one for recurring events. */
  onOpenEvent(event: PlanningEvent, date: string): void;
  onOpenTodo(todo: Todo): void;
}) {
  const { t, locale } = usePlanningT();
  const [query, setQuery] = useState("");
  const zone = snapshot.timeZone;
  const needle = query.trim().toLocaleLowerCase();
  const results = useMemo(() => {
    if (!needle) return null;
    const hit = (...texts: (string | null | undefined)[]) =>
      texts.some((text) => text?.toLocaleLowerCase().includes(needle));
    const now = Date.now();
    const events = (snapshot.eventMasters ?? snapshot.events)
      .filter(
        (e) =>
          !e.todoId &&
          !e.seriesId &&
          activeEvent(e, snapshot) &&
          hit(eventTitle(e, snapshot.todos), e.notes),
      )
      .map((e) => {
        // Recurring events jump to the next loaded occurrence when there is one.
        const next = e.recurrence
          ? snapshot.events
              .filter((i) => i.seriesId === e.id && timeBounds(i.time)[1] >= now)
              .sort((a, b) => timeBounds(a.time)[0] - timeBounds(b.time)[0])[0]
          : undefined;
        return { event: e, shown: next ?? e };
      })
      .sort(
        (a, b) =>
          Math.abs(timeBounds(a.shown.time)[0] - now) - Math.abs(timeBounds(b.shown.time)[0] - now),
      );
    const todos = snapshot.todos
      .filter((todo) => !todo.deletedAt && hit(todo.title, todo.notes))
      .sort((a, b) => Number(a.status === "completed") - Number(b.status === "completed"));
    return { events: events.slice(0, LIMIT), todos: todos.slice(0, LIMIT) };
  }, [needle, snapshot]);
  const dayOf = (event: PlanningEvent) =>
    event.time.kind === "timed" ? zonedParts(event.time.startAt, zone).date : event.time.startDate;
  const dateLabel = (day: string) =>
    new Intl.DateTimeFormat(planningDateLocale(locale), {
      year: "numeric",
      month: "short",
      day: "numeric",
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(`${day}T12:00:00Z`));
  const close = (run: () => void) => {
    onOpenChange(false);
    setQuery("");
    run();
  };
  const row = "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-accent";
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost" size="icon" className="rounded-full" />}
        aria-label={t("planner.search.label")}
        title={`${t("planner.search.label")} (/)`}
      >
        <Search className="size-5" />
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={t("planner.search.label")} className="w-96 p-2">
        <Input
          autoFocus
          variant="plain"
          type="search"
          value={query}
          placeholder={t("planner.search.placeholder")}
          aria-label={t("planner.search.label")}
          onChange={(e) => setQuery(e.target.value)}
        />
        {results && (
          <div className="mt-2 max-h-[60dvh] space-y-3 overflow-y-auto">
            {results.events.length === 0 && results.todos.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-sm">
                <p className="text-muted-foreground">
                  {t("planner.search.empty", { query: query.trim() })}
                </p>
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  {t("planner.search.clear")}
                </Button>
              </div>
            ) : null}
            {results.events.length > 0 && (
              <section aria-label={t("planner.kind.event")}>
                <h3 className="px-2 pb-1 text-xs text-muted-foreground">
                  {t("planner.kind.event")}
                </h3>
                {results.events.map(({ event, shown }) => (
                  <button
                    type="button"
                    key={event.id}
                    className={row}
                    onClick={() => close(() => onOpenEvent(event, dayOf(shown)))}
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: eventColor(event, snapshot) }}
                    />
                    <span className="min-w-0 flex-1">
                      <SearchHighlight
                        className="block truncate text-sm"
                        text={eventTitle(event, snapshot.todos)}
                        query={query.trim()}
                      />
                      <span className="block truncate text-xs text-muted-foreground">
                        {dateLabel(dayOf(shown))}
                        {shown.time.kind === "timed"
                          ? ` · ${timeLabel(shown.time, zone).split(" · ")[0]}`
                          : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </section>
            )}
            {results.todos.length > 0 && (
              <section aria-label={t("planner.kind.task")}>
                <h3 className="px-2 pb-1 text-xs text-muted-foreground">
                  {t("planner.kind.task")}
                </h3>
                {results.todos.map((todo) => (
                  <button
                    type="button"
                    key={todo.id}
                    className={row}
                    onClick={() => close(() => onOpenTodo(todo))}
                  >
                    <Circle
                      className="size-3 shrink-0"
                      style={{ color: taskListColor(todo, snapshot) }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <SearchHighlight
                        className={`block truncate text-sm ${todo.status === "completed" ? "text-muted-foreground line-through" : ""}`}
                        text={todo.title}
                        query={query.trim()}
                      />
                      {(todo.dueDate || todo.dueAt != null) && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {t("planner.search.due", {
                            date: dateLabel(todo.dueDate ?? zonedParts(todo.dueAt ?? 0, zone).date),
                          })}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </section>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
