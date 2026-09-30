import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, CheckCircle2, Circle } from "../../components/IconSet";
import { isCronEvent } from "../../lib/planning/cronLayer";
import { type DragState, dragTime, edgeScroll, layoutEvents } from "../../lib/planning/geometry";
import { planningDateLocale, translate } from "../../lib/planning/i18n";
import { DEFAULT_TASK_COLOR, taskListColor, taskListLayer } from "../../lib/planning/taskLists";
import {
  addDays,
  dayStart,
  eventTitle,
  HOUR,
  localCandidates,
  MINUTE,
  timeLabel,
  zonedParts,
} from "../../lib/planning/time";
import type { EventTime, PlanningEvent, PlanningSnapshot, Todo } from "../../lib/planning/types";
import { activeEvent, calendarLayer, lunarDate, zoneOffset } from "./calendarDisplay";
import { eventAppearance, eventColor, taskAppearance } from "./eventAppearance";
import { useDayDrag } from "./useDayDrag";

const GUTTER = 56;
const DEADLINE_PREFIX = "deadline:";
/** Text line height inside blocks (text-xs / 1rem) plus vertical padding. */
const LINE_HEIGHT = 16;
/** Below this width per overlapping block, blocks cascade instead of splitting into columns. */
const MIN_SPLIT_WIDTH = 32;
const CASCADE_OFFSET = 14;
/** Deadlines render as one-line chips (Google task chips) floating above events. */
const CHIP_HEIGHT = 22;
const BLOCK_PADDING = 8;
/** How many wrapped title lines fit, leaving one line for the time when there is room. */
function titleLines(height: number, reserveTimeLine: boolean) {
  const lines = Math.max(1, Math.floor((height - BLOCK_PADDING) / LINE_HEIGHT));
  return Math.max(1, reserveTimeLine ? lines - 1 : lines);
}

function TaskMark({ todo }: { todo?: Todo }) {
  return todo?.status === "completed" ? (
    <Check className="planning-task-mark" aria-label={translate("planner.status.completed")} />
  ) : (
    <Circle className="planning-task-mark" aria-label={translate("planner.kind.task")} />
  );
}

/**
 * Run after the click that follows this pointerup. A popover opened any earlier would treat
 * that click as an outside press and close immediately (the quick-create card did).
 */
function afterClick(run: () => void) {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    document.removeEventListener("click", onClick, true);
    run();
  };
  const onClick = () => setTimeout(fire, 0);
  document.addEventListener("click", onClick, true);
  // A drag that ends outside where it started produces no click at all.
  setTimeout(fire, 120);
}

/** The same local time `days` calendar days later (not a fixed 24 hours across DST). */
function shiftDays(epoch: number, days: number, zone: string) {
  const { date, time } = zonedParts(epoch, zone);
  return localCandidates(addDays(date, days), time, zone)[0] ?? epoch + days * 24 * HOUR;
}

