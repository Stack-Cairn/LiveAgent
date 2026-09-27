import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HubHeader } from "../../components/hub/HubChrome";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetPanel,
  SheetTitle,
} from "../../components/ui/sheet";
import { Skeleton } from "../../components/ui/skeleton";
import { useIsMobile } from "../../hooks/use-mobile";
import {
  localizePlanningError,
  planningDateLocale,
  planningLunarAvailable,
} from "../../lib/planning/i18n";
import { planningStore, usePlanning } from "../../lib/planning/store";
import {
  addDays,
  calendarWeekStart,
  dayStart,
  monthDays,
  zonedParts,
} from "../../lib/planning/time";
import type { EventTime, PlanningEvent, Todo } from "../../lib/planning/types";
import { AgendaView } from "./AgendaView";
import { CalendarImport } from "./CalendarImport";
import { CalendarManager } from "./CalendarManager";
import { HOUR_HEIGHT, useCalendarPreferences } from "./calendarDisplay";
import { EventPreview } from "./EventPreview";
import { MonthGrid } from "./MonthGrid";
import { type EditorTarget, PlanningEditor } from "./PlanningEditor";
import { PlanningSidebar, type TaskFilter } from "./PlanningSidebar";
import { type PlanningMode, PlanningToolbar, type PlanningView } from "./PlanningToolbar";
import { PlanningTrash } from "./PlanningTrash";
import { QuickCreate, type QuickKind } from "./QuickCreate";
import { TaskListDialog } from "./TaskListDialog";
import { TaskPanel } from "./TaskPanel";
import { TasksBoard } from "./TasksBoard";
import { type PlanningDragStart, TimeGrid } from "./TimeGrid";
import { preloadTimeZoneOptions } from "./TimeZonePicker";
import { usePlanningT } from "./usePlanningT";
import "./planning.css";

