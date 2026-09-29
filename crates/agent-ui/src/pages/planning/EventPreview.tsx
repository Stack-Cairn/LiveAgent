import { useState } from "react";
import {
  CalendarDays,
  List,
  ListChecks,
  MoreHorizontal,
  Repeat,
  SquarePen,
  Trash2,
  X,
} from "../../components/IconSet";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTitle } from "../../components/ui/popover";
import { calendarName, localizePlanningError, planningDateLocale } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import { eventTitle, timeLabel, zonedParts } from "../../lib/planning/time";
import type { PlanningEvent, PlanningSnapshot } from "../../lib/planning/types";
import { eventColor } from "./eventAppearance";
import type { EditorTarget } from "./PlanningEditor";
import { describeRecurrence, firstDay } from "./recurrence";
import { useSeriesScope } from "./SeriesScopeDialog";
import { usePlanningT } from "./usePlanningT";
export function EventPreview({
  event,
  anchor,
  snapshot,
  onClose,
  onEdit,
}: {
  event: PlanningEvent;
  anchor: HTMLElement;
  snapshot: PlanningSnapshot;
  onClose(): void;
  onEdit(target: EditorTarget): void;
}) {
  const { t, locale } = usePlanningT();

  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const todo = snapshot.todos.find((t) => t.id === event.todoId);
  const calendar = snapshot.calendars.find((c) => c.id === event.calendarId);
  const list = snapshot.groups?.find((g) => g.id === todo?.groupId);
  const date =
    event.time.kind === "timed"
      ? zonedParts(event.time.startAt, snapshot.timeZone).date
      : event.time.startDate;
  const dateLabel = new Intl.DateTimeFormat(planningDateLocale(locale), {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      onClose();
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
      setBusy(false);
    }
  };
  const { askScope, scopeDialog } = useSeriesScope();
  const master = event.seriesId
    ? (snapshot.eventMasters ?? snapshot.events).find((e) => e.id === event.seriesId)
    : undefined;
  const rule = master?.recurrence ?? event.recurrence;
  const ruleStart = (master ?? event).time;
  const repeatText = rule
    ? describeRecurrence(
        t,
        locale,
        rule,
        ruleStart.kind === "timed"
          ? zonedParts(ruleStart.startAt, ruleStart.timeZone).date
          : ruleStart.startDate,
      )
    : "";
  const recycleEvent = async () => {
    const series = event.seriesId && event.originalDate && !todo;
    const scope = series
      ? await askScope(t("planner.series.deleteTitle"), {
          allowFollowing: !!master && event.originalDate !== firstDay(master.time),
        })
      : "this";
    if (!scope) return;
    await perform(() => {
      if (scope === "following") {
        if (!master) throw new Error(t("planner.series.missing"));
        return planningStore.mutate({
          action: "event.split",
          id: master.id,
          expectedRevision: master.revision,
          data: { date: event.originalDate, delete: true },
        });
      }
      if (scope === "all") {
        if (!master) throw new Error(t("planner.series.missing"));
        return planningStore.mutate({
          action: "event.delete",
          id: master.id,
          expectedRevision: master.revision,
          data: {},
        });
      }
      const instance = event.id.includes("@") && event.seriesId && event.originalDate;
      return planningStore.mutate({
        action: instance ? "event.exception" : "event.delete",
        id: instance ? (event.seriesId ?? event.id) : event.id,
        expectedRevision: event.revision,
        data: instance ? { date: event.originalDate, delete: true } : {},
      });
    });
  };
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <PopoverContent
        anchor={anchor}
        finalFocus={() => (anchor.isConnected ? anchor : false)}
        side="left"
        align="start"
        sideOffset={12}
        className="w-[30rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl bg-popover p-0 shadow-xl"
        aria-label={t("planner.preview.label")}
      >
        <div className="flex items-center justify-end gap-1 px-3 pt-3">
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label={t("planner.preview.edit")}
            disabled={busy || calendar?.readOnly}
            onClick={() => onEdit({ kind: "event", event })}
          >
            <SquarePen className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label={todo ? t("planner.preview.trashTask") : t("planner.preview.trashEvent")}
            disabled={busy || calendar?.readOnly}
            onClick={() =>
              todo
                ? void perform(() =>
                    planningStore.mutate({
                      action: "todo.delete",
                      id: todo.id,
                      expectedRevision: todo.revision,
                      data: {},
                    }),
                  )
                : void recycleEvent()
            }
          >
            <Trash2 className="size-5" />
          </Button>
          {todo && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon" className="rounded-full" />}
                aria-label={t("planner.preview.more")}
                disabled={busy}
              >
                <MoreHorizontal className="size-5 rotate-90" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem className="gap-2" onClick={() => onEdit({ kind: "todo", todo })}>
                  {t("planner.preview.editTask")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  disabled={calendar?.readOnly}
                  onClick={() => void recycleEvent()}
                >
                  {t("planner.preview.removeBlock")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label={t("planner.preview.close")}
            disabled={busy}
            onClick={onClose}
          >
            <X className="size-5" />
          </Button>
        </div>
        <div className="max-h-[60dvh] space-y-4 overflow-y-auto px-4 pb-5 pt-1">
          <div className="flex gap-4">
            <span
              className="mx-1 mt-2.5 size-3.5 shrink-0 rounded bg-primary"
              style={{ backgroundColor: eventColor(event, snapshot) }}
            />
            <div className="min-w-0">
              <PopoverTitle className="break-words text-2xl font-normal leading-8">
                {eventTitle(event, snapshot.todos)}
              </PopoverTitle>
              <p className="mt-0.5 text-sm">
                {event.time.kind === "timed"
                  ? `${dateLabel} ⋅ ${timeLabel(event.time, snapshot.timeZone).split(" · ")[0]}`
                  : timeLabel(event.time, snapshot.timeZone)}
              </p>
            </div>
          </div>
          <dl className="space-y-3 text-sm [&>div]:gap-4 [&_dt]:px-1 [&_dt_svg]:size-5">
            {todo && (
              <div className="flex items-center gap-3">
                <dt>
                  <ListChecks
                    className="size-4 text-muted-foreground"
                    aria-label={t("planner.taskList")}
                  />
                </dt>
                <dd className="truncate">{list?.name ?? t("planner.myTasks")}</dd>
              </div>
            )}
            {!todo && (
              <div className="flex items-center gap-3">
                <dt>
                  <CalendarDays
                    className="size-4 text-muted-foreground"
                    aria-label={t("planner.calendar")}
                  />
                </dt>
                <dd>
                  {calendar ? calendarName(calendar) : t("planner.calendar")}
                  {calendar?.readOnly ? ` · ${t("planner.calendar.readOnly")}` : ""}
                </dd>
              </div>
            )}
            {repeatText && (
              <div className="flex items-center gap-3">
                <dt>
                  <Repeat
                    className="size-4 text-muted-foreground"
                    aria-label={t("planner.editor.repeat")}
                  />
                </dt>
                <dd>{repeatText}</dd>
              </div>
            )}
            {(todo ? todo.notes : event.notes) && (
              <div className="flex items-start gap-3">
                <dt>
                  <List
                    className="mt-0.5 size-4 text-muted-foreground"
                    aria-label={t("planner.editor.notes")}
                  />
                </dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words">
                  {todo ? todo.notes : event.notes}
                </dd>
              </div>
            )}
          </dl>
          {error && (
            <SettingsNotice role="alert" variant="inline-error">
              {error}
            </SettingsNotice>
          )}
        </div>
        {todo && (
          <div className="flex justify-end px-4 pb-4">
            <Button
              variant="secondary"
              className="h-10 rounded-full px-6"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  planningStore.mutate({
                    action: "todo.update",
                    id: todo.id,
                    expectedRevision: todo.revision,
                    data: { status: todo.status === "completed" ? "open" : "completed" },
                  }),
                )
              }
            >
              {todo.status === "completed"
                ? t("planner.task.markOpen")
                : t("planner.task.markDone")}
            </Button>
          </div>
        )}
      </PopoverContent>
      {scopeDialog}
    </Popover>
  );
}