export interface PlanningDragStart {
  todo: Todo;
  pointerId: number;
  x: number;
  y: number;
}
interface Props {
  days: string[];
  snapshot: PlanningSnapshot;
  hourHeight: number;
  /** Visible wall-clock hours [start, end); null shows the full day. */
  workHours: [number, number] | null;
  hidden: Set<string>;
  showLunar: boolean;
  showCompleted: boolean;
  todoDrag: PlanningDragStart | null;
  onDragEnd(): void;
  onSelect(event: PlanningEvent, anchor: HTMLElement): void;
  onSelectTodo(todo: Todo): void;
  onOpenDay(day: string): void;
  onOpenTasks(): void;
  today: string;
  onCreate(time: EventTime): void;
  onInteractionChange(active: boolean): void;
  nowRequest: number;
  /** The item being quick-created, drawn as a placeholder block the card anchors to. */
  draft: { time: EventTime; title: string; task: boolean } | null;
  onDraftElement(element: HTMLElement | null): void;
  onCommit(
    event: PlanningEvent | undefined,
    todoId: string | undefined,
    time: EventTime,
  ): Promise<void>;
}
export function TimeGrid({
  days,
  snapshot,
  hourHeight: preferredHourHeight,
  workHours,
  hidden,
  showLunar,
  showCompleted,
  todoDrag,
  onDragEnd,
  onSelect,
  onSelectTodo,
  onOpenDay,
  onOpenTasks,
  today,
  onCreate,
  onCommit,
  onInteractionChange,
  nowRequest,
  draft,
  onDraftElement,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [viewHeight, setViewHeight] = useState(0);
  const columns = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<DragState | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const previewRef = useRef<EventTime | null>(null);
  const [preview, setPreview] = useState<EventTime | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const zone = snapshot.timeZone;
  const callbacks = useRef({ onCommit, onDragEnd, onCreate, onInteractionChange });
  // All-day chips move between days in the all-day row.
  const dayDrag = useDayDrag({
    zone,
    canDrag: (e) =>
      e.time.kind === "allDay" &&
      !isCronEvent(e) &&
      !snapshot.calendars.find((c) => c.id === e.calendarId)?.readOnly,
    onMove: (event, time) => void onCommit(event, undefined, time),
  });
  callbacks.current = { onCommit, onDragEnd, onCreate, onInteractionChange };
  const previousDensity = useRef<number | null>(null);
  const visible = snapshot.events.filter(
    (e) =>
      activeEvent(e, snapshot) &&
      !hidden.has(calendarLayer(e, snapshot)) &&
      (showCompleted || !snapshot.todos.some((t) => t.id === e.todoId && t.status === "completed")),
  );
  const now = Date.now();
  const timedPast = (e: PlanningEvent) => e.time.kind === "timed" && e.time.endAt < now;
  const allDayPast = (e: PlanningEvent) =>
    e.time.kind === "allDay" && e.time.endDateExclusive <= today;
  const overdue = snapshot.todos.filter(
    (t) =>
      !t.deletedAt &&
      t.status === "open" &&
      !hidden.has(taskListLayer(t.groupId)) &&
      ((t.dueDate != null && t.dueDate < today) ||
        (t.dueAt != null && t.dueAt < dayStart(today, zone))),
  );
  const dueTodos = snapshot.todos.filter(
    (t) =>
      !hidden.has(taskListLayer(t.groupId)) &&
      !t.deletedAt &&
      (showCompleted || t.status === "open") &&
      t.dueAt != null,
  );
  const [startHour, endHour] = workHours ?? [0, 24];
  const rangeOf = (day: string): [number, number] => {
    const at = (hour: number) =>
      hour >= 24
        ? dayStart(addDays(day, 1), zone)
        : hour <= 0
          ? dayStart(day, zone)
          : (localCandidates(day, `${String(hour).padStart(2, "0")}:00`, zone)[0] ??
            dayStart(day, zone) + hour * HOUR);
    return [at(startHour), at(endHour)];
  };
  const rangeRef = useRef(rangeOf);
  rangeRef.current = rangeOf;
  // The quick-create card anchors to the draft's first visible piece.
  const draftTime = draft?.time;
  const draftDay =
    draftTime &&
    days.find((day) => {
      if (draftTime.kind === "allDay")
        return draftTime.startDate <= day && draftTime.endDateExclusive > day;
      const [from, to] = rangeOf(day);
      return draftTime.startAt < to && draftTime.endAt > from;
    });
  const draftStyle = eventAppearance(
    draft?.task
      ? (snapshot.groups?.find((g) => g.id === snapshot.defaultGroupId)?.color ??
          DEFAULT_TASK_COLOR)
      : snapshot.calendars.find((c) => c.isDefault)?.color,
  );
  const draftTitle = draft?.title.trim() || translate("planner.quick.untitled");
  const hours = Math.max(
    ...days.map((day) => {
      const [start, end] = rangeOf(day);
      return (end - start) / HOUR;
    }),
  );
  // The density is a minimum: short ranges (working hours, tall windows) fill the visible height.
  const hourHeight = viewHeight
    ? Math.max(preferredHourHeight, Math.floor(viewHeight / hours))
    : preferredHourHeight;
  // Header rows must reserve exactly the scroll area's scrollbar width, which varies by platform.
  const [scrollbar, setScrollbar] = useState(0);
  const [viewWidth, setViewWidth] = useState(0);
  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    const measure = () => {
      setScrollbar(view.offsetWidth - view.clientWidth);
      setViewHeight(view.clientHeight);
      setViewWidth(view.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(view);
    // Content height decides whether a scrollbar exists at all (e.g. short working hours).
    if (view.firstElementChild) observer.observe(view.firstElementChild);
    return () => observer.disconnect();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: startHour only seeds the first scroll position
  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    view.scrollTop =
      previousDensity.current === null
        ? Math.max(0, 8 - startHour) * hourHeight
        : ((view.scrollTop + view.clientHeight / 2) / previousDensity.current) * hourHeight -
          view.clientHeight / 2;
    previousDensity.current = hourHeight;
  }, [hourHeight]);
  useEffect(() => {
    if (!nowRequest || !viewport.current) return;
    const today = zonedParts(Date.now(), zone).date;
    const epoch = Date.now() - rangeRef.current(today)[0];
    viewport.current.scrollTop = (epoch / HOUR) * hourHeight - viewport.current.clientHeight / 2;
  }, [nowRequest, zone, hourHeight]);
  useEffect(() => {
    if (!todoDrag || pending) return;
    drag.current = {
      kind: "todo",
      pointerId: todoDrag.pointerId,
      originX: todoDrag.x,
      originY: todoDrag.y,
      grabOffsetMs: 0,
      todoId: todoDrag.todo.id,
      durationMinutes: todoDrag.todo.estimateMinutes ?? 60,
    };
    setDraggingId(todoDrag.todo.id);
    moved.current = false;
    callbacks.current.onInteractionChange(true);
  }, [todoDrag, pending]);
  useEffect(() => {
    const target = (x: number, y: number) => {
      if (drag.current?.kind === "todo") {
        const allDay = document
          .elementFromPoint(x, y)
          ?.closest<HTMLElement>("[data-planning-all-day]")?.dataset.planningAllDay;
        if (allDay)
          return {
            kind: "allDay" as const,
            startDate: allDay,
            endDateExclusive: addDays(allDay, 1),
            timeZone: zone,
          };
      }
      const view = viewport.current;
      if (!view) return null;
      const bounds = view.getBoundingClientRect();
      if (y < bounds.top || y > bounds.bottom) return null;
      for (const [day, element] of columns.current) {
        const rect = element.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right) {
          const [start, end] = rangeRef.current(day);
          return Math.min(
            end - MINUTE,
            Math.max(start, start + ((y - rect.top) / hourHeight) * HOUR),
          );
        }
      }
      return null;
    };
    const update = (x: number, y: number) => {
      const d = drag.current;
      if (!d) return;
      if (Math.hypot(x - d.originX, y - d.originY) > 5) moved.current = true;
      const epoch = target(x, y);
      previewRef.current =
        epoch === null
          ? null
          : typeof epoch !== "number"
            ? epoch
            : d.kind === "create"
              ? {
                  kind: "timed",
                  startAt: Math.min(
                    d.grabOffsetMs,
                    Math.floor(epoch / (15 * MINUTE)) * 15 * MINUTE,
                  ),
                  endAt: Math.max(
                    d.grabOffsetMs + 15 * MINUTE,
                    Math.ceil(epoch / (15 * MINUTE)) * 15 * MINUTE,
                  ),
                  timeZone: zone,
                }
              : dragTime(d, epoch, zone);
      setPreview(previewRef.current);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== drag.current?.pointerId) return;
      e.preventDefault();
      lastPointer.current = { x: e.clientX, y: e.clientY };
      update(e.clientX, e.clientY);
    };
    const clear = () => {
      drag.current = null;
      lastPointer.current = null;
      previewRef.current = null;
      setPreview(null);
      setDraggingId(null);
      callbacks.current.onDragEnd();
      callbacks.current.onInteractionChange(false);
    };
    const end = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (d.kind === "todo") update(e.clientX, e.clientY);
      const time = previewRef.current;
      if (d.kind === "create") {
        const created: EventTime =
          moved.current && time
            ? time
            : {
                kind: "timed",
                startAt: d.grabOffsetMs,
                endAt: d.grabOffsetMs + HOUR,
                timeZone: zone,
              };
        afterClick(() => callbacks.current.onCreate(created));
      } else if (moved.current && time) {
        setPending(true);
        void callbacks.current.onCommit(d.event, d.todoId, time).finally(() => setPending(false));
      }
      clear();
    };
    const cancel = () => {
      clear();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag.current) {
        e.preventDefault();
        cancel();
      }
    };
    let frame = 0;
    const scroll = () => {
      if (drag.current && lastPointer.current && viewport.current) {
        const view = viewport.current,
          rect = view.getBoundingClientRect();
        const { x, y } = lastPointer.current;
        if (x >= rect.left && x <= rect.right) {
          const amount = edgeScroll(y, rect.top, rect.bottom);
          if (amount) {
            view.scrollTop += amount;
            update(x, y);
          }
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", cancel);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", cancel);
      // Re-running mid-drag (e.g. the hour height changed) must not leave the page "interacting".
      if (drag.current) clear();
    };
  }, [zone, hourHeight]);
  const start = (
    e: ReactPointerEvent,
    event: PlanningEvent,
    kind: "move" | "start" | "end",
    day: string,
  ) => {
    if (
      e.button !== 0 ||
      pending ||
      event.time.kind !== "timed" ||
      snapshot.calendars.find((c) => c.id === event.calendarId)?.readOnly
    )
      return;
    e.stopPropagation();
    const rect = columns.current.get(day)?.getBoundingClientRect();
    if (!rect) return;
    const epoch = rangeOf(day)[0] + ((e.clientY - rect.top) / hourHeight) * HOUR;
    drag.current = {
      kind,
      pointerId: e.pointerId,
      originX: e.clientX,
      originY: e.clientY,
      original: event.time,
      event,
      grabOffsetMs: epoch - event.time.startAt,
      durationMinutes: (event.time.endAt - event.time.startAt) / MINUTE,
    };
    moved.current = false;
    setDraggingId(event.id);
    callbacks.current.onInteractionChange(true);
  };
  return (
    <div
      className="planning-time-area"
      aria-busy={pending}
      style={{ minWidth: days.length > 1 ? 560 : undefined }}
    >
      <div
        className="planning-day-head"
        style={{
          paddingRight: scrollbar,
          gridTemplateColumns: `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`,
        }}
      >
        <span />
        {days.map((day) => (
          <div
            key={day}
            className={`${day === today ? "is-today" : ""} ${day < today ? "is-past" : ""}`}
          >
            <small>
              {new Intl.DateTimeFormat(planningDateLocale(), {
                weekday: "short",
                timeZone: "UTC",
              }).format(new Date(`${day}T12:00:00Z`))}
            </small>
            <button
              type="button"
              className="planning-day-number"
              aria-label={translate("planner.grid.openDay", { day })}
              aria-current={day === today ? "date" : undefined}
              onClick={() => onOpenDay(day)}
            >
              {Number(day.slice(-2))}
            </button>
            {showLunar && <small className="planning-lunar">{lunarDate(day)}</small>}
          </div>
        ))}
      </div>
      <div
        className="planning-all-day"
        style={{
          paddingRight: scrollbar,
          gridTemplateColumns: `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`,
        }}
      >
        <small className="planning-zone-label" title={zone}>
          {zoneOffset(days[0], zone)}
        </small>
        {days.map((day) => (
          <fieldset
            key={day}
            data-planning-all-day={day}
            aria-label={translate("planner.grid.allDayOf", { day })}
            onDoubleClick={(e) => {
              if (e.target === e.currentTarget)
                onCreate({
                  kind: "allDay",
                  startDate: day,
                  endDateExclusive: addDays(day, 1),
                  timeZone: zone,
                });
            }}
            className={
              (preview?.kind === "allDay" && preview.startDate === day) ||
              dayDrag.dragging?.target === day
                ? "planning-all-day-target"
                : ""
            }
          >
            <button
              type="button"
              className="sr-only focus:not-sr-only"
              aria-label={translate("planner.grid.newAllDayOf", { day })}
              onClick={() =>
                onCreate({
                  kind: "allDay",
                  startDate: day,
                  endDateExclusive: addDays(day, 1),
                  timeZone: zone,
                })
              }
            >
              {translate("planner.grid.newAllDay")}
            </button>
            {draftTime?.kind === "allDay" &&
              draftTime.startDate <= day &&
              draftTime.endDateExclusive > day && (
                <div
                  ref={day === draftDay ? onDraftElement : undefined}
                  className="planning-all-day-event planning-draft"
                  style={draftStyle}
                >
                  {draft?.task && <Circle className="planning-task-mark" aria-hidden />}
                  <span className="truncate">{draftTitle}</span>
                </div>
              )}
            {snapshot.todos
              .filter(
                (t) =>
                  !hidden.has(taskListLayer(t.groupId)) &&
                  !t.deletedAt &&
                  t.dueDate === day &&
                  t.status === "open",
              )
              .map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={`planning-all-day-event planning-task-chip ${day < today ? "is-past" : ""}`}
                  style={taskAppearance(taskListColor(t, snapshot), "task", day < today)}
                  title={translate("planner.task.rowLabel", { title: t.title })}
                  onClick={() => onSelectTodo(t)}
                >
                  <Circle className="planning-task-mark" aria-hidden />
                  <span className="truncate">{t.title}</span>
                </button>
              ))}
            {day === today && overdue.length > 0 && (
              <button
                type="button"
                className="planning-all-day-event planning-pending-chip"
                onClick={onOpenTasks}
              >
                <CheckCircle2 className="size-3 shrink-0" aria-hidden />
                <span className="truncate">
                  {translate("planner.grid.pendingTasks", { count: overdue.length })}
                </span>
              </button>
            )}
            {visible
              .filter(
                (e) =>
                  e.time.kind === "allDay" &&
                  e.time.startDate <= day &&
                  e.time.endDateExclusive > day,
              )
              .map((event) => (
                <button
                  type="button"
                  key={event.id}
                  className={`planning-all-day-event ${dayDrag.dragging?.id === event.id ? "is-dragging" : ""} ${event.todoId ? "planning-task-chip" : ""} ${isCronEvent(event) ? "planning-event-cron" : ""} ${snapshot.todos.find((t) => t.id === event.todoId)?.status === "completed" ? "is-completed" : ""} ${allDayPast(event) ? "is-past" : ""}`}
                  title={eventTitle(event, snapshot.todos)}
                  style={
                    event.todoId
                      ? taskAppearance(eventColor(event, snapshot), "task", allDayPast(event))
                      : eventAppearance(eventColor(event, snapshot), allDayPast(event))
                  }
                  onPointerDown={(down) => dayDrag.start(down, event, day)}
                  onClick={(e) => {
                    const anchor = e.currentTarget;
                    dayDrag.click(() => onSelect(event, anchor));
                  }}
                >
                  {event.todoId && (
                    <TaskMark todo={snapshot.todos.find((t) => t.id === event.todoId)} />
                  )}
                  <span className="truncate">{eventTitle(event, snapshot.todos)}</span>
                </button>
              ))}
          </fieldset>
        ))}
      </div>
      <div className="planning-time-scroll" ref={viewport}>
        <div
          className="planning-time-columns"
          style={{
            gridTemplateColumns: `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`,
            height: hours * hourHeight,
          }}
        >
          <div className="planning-time-labels">
            {Array.from({ length: Math.ceil(hours) }, (_, hour) => ({
              hour,
              label: `${String(startHour + hour).padStart(2, "0")}:00`,
            }))
              .filter(({ hour }) => hour > 0)
              .map(({ hour, label }) => (
                <small key={label} style={{ top: hour * hourHeight }}>
                  {label}
                </small>
              ))}
          </div>
          {days.map((day) => {
            const dayWidth = viewWidth ? (viewWidth - GUTTER) / days.length : 200;
            const [from, to] = rangeOf(day);
            const dayLength = dayStart(addDays(day, 1), zone) - dayStart(day, zone);
            const dayFrom = dayStart(day, zone),
              dayTo = dayStart(addDays(day, 1), zone);
            const deadlines = workHours ? dueTodos.map((t) => t.dueAt ?? 0) : [];
            const before = workHours
              ? visible.filter(
                  (e) => e.time.kind === "timed" && e.time.endAt <= from && e.time.endAt > dayFrom,
                ).length + deadlines.filter((at) => at >= dayFrom && at < from).length
              : 0;
            const after = workHours
              ? visible.filter(
                  (e) => e.time.kind === "timed" && e.time.startAt >= to && e.time.startAt < dayTo,
                ).length + deadlines.filter((at) => at >= to && at < dayTo).length
              : 0;
            // Deadline chips join the same column layout as events: their footprint is exactly
            // their pixel height (plus the 1px outline on each side), so items that touch on
            // screen split into columns instead of covering each other.
            const chipMs = ((CHIP_HEIGHT + 2) / hourHeight) * HOUR;
            const deadlineChips: PlanningEvent[] = dueTodos
              .filter((t) => (t.dueAt ?? 0) >= from && (t.dueAt ?? 0) < to)
              .map((t) => {
                const startAt = Math.min(t.dueAt ?? from, to - chipMs);
                return {
                  id: `${DEADLINE_PREFIX}${t.id}`,
                  calendarId: "",
                  todoId: t.id,
                  title: t.title,
                  notes: "",
                  time: { kind: "timed", startAt, endAt: startAt + chipMs, timeZone: zone },
                  revision: 0,
                  createdAt: 0,
                  updatedAt: 0,
                } satisfies PlanningEvent;
              });
            const placements = layoutEvents([...visible, ...deadlineChips], from, to, hourHeight);
            const pStart = preview?.kind === "timed" ? Math.max(preview.startAt, from) : 0,
              pEnd = preview?.kind === "timed" ? Math.min(preview.endAt, to) : 0;
            return (
              <div
                key={day}
                data-planning-day={day}
                className="planning-time-day"
                ref={(element) => {
                  if (element) columns.current.set(day, element);
                  else columns.current.delete(day);
                }}
                style={{ backgroundSize: `100% ${hourHeight}px` }}
                onPointerDown={(e) => {
                  if (
                    e.target !== e.currentTarget ||
                    e.button !== 0 ||
                    pending ||
                    draft ||
                    e.pointerType === "touch"
                  )
                    return;
                  const epoch =
                    from +
                    ((e.clientY - e.currentTarget.getBoundingClientRect().top) / hourHeight) * HOUR;
                  const startAt = Math.floor(epoch / (15 * MINUTE)) * 15 * MINUTE;
                  drag.current = {
                    kind: "create",
                    pointerId: e.pointerId,
                    originX: e.clientX,
                    originY: e.clientY,
                    grabOffsetMs: startAt,
                    durationMinutes: 60,
                  };
                  moved.current = false;
                  callbacks.current.onInteractionChange(true);
                }}
              >
                {dayLength !== 24 * HOUR && (
                  <small className="planning-dst">
                    {translate("planner.grid.dst", { hours: dayLength / HOUR })}
                  </small>
                )}
                {before > 0 && (
                  <small className="planning-outside is-before">
                    {translate("planner.grid.beforeHours", { hour: startHour, count: before })}
                  </small>
                )}
                {after > 0 && (
                  <small className="planning-outside is-after">
                    {translate("planner.grid.afterHours", { hour: endHour, count: after })}
                  </small>
                )}
                {draftTime?.kind === "timed" &&
                  draftTime.startAt < to &&
                  draftTime.endAt > from && (
                    <div
                      ref={day === draftDay ? onDraftElement : undefined}
                      className="planning-time-event planning-draft"
                      style={{
                        ...draftStyle,
                        top: ((Math.max(draftTime.startAt, from) - from) / HOUR) * hourHeight,
                        height: Math.max(
                          16,
                          ((Math.min(draftTime.endAt, to) - Math.max(draftTime.startAt, from)) /
                            HOUR) *
                            hourHeight,
                        ),
                        left: 1,
                        width: "calc(100% - 10px)",
                        zIndex: 30,
                      }}
                    >
                      <span className="planning-draft-title">
                        {draft?.task && <Circle className="planning-task-mark" aria-hidden />}
                        {draftTitle}
                      </span>
                      <small className="planning-draft-time">
                        {timeLabel(draftTime, zone).split(" · ")[0]}
                      </small>
                    </div>
                  )}
                {placements.map(
                  ({ event, top, height, column, columns: count, span, startsHere, endsHere }) => {
                    // Overlapping blocks sit side by side in columns so each shows its full title
                    // and time; only when a column would be unreadably narrow do they cascade.
                    const deadline = event.id.startsWith(DEADLINE_PREFIX);
                    const cascade = count > 1 && dayWidth / count < MIN_SPLIT_WIDTH;
                    const share = 100 / count;
                    const last = column + span >= count;
                    const geometry = cascade
                      ? {
                          top,
                          left: `${1 + column * CASCADE_OFFSET}px`,
                          width: `calc(100% - ${column * CASCADE_OFFSET + 10}px)`,
                        }
                      : {
                          top,
                          left: `calc(${column * share}% + 1px)`,
                          width: `calc(${span * share}% - ${last ? 10 : 2}px)`,
                        };
                    const layer = { zIndex: 2 + column };
                    if (deadline) {
                      const todo = dueTodos.find((t) => t.id === event.todoId);
                      if (!todo) return null;
                      const dueAt = todo.dueAt ?? from;
                      const time = zonedParts(dueAt, zone).time;
                      const done = todo.status === "completed";
                      const overdue = !done && dueAt < now;
                      const label = `${translate(done ? "planner.grid.taskDueDone" : "planner.grid.taskDue", { title: todo.title })} ${time}${overdue ? ` · ${translate("planner.task.overdue")}` : ""}`;
                      return (
                        <button
                          type="button"
                          key={event.id}
                          className={`planning-time-event planning-deadline ${dueAt < now ? "is-past" : ""} ${done ? "is-completed" : ""}`}
                          title={label}
                          aria-label={label}
                          style={
                            {
                              top: geometry.top,
                              "--chip-left": geometry.left,
                              "--chip-width": geometry.width,
                              "--chip-z": layer.zIndex,
                              height: CHIP_HEIGHT,
                              ...eventAppearance(taskListColor(todo, snapshot), dueAt < now),
                            } as CSSProperties
                          }
                          onClick={() => onSelectTodo(todo)}
                        >
                          {done ? (
                            <Check className="planning-task-mark" aria-hidden />
                          ) : (
                            <Circle className="planning-task-mark" aria-hidden />
                          )}
                          <span className="planning-deadline-title">{todo.title}</span>
                          <span className="planning-deadline-time">
                            <span className="planning-deadline-sep">
                              {translate("planner.grid.inlineSeparator")}
                            </span>
                            {time}
                          </span>
                        </button>
                      );
                    }
                    // Missing calendar colors fall back to theme surfaces inside the helpers.
                    const color = eventColor(event, snapshot);
                    const readOnly = snapshot.calendars.find(
                      (c) => c.id === event.calendarId,
                    )?.readOnly;
                    return (
                      <div
                        key={event.id}
                        className={`planning-time-event ${height < 40 ? "is-short" : ""} ${event.todoId ? "is-task" : ""} ${isCronEvent(event) ? "planning-event-cron" : ""} ${draggingId === event.id ? "is-dragging" : ""} ${snapshot.todos.find((t) => t.id === event.todoId)?.status === "completed" ? "is-completed" : ""} ${timedPast(event) ? "is-past" : ""}`}
                        style={
                          {
                            ...geometry,
                            ...layer,
                            height: Math.max(16, height),
                            ...(event.todoId
                              ? taskAppearance(color, "task", timedPast(event))
                              : eventAppearance(color, timedPast(event))),
                            ...({
                              "--planning-title-lines": titleLines(Math.max(16, height), true),
                            } as CSSProperties),
                          } as CSSProperties
                        }
                      >
                        {!readOnly && startsHere && (
                          <button
                            type="button"
                            className="planning-resize planning-resize-start"
                            aria-label={translate("planner.grid.resizeStart", {
                              title: eventTitle(event, snapshot.todos),
                            })}
                            onPointerDown={(e) => start(e, event, "start", day)}
                            onKeyDown={(e) => {
                              if (
                                event.time.kind !== "timed" ||
                                !["ArrowUp", "ArrowDown"].includes(e.key)
                              )
                                return;
                              e.preventDefault();
                              const startAt =
                                event.time.startAt + (e.key === "ArrowUp" ? -15 : 15) * MINUTE;
                              if (startAt <= event.time.endAt - 15 * MINUTE)
                                void onCommit(event, undefined, { ...event.time, startAt });
                            }}
                          />
                        )}
                        <button
                          type="button"
                          className="planning-event-body"
                          title={`${eventTitle(event, snapshot.todos)} ${timeLabel(event.time, zone)}`}
                          aria-label={`${eventTitle(event, snapshot.todos)} ${timeLabel(event.time, zone)}`}
                          onPointerDown={(e) => start(e, event, "move", day)}
                          onClick={(e) => {
                            if (!moved.current) onSelect(event, e.currentTarget);
                            moved.current = false;
                          }}
                          onKeyDown={(e) => {
                            if (
                              readOnly ||
                              event.time.kind !== "timed" ||
                              !e.altKey ||
                              !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
                            )
                              return;
                            e.preventDefault();
                            // Days move by calendar date so the wall-clock time survives DST.
                            const dayStep = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
                            const delta = dayStep
                              ? shiftDays(event.time.startAt, dayStep, zone) - event.time.startAt
                              : e.key === "ArrowUp"
                                ? -15 * MINUTE
                                : 15 * MINUTE;
                            void onCommit(event, undefined, {
                              ...event.time,
                              startAt: event.time.startAt + delta,
                              endAt: event.time.endAt + delta,
                            });
                          }}
                        >
                          <strong>
                            {event.todoId && (
                              <TaskMark todo={snapshot.todos.find((t) => t.id === event.todoId)} />
                            )}
                            <span className="planning-event-title">
                              {eventTitle(event, snapshot.todos)}
                            </span>
                            <span className="planning-inline-time">
                              {translate("planner.grid.inlineSeparator")}
                              {timeLabel(event.time, zone).split(" · ")[0].split(/[–-]/)[0].trim()}
                            </span>
                          </strong>
                          <small>{timeLabel(event.time, zone).split(" · ")[0]}</small>
                        </button>
                        {!readOnly && endsHere && (
                          <button
                            type="button"
                            className="planning-resize planning-resize-end"
                            aria-label={translate("planner.grid.resizeEnd", {
                              title: eventTitle(event, snapshot.todos),
                            })}
                            onPointerDown={(e) => start(e, event, "end", day)}
                            onKeyDown={(e) => {
                              if (
                                event.time.kind !== "timed" ||
                                !["ArrowUp", "ArrowDown"].includes(e.key)
                              )
                                return;
                              e.preventDefault();
                              const endAt =
                                event.time.endAt + (e.key === "ArrowUp" ? -15 : 15) * MINUTE;
                              if (endAt >= event.time.startAt + 15 * MINUTE)
                                void onCommit(event, undefined, { ...event.time, endAt });
                            }}
                          />
                        )}
                      </div>
                    );
                  },
                )}
                {preview?.kind === "timed" && pEnd > pStart && (
                  <div
                    className="planning-drag-preview"
                    style={{
                      top: ((pStart - from) / HOUR) * hourHeight,
                      height: ((pEnd - pStart) / HOUR) * hourHeight,
                    }}
                  >
                    <strong>{timeLabel(preview, zone)}</strong>
                  </div>
                )}
                {now >= from && now < to && (
                  <div
                    className="planning-now"
                    style={{ top: ((now - from) / HOUR) * hourHeight }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {(pending || preview) && (
        <div
          className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-sm"
          role="status"
        >
          {pending
            ? translate("planner.common.saving")
            : preview
              ? translate("planner.grid.dragHint", { time: timeLabel(preview, zone) })
              : ""}
        </div>
      )}
    </div>
  );
}