type Undo = {
  expiresAt: number;
  event: PlanningEvent;
  original?: EventTime;
  restore?: { masterId: string; masterRevision: number; date: string };
};
export function PlanningPage() {
  const isMobile = useIsMobile();
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    if (!surface) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(surface);
    return () => observer.disconnect();
  }, [surface]);
  // Below these widths the panels become sheets so the calendar keeps its minimum width.
  const compact = width < 900;
  const sidebarInline = width >= 1180;
  const state = usePlanning();
  const snapshot = state.snapshot;
  const zone = snapshot?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = zonedParts(Date.now(), zone).date;
  const [interaction, setInteraction] = useState(false);
  const [nowRequest, setNowRequest] = useState(0);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const { t, locale } = usePlanningT();
  const [storedPreferences, setPreferences] = useCalendarPreferences();
  // Lunar dates only exist in the Chinese UI; the stored choice is kept for when it returns.
  const preferences = useMemo(
    () => ({
      ...storedPreferences,
      showLunar: storedPreferences.showLunar && planningLunarAvailable(locale),
    }),
    [storedPreferences, locale],
  );
  const [date, setDate] = useState(today);
  const view: PlanningView = isMobile && preferences.view === "week" ? "day" : preferences.view;
  const setView = (next: PlanningView) => setPreferences({ view: next });
  const [mode, setMode] = useState<PlanningMode>("calendar");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [creatingList, setCreatingList] = useState(false);
  const [sidebarSheet, setSidebarSheet] = useState(false);
  const [hidden, setHidden] = useState(new Set<string>());
  const [trashOpen, setTrashOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [preview, setPreview] = useState<{ event: PlanningEvent; anchor: HTMLElement } | null>(
    null,
  );
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  // Clicking or dragging on the grid opens Google's quick-create card beside a draft block.
  const [quick, setQuick] = useState<{
    kind: QuickKind;
    time: EventTime;
    title: string;
    anchor?: Element;
  } | null>(null);
  const [draftElement, setDraftElement] = useState<HTMLElement | null>(null);
  const [calendarsOpen, setCalendarsOpen] = useState(false);
  const [taskSheetOpen, setTaskSheetOpen] = useState(false);
  const [todoDrag, setTodoDrag] = useState<PlanningDragStart | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [clock, setClock] = useState(Date.now());
  const days = useMemo(() => {
    const all =
      view === "day"
        ? [date]
        : view === "agenda"
          ? Array.from({ length: 60 }, (_, i) => addDays(date, i))
          : view === "month"
            ? monthDays(date, preferences.weekStartsOn, false)
            : Array.from({ length: 7 }, (_, i) =>
                addDays(calendarWeekStart(date, preferences.weekStartsOn), i),
              );
    return view === "week" && !preferences.showWeekends
      ? all.filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()))
      : all;
  }, [date, view, preferences.weekStartsOn, preferences.showWeekends]);
  // A draft belongs to the visible range; navigating away discards it like Google does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the range or mode changes
  useEffect(() => setQuick(null), [days, mode]);
  useEffect(() => {
    void planningStore.refresh({
      from: dayStart(days[0], zone),
      to: dayStart(addDays(days[days.length - 1], 1), zone),
    });
  }, [days, zone]);
  // Re-rendering the whole page (grid layout, task panel) every second made every popover
  // stutter. Tick per second only while the undo countdown shows; otherwise once a minute
  // keeps the now line and past-item styling current.
  const undoActive = undo !== null && undo.expiresAt > clock;
  useEffect(() => {
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), undoActive ? 1000 : 60_000);
    return () => clearInterval(timer);
  }, [undoActive]);
  useEffect(() => preloadTimeZoneOptions(planningDateLocale(locale)), [locale]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching Agent scopes must reset drafts
  useEffect(() => {
    setEditor(null);
    setQuick(null);
    setPreview(null);
    setTrashOpen(false);
    setImportOpen(false);
    setCalendarsOpen(false);
    setUndo(null);
    setError("");
    setHidden(new Set());
  }, [state.scope]);
  const report = (e: unknown) => setError(localizePlanningError(e));
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const commitTime = useCallback(
    async (event: PlanningEvent | undefined, todoId: string | undefined, time: EventTime) => {
      if (!snapshot) return;
      setBusy(true);
      setError("");
      try {
        let saved: PlanningEvent | null;
        if (event?.id.includes("@") && event.seriesId && event.originalDate) {
          saved = await planningStore.mutate<PlanningEvent>({
            action: "event.exception",
            id: event.seriesId,
            expectedRevision: event.revision,
            data: { date: event.originalDate, time },
          });
          if (saved)
            setUndo({
              expiresAt: Date.now() + 10_000,
              event: saved,
              restore: {
                masterId: event.seriesId,
                masterRevision: event.revision + 1,
                date: event.originalDate,
              },
            });
        } else if (event) {
          saved = await planningStore.mutate<PlanningEvent>({
            action: "event.update",
            id: event.id,
            expectedRevision: event.revision,
            data: { time },
          });
          if (saved)
            setUndo({ expiresAt: Date.now() + 10_000, event: saved, original: event.time });
        } else {
          const todo = snapshot.todos.find((t) => t.id === todoId);
          if (!todo) throw new Error(t("planner.page.taskGone"));
          const calendar = snapshot.calendars.find((c) => c.isDefault && !c.readOnly);
          if (!calendar) throw new Error(t("planner.page.needDefaultCalendar"));
          saved = await planningStore.mutate<PlanningEvent>({
            action: "todo.schedule",
            id: todo.id,
            expectedRevision: todo.revision,
            data: { calendarId: calendar.id, time },
          });
          if (saved) setUndo({ expiresAt: Date.now() + 10_000, event: saved });
        }
      } catch (e) {
        setError(localizePlanningError(e));
        const latest = planningStore.getState().snapshot;
        if (event) {
          const current =
            latest?.events.find((item) => item.id === event.id) ??
            latest?.eventMasters?.find((item) => item.id === event.id);
          if (current) setEditor({ kind: "event", event: current, time });
        } else {
          const todo = latest?.todos.find((item) => item.id === todoId);
          if (todo) setEditor({ kind: "event", todo, time });
        }
      } finally {
        setBusy(false);
      }
    },
    [snapshot, t],
  );
  useEffect(() => {
    if (!todoDrag || view !== "month") return;
    let moved = false;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== todoDrag.pointerId) return;
      event.preventDefault();
      moved ||= Math.hypot(event.clientX - todoDrag.x, event.clientY - todoDrag.y) > 5;
      const day = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-planning-all-day]")?.dataset.planningAllDay;
      setHoverDay(day ?? null);
    };
    const clear = () => {
      setTodoDrag(null);
      setHoverDay(null);
      setInteraction(false);
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== todoDrag.pointerId) return;
      const day = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-planning-all-day]")?.dataset.planningAllDay;
      if ((moved || Math.hypot(event.clientX - todoDrag.x, event.clientY - todoDrag.y) > 5) && day)
        void commitTime(undefined, todoDrag.todo.id, {
          kind: "allDay",
          startDate: day,
          endDateExclusive: addDays(day, 1),
          timeZone: zone,
        });
      clear();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    document.addEventListener("pointermove", move, { passive: false });
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", clear);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", clear);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", clear);
    };
  }, [todoDrag, view, zone, commitTime]);
  const navigate = (direction: number) => {
    if (view === "month") {
      const value = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
      value.setUTCMonth(value.getUTCMonth() + direction);
      setDate(value.toISOString().slice(0, 10));
    } else setDate(addDays(date, direction * (view === "day" ? 1 : 7)));
  };
  const openDay = (day: string) => {
    setDate(day);
    setView("day");
  };
  const shortcuts = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcuts.current = (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (
      interaction ||
      editor ||
      e.defaultPrevented ||
      e.isComposing ||
      e.repeat ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      target?.closest(
        "input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox]",
      )
    )
      return;
    const views: Record<string, PlanningView> = { d: "day", w: "week", m: "month", a: "agenda" };
    const key = e.key.toLowerCase();
    if (mode === "calendar" && views[key]) setView(views[key]);
    else if (mode === "calendar" && key === "t") {
      setDate(today);
      setNowRequest((n) => n + 1);
    } else if (mode === "calendar" && (key === "j" || key === "n")) navigate(1);
    else if (mode === "calendar" && (key === "k" || key === "p")) navigate(-1);
    else if (key === "c") setEditor({ kind: mode === "tasks" ? "todo" : "event" });
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => shortcuts.current(e);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  if (!snapshot)
    return (
      <section
        className="flex h-full min-h-0 flex-1 flex-col bg-background"
        aria-label={t("planner.page.label")}
      >
        <HubHeader
          title={t("settings.navPlanning")}
          subtitle={t("planner.page.subtitle")}
          prominent
        />
        {state.error ? (
          <EmptyState>
            <SettingsNotice role="alert" variant="action-error">
              {state.error}
            </SettingsNotice>
            <Button variant="outline" onClick={() => void planningStore.refresh()}>
              {t("planner.common.retry")}
            </Button>
          </EmptyState>
        ) : (
          <div
            className="flex flex-1 flex-col gap-4 px-5 pb-5 sm:px-6"
            role="status"
            aria-label={t("planner.page.loading")}
          >
            <Skeleton className="h-9 w-64" />
            <Skeleton className="min-h-48 flex-1" />
            <span className="sr-only">{t("planner.page.loadingEllipsis")}</span>
          </div>
        )}
      </section>
    );
  const panelProps = {
    busy,
    run,
    onEdit: (todo?: Todo) => {
      setTaskSheetOpen(false);
      setEditor({ kind: "todo", todo });
    },
    onSchedule: (todo: Todo, event?: PlanningEvent) => {
      setTaskSheetOpen(false);
      setEditor({ kind: "event", todo, event });
    },
    onDragEnd: () => {
      setTodoDrag(null);
      setInteraction(false);
    },
    onDrag: (drag: PlanningDragStart) => {
      setTodoDrag(drag);
      setInteraction(true);
    },
  };
  const taskPanel = <TaskPanel key={state.scope} snapshot={snapshot} {...panelProps} />;
  const toggleLayer = (id: string) =>
    setHidden((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const sidebar = (
    <PlanningSidebar
      mode={mode}
      snapshot={snapshot}
      date={date}
      today={today}
      hidden={hidden}
      weekStartsOn={preferences.weekStartsOn}
      showWeekNumbers={preferences.showWeekNumbers}
      taskFilter={taskFilter}
      onDate={(day) => {
        setDate(day);
        setSidebarSheet(false);
      }}
      onToggleLayer={toggleLayer}
      onCreateEvent={() => {
        setSidebarSheet(false);
        setEditor({ kind: "event" });
      }}
      onCreateTask={() => {
        setSidebarSheet(false);
        setEditor({ kind: "todo" });
      }}
      onManageCalendars={() => setCalendarsOpen(true)}
      onCreateList={() => setCreatingList(true)}
      onTaskFilter={setTaskFilter}
    />
  );
  // Side panels are fixed parts of the layout; only narrow windows move them into sheets.
  const showSidebar = sidebarInline;
  const showTaskPanel = !compact && mode === "calendar";
  return (
    <section
      ref={setSurface}
      className="planning-page relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-sm text-foreground"
      aria-label={t("planner.page.label")}
      onDragStart={(e) => e.preventDefault()}
    >
      <PlanningToolbar
        compact={compact}
        date={date}
        days={days}
        view={view}
        mode={mode}
        zone={zone}
        preferences={preferences}
        onPreferences={setPreferences}
        onZoneChange={(timeZone) =>
          run(() =>
            planningStore.mutate({
              action: "timezone.set",
              expectedRevision: snapshot.seq,
              data: { timeZone },
            }),
          )
        }
        interaction={interaction}
        busy={busy}
        sidebarSheet={!sidebarInline}
        onNavigate={navigate}
        onToday={() => {
          setDate(today);
          setNowRequest((n) => n + 1);
        }}
        onView={setView}
        onMode={setMode}
        onSidebar={() => setSidebarSheet(true)}
        onTasks={() => setTaskSheetOpen(true)}
        onCalendars={() => setCalendarsOpen(true)}
        onTrash={() => setTrashOpen(true)}
        onImport={() => setImportOpen(true)}
      />
      {(error || state.error) && (
        <SettingsNotice variant="action-error" role="alert" className="mx-4 mb-3">
          {error || state.error}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError("");
              if (state.error) void planningStore.refresh();
            }}
          >
            {state.error ? t("planner.common.retry") : t("planner.common.close")}
          </Button>
        </SettingsNotice>
      )}
      <div className="planning-body" data-testid="planning-split">
        {showSidebar && sidebar}
        <main
          className={`min-h-0 min-w-0 flex-1 ${mode === "tasks" ? "overflow-auto" : "planning-surface"}`}
          data-testid="planning-calendar-surface"
        >
          {mode === "tasks" ? (
            <TasksBoard
              key={state.scope}
              snapshot={snapshot}
              hidden={hidden}
              filter={taskFilter}
              {...panelProps}
            />
          ) : view === "month" ? (
            <MonthGrid
              days={days}
              date={date}
              today={today}
              zone={zone}
              snapshot={snapshot}
              hidden={hidden}
              hoverDay={hoverDay}
              showLunar={preferences.showLunar}
              showCompleted={preferences.showCompleted}
              showWeekNumbers={preferences.showWeekNumbers}
              onSelect={(event, anchor) => setPreview({ event, anchor })}
              onSelectTodo={(todo) => setEditor({ kind: "todo", todo })}
              onOpenDay={openDay}
              onCreate={(time, anchor) => setQuick({ kind: "event", time, title: "", anchor })}
            />
          ) : view === "agenda" ? (
            <AgendaView
              days={days}
              today={today}
              snapshot={snapshot}
              hidden={hidden}
              showLunar={preferences.showLunar}
              showCompleted={preferences.showCompleted}
              onSelect={(event, anchor) => setPreview({ event, anchor })}
              onSelectTodo={(todo) => setEditor({ kind: "todo", todo })}
              onOpenDay={openDay}
            />
          ) : (
            <TimeGrid
              nowRequest={nowRequest}
              onInteractionChange={setInteraction}
              onSelectTodo={(todo) => setEditor({ kind: "todo", todo })}
              onOpenDay={openDay}
              onOpenTasks={() => (compact ? setTaskSheetOpen(true) : setMode("tasks"))}
              days={days}
              today={today}
              snapshot={snapshot}
              hourHeight={HOUR_HEIGHT}
              workHours={
                preferences.workHoursOnly ? [preferences.workStart, preferences.workEnd] : null
              }
              hidden={hidden}
              showLunar={preferences.showLunar}
              showCompleted={preferences.showCompleted}
              todoDrag={todoDrag}
              onDragEnd={() => setTodoDrag(null)}
              onSelect={(event, anchor) => setPreview({ event, anchor })}
              onCreate={(time) => setQuick({ kind: "event", time, title: "" })}
              draft={
                quick && !quick.anchor
                  ? { time: quick.time, title: quick.title, task: quick.kind === "todo" }
                  : null
              }
              onDraftElement={setDraftElement}
              onCommit={commitTime}
            />
          )}
        </main>
        {showTaskPanel && (
          <aside
            className="planning-task-surface"
            aria-label={t("planner.mode.tasks")}
            data-testid="planning-task-surface"
          >
            {taskPanel}
          </aside>
        )}
      </div>
      <Sheet open={!sidebarInline && sidebarSheet} onOpenChange={setSidebarSheet}>
        <SheetContent
          side="left"
          className="w-72 max-w-[calc(100vw-2rem)]"
          closeLabel={t("planner.page.closeSidebar")}
        >
          <SheetHeader className="px-4 py-3">
            <SheetTitle>{t("settings.navPlanning")}</SheetTitle>
          </SheetHeader>
          <SheetPanel className="min-h-0 flex-1 overflow-y-auto p-0">{sidebar}</SheetPanel>
        </SheetContent>
      </Sheet>
      <Sheet open={compact && taskSheetOpen} onOpenChange={setTaskSheetOpen}>
        <SheetContent
          side="right"
          className="w-80 max-w-[calc(100vw-2rem)]"
          closeLabel={t("planner.page.closeTasks")}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("planner.mode.tasks")}</SheetTitle>
          </SheetHeader>
          <SheetPanel className="min-h-0 flex-1 p-0">{taskPanel}</SheetPanel>
        </SheetContent>
      </Sheet>
      {creatingList && (
        <TaskListDialog
          action={{ kind: "create" }}
          onClose={() => setCreatingList(false)}
          onSelect={() => {}}
        />
      )}
      {undo && undo.expiresAt > clock && (
        <div
          className="absolute bottom-4 left-1/2 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-lg"
          role="status"
        >
          {t("planner.undo.saved")}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await planningStore.mutate({
                  action: undo.restore
                    ? "event.restoreException"
                    : undo.original
                      ? "event.update"
                      : "event.delete",
                  id: undo.restore?.masterId ?? undo.event.id,
                  expectedRevision: undo.restore?.masterRevision ?? undo.event.revision,
                  data: undo.restore
                    ? {
                        date: undo.restore.date,
                        exceptionId: undo.event.id,
                        exceptionRevision: undo.event.revision,
                      }
                    : undo.original
                      ? { time: undo.original }
                      : {},
                });
                setUndo(null);
              })
            }
          >
            {t("planner.undo.action", { seconds: Math.ceil((undo.expiresAt - clock) / 1000) })}
          </Button>
        </div>
      )}
      {preview && (
        <EventPreview
          event={snapshot.events.find((e) => e.id === preview.event.id) ?? preview.event}
          anchor={preview.anchor}
          snapshot={snapshot}
          onClose={() => setPreview(null)}
          onEdit={(target) => {
            setPreview(null);
            setEditor(target);
          }}
        />
      )}
      {quick && (quick.anchor ?? draftElement) && (
        <QuickCreate
          kind={quick.kind}
          time={quick.time}
          anchor={(quick.anchor ?? draftElement) as Element}
          snapshot={snapshot}
          onKind={(kind) => setQuick({ ...quick, kind })}
          onTitleChange={(title) => setQuick((current) => current && { ...current, title })}
          onTimeChange={(time) => setQuick((current) => current && { ...current, time })}
          onClose={() => setQuick(null)}
          onMore={(target) => {
            setQuick(null);
            setEditor(target);
          }}
        />
      )}
      {editor && (
        <PlanningEditor
          key={`${editor.kind}-${editor.todo?.id ?? (editor.kind === "event" ? editor.event?.id : "") ?? "new"}`}
          target={editor}
          snapshot={snapshot}
          onClose={() => setEditor(null)}
          onError={report}
          onSchedule={(todo) => setEditor({ kind: "event", todo })}
          onSwitchKind={(kind, time) =>
            setEditor(kind === "todo" ? { kind: "todo" } : { kind: "event", time })
          }
        />
      )}
      {trashOpen && <PlanningTrash snapshot={snapshot} onClose={() => setTrashOpen(false)} />}
      {importOpen && <CalendarImport snapshot={snapshot} onClose={() => setImportOpen(false)} />}
      {calendarsOpen && (
        <CalendarManager snapshot={snapshot} onClose={() => setCalendarsOpen(false)} />
      )}
    </section>
  );
}
