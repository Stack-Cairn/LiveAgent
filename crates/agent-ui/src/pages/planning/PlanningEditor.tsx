import { useId, useState } from "react";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { useConfirmDialog } from "../../components/ui/confirm-dialog";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { calendarName, localizePlanningError } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import { homeTaskList, taskLists } from "../../lib/planning/taskLists";
import { addDays, eventTitle, localEpoch, timeLabel, zonedParts } from "../../lib/planning/time";
import type { EventTime, PlanningEvent, PlanningSnapshot, Todo } from "../../lib/planning/types";
import { PlanningField, PlanningSelect } from "./PlanningControls";
import { PlanningDateTimePicker } from "./PlanningDateTimePicker";
import { usePlanningT } from "./usePlanningT";

const NOTIFY_MINUTES = [0, 5, 15, 30, 60, 1440];
function notifyLabel(t: (key: string, vars?: Record<string, string>) => string, minutes: number) {
  const duration: Record<number, string> = {
    5: "planner.duration.5m",
    15: "planner.duration.15m",
    30: "planner.duration.30m",
    60: "planner.duration.1h",
    1440: "planner.duration.1d",
  };
  return minutes === 0
    ? t("planner.notify.atStart")
    : duration[minutes]
      ? t("planner.notify.before", { duration: t(duration[minutes]) })
      : t("planner.notify.minutesBefore", { minutes: String(minutes) });
}
/** Google-style "Notification" choices; the first follows the calendar's default. */
function notificationOptions(
  t: (key: string, vars?: Record<string, string>) => string,
  calendarDefault: number | null | undefined,
) {
  return [
    {
      value: "",
      label: t("planner.notify.default", {
        label: calendarDefault == null ? t("planner.notify.off") : notifyLabel(t, calendarDefault),
      }),
    },
    { value: "-1", label: t("planner.notify.off") },
    ...NOTIFY_MINUTES.map((minutes) => ({
      value: String(minutes),
      label: notifyLabel(t, minutes),
    })),
  ];
}
/** Values typed into the quick-create card, carried over by "More options". */
export interface EditorDraft {
  title: string;
  notes: string;
  calendarId?: string;
  groupId?: string;
  frequency?: "" | "daily" | "weekly" | "monthly";
  due?: { date: string; time: string };
}
export type EditorTarget =
  | { kind: "todo"; todo?: Todo; draft?: EditorDraft }
  | { kind: "event"; event?: PlanningEvent; todo?: Todo; time?: EventTime; draft?: EditorDraft };
export function PlanningEditor({
  target,
  snapshot,
  onClose,
  onError,
  onSwitchKind,
  onSchedule,
}: {
  /** Open the scheduling editor for an existing task. */
  onSchedule?(todo: Todo): void;
  /** New items only: switch between 活动 / 任务 like Google's create dialog tabs. */
  onSwitchKind?(kind: EditorTarget["kind"], time?: EventTime): void;
  target: EditorTarget;
  snapshot: PlanningSnapshot;
  onClose(): void;
  onError(error: unknown): void;
}) {
  const { t } = usePlanningT();
  const event = target.kind === "event" ? target.event : undefined;
  const todo = target.todo ?? snapshot.todos.find((t) => t.id === event?.todoId);
  const creating = !event && !todo;
  const scheduled = todo
    ? (snapshot.eventMasters ?? snapshot.events).filter((e) => e.todoId === todo.id && !e.deletedAt)
    : [];
  const initialTime = target.kind === "event" ? (target.time ?? event?.time) : undefined;
  const zone = initialTime?.timeZone ?? todo?.dueTimeZone ?? snapshot.timeZone;
  const initialStart =
    initialTime?.kind === "timed"
      ? zonedParts(initialTime.startAt, zone)
      : { date: initialTime?.startDate ?? zonedParts(Date.now(), zone).date, time: "09:00" };
  const initialEnd =
    initialTime?.kind === "timed"
      ? zonedParts(initialTime.endAt, zone)
      : {
          date: initialTime ? addDays(initialTime.endDateExclusive, -1) : initialStart.date,
          time: "10:00",
        };
  const formId = useId();
  const draft = target.draft;
  const [title, setTitle] = useState(
    event ? eventTitle(event, snapshot.todos) : (todo?.title ?? draft?.title ?? ""),
  );
  const [notes, setNotes] = useState(todo?.notes ?? event?.notes ?? draft?.notes ?? "");
  const [calendarId, setCalendarId] = useState(
    event?.calendarId ?? draft?.calendarId ?? snapshot.calendars.find((c) => c.isDefault)?.id ?? "",
  );
  const [groupId, setGroupId] = useState(todo?.groupId ?? draft?.groupId ?? homeTaskList(snapshot));
  const [priority, setPriority] = useState(todo?.priority ?? "medium");
  const [reminderMinutes, setReminderMinutes] = useState(todo?.reminderMinutes ?? 0);
  const [estimate, setEstimate] = useState(todo?.estimateMinutes?.toString() ?? "60");
  const [dueDate, setDueDate] = useState(
    todo?.dueDate ??
      (todo?.dueAt
        ? zonedParts(todo.dueAt, todo.dueTimeZone ?? zone).date
        : (draft?.due?.date ?? "")),
  );
  const [dueTime, setDueTime] = useState(
    todo?.dueAt ? zonedParts(todo.dueAt, todo.dueTimeZone ?? zone).time : (draft?.due?.time ?? ""),
  );
  const [dueReminder, setDueReminder] = useState(todo?.dueReminder ?? false);
  const [allDay, setAllDay] = useState(initialTime?.kind === "allDay");
  const [startDate, setStartDate] = useState(initialStart.date),
    [endDate, setEndDate] = useState(initialEnd.date);
  const [startClock, setStartClock] = useState(initialStart.time),
    [endClock, setEndClock] = useState(initialEnd.time);
  // Items keep their stored zone; new ones use the calendar's zone (Google has no per-item picker).
  const timeZone = zone;
  // "" follows the calendar default; -1 turns the notification off.
  const [notify, setNotify] = useState(
    event?.reminderMinutes == null ? "" : String(event.reminderMinutes),
  );
  const [frequency, setFrequency] = useState(
    event?.recurrence?.frequency ?? draft?.frequency ?? "",
  );
  const [interval, setInterval] = useState(String(event?.recurrence?.interval ?? 1));
  const [until, setUntil] = useState(event?.recurrence?.until ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  const readOnly = event && snapshot.calendars.find((c) => c.id === event.calendarId)?.readOnly;
  const synthetic = event?.id.includes("@") && event.seriesId && event.originalDate;
  const perform = async (fn: () => Promise<unknown>, close = true) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (close) onClose();
    } catch (e) {
      setError(localizePlanningError(e));
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    perform(async () => {
      if (!title.trim()) throw new Error(t("planner.editor.titleRequired"));
      if (target.kind === "todo") {
        const data = {
          title: title.trim(),
          notes,
          estimateMinutes: estimate ? Number(estimate) : null,
          dueAt: dueDate && dueTime ? localEpoch(dueDate, dueTime, timeZone) : null,
          dueDate: dueDate && !dueTime ? dueDate : null,
          dueTimeZone: dueDate ? timeZone : null,
          dueReminder,
          groupId: groupId || null,
          priority,
          reminderMinutes,
        };
        await planningStore.mutate({
          action: todo ? "todo.update" : "todo.create",
          id: todo?.id,
          expectedRevision: todo?.revision,
          data,
        });
      } else {
        const time: EventTime = allDay
          ? { kind: "allDay", startDate, endDateExclusive: addDays(endDate, 1), timeZone }
          : {
              kind: "timed",
              startAt: localEpoch(startDate, startClock, timeZone),
              endAt: localEpoch(endDate, endClock, timeZone),
              timeZone,
            };
        if (synthetic && event?.seriesId) {
          await planningStore.mutate({
            action: "event.exception",
            id: event.seriesId,
            expectedRevision: event.revision,
            data: { date: event.originalDate, time, title, notes },
          });
        } else if (todo && !event) {
          await planningStore.mutate({
            action: "todo.schedule",
            id: todo.id,
            expectedRevision: todo.revision,
            data: { calendarId, time, title: title.trim(), notes },
          });
        } else {
          await planningStore.mutate({
            action: event ? "event.update" : "event.create",
            id: event?.id,
            expectedRevision: event?.revision,
            data: {
              title: title.trim(),
              notes,
              calendarId,
              time,
              ...(synthetic || todo
                ? {}
                : { reminderMinutes: notify === "" ? null : Number(notify) }),
              recurrence: frequency
                ? {
                    frequency,
                    interval: Number(interval),
                    weekdays: event?.recurrence?.weekdays ?? [],
                    excludedDates: event?.recurrence?.excludedDates ?? [],
                    until: until || null,
                    count: event?.recurrence?.count ?? null,
                  }
                : null,
            },
          });
        }
      }
    });
  const remove = () =>
    perform(async () => {
      if (event)
        await planningStore.mutate({
          action: synthetic ? "event.exception" : "event.delete",
          id: synthetic ? (event.seriesId ?? event.id) : event.id,
          expectedRevision: event.revision,
          data: synthetic ? { date: event.originalDate, delete: true } : {},
        });
      else if (todo)
        await planningStore.mutate({
          action: "todo.delete",
          id: todo.id,
          expectedRevision: todo.revision,
          data: {},
        });
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-85dvh max-w-xl flex-col sm:rounded-3xl"
        showCloseButton
        closeLabel={t("planner.common.close")}
        closeDisabled={busy}
        layout="bottom-sheet-mobile"
      >
        <DialogHeader>
          {creating && onSwitchKind && (
            <fieldset className="mb-1 flex gap-2" aria-label={t("planner.editor.createKind")}>
              {(
                [
                  ["event", t("planner.kind.event")],
                  ["todo", t("planner.kind.task")],
                ] as const
              ).map(([kind, label]) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={target.kind === kind ? "secondary" : "ghost"}
                  className="rounded-full px-4"
                  aria-pressed={target.kind === kind}
                  disabled={busy}
                  onClick={() => kind !== target.kind && onSwitchKind(kind, initialTime)}
                >
                  {label}
                </Button>
              ))}
            </fieldset>
          )}
          <DialogTitle className={creating && onSwitchKind ? "sr-only" : undefined}>
            {target.kind === "todo"
              ? todo
                ? t("planner.editor.taskDetails")
                : t("planner.editor.newTask")
              : todo && !event
                ? t("planner.editor.schedule")
                : event
                  ? t("planner.editor.eventDetails")
                  : t("planner.editor.newEvent")}
          </DialogTitle>
          {synthetic && (
            <DialogDescription>{t("planner.editor.onlyThisOccurrence")}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>
          <form
            id={formId}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="flex min-h-0 flex-col gap-4"
          >
            <fieldset className="min-w-0 space-y-4" disabled={busy || readOnly}>
              <PlanningField
                label={t("planner.editor.title")}
                className={creating ? "[&>label]:sr-only" : undefined}
              >
                <Input
                  variant="plain"
                  className={
                    creating
                      ? "h-11 rounded-none border-0 border-b bg-transparent px-0 text-xl shadow-none focus:bg-transparent focus:ring-0 focus-visible:border-primary focus-visible:ring-0"
                      : undefined
                  }
                  placeholder={creating ? t("planner.editor.addTitle") : undefined}
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={500}
                  required
                />
              </PlanningField>
              <PlanningField label={t("planner.editor.notes")}>
                <Textarea
                  variant="plain"
                  disabled={!!synthetic || (target.kind === "event" && !!todo && !event)}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                />
              </PlanningField>
              {target.kind === "todo" ? (
                <>
                  <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                    <PlanningField label={t("planner.taskList")}>
                      <PlanningSelect
                        disabled={busy || !!readOnly}
                        value={groupId}
                        onValueChange={(value) => setGroupId(value)}
                        options={taskLists(snapshot).map((list) => ({
                          value: list.id,
                          label: list.name,
                        }))}
                      />
                    </PlanningField>
                    <PlanningField label={t("planner.editor.priority")}>
                      <PlanningSelect
                        disabled={busy || !!readOnly}
                        value={priority}
                        onValueChange={(value) => setPriority(value as typeof priority)}
                        options={[
                          { value: "low", label: t("planner.priority.low") },
                          { value: "medium", label: t("planner.priority.medium") },
                          { value: "high", label: t("planner.priority.high") },
                        ]}
                      />
                    </PlanningField>
                  </div>
                  <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                    <PlanningField label={t("planner.editor.estimate")}>
                      <Input
                        variant="plain"
                        type="number"
                        min={15}
                        max={10080}
                        step={15}
                        value={estimate}
                        onChange={(e) => setEstimate(e.target.value)}
                      />
                    </PlanningField>
                  </div>
                  <PlanningDateTimePicker
                    value={{ date: dueDate, time: dueTime }}
                    onChange={(v) => {
                      setDueDate(v.date);
                      setDueTime(v.time);
                    }}
                    zone={timeZone}
                    label={t("planner.editor.due")}
                    disabled={busy || !!readOnly}
                  />
                  <Label className="flex items-center gap-2 text-sm font-normal">
                    <Checkbox
                      disabled={busy || !!readOnly}
                      checked={dueReminder}
                      onCheckedChange={(checked) => setDueReminder(checked)}
                    />
                    {t("planner.editor.dueReminder")}
                  </Label>
                  {dueReminder && (
                    <PlanningField
                      label={t("planner.editor.remindBefore")}
                      description={
                        <>
                          {" "}
                          {dueDate && !dueTime && (
                            <span>{t("planner.editor.dueMidnightHint")}</span>
                          )}{" "}
                        </>
                      }
                    >
                      <PlanningSelect
                        disabled={busy || !!readOnly}
                        value={reminderMinutes}
                        onValueChange={(value) => setReminderMinutes(Number(value))}
                        options={[
                          { value: 0, label: t("planner.editor.atDue") },
                          { value: 5, label: t("planner.duration.5m") },
                          { value: 15, label: t("planner.duration.15m") },
                          { value: 30, label: t("planner.duration.30m") },
                          { value: 60, label: t("planner.duration.1h") },
                          { value: 1440, label: t("planner.duration.1d") },
                        ]}
                      />
                    </PlanningField>
                  )}
                </>
              ) : (
                <>
                  {todo ? (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">{t("planner.taskList")}</span>
                      <span>
                        {snapshot.groups?.find((g) => g.id === todo.groupId)?.name ??
                          t("planner.myTasks")}
                      </span>
                    </div>
                  ) : (
                    <PlanningField label={t("planner.calendar")}>
                      <PlanningSelect
                        disabled={busy || !!readOnly || !!synthetic}
                        value={calendarId}
                        onValueChange={(value) => setCalendarId(value)}
                        options={[
                          ...(snapshot.calendars
                            .filter((c) => !c.readOnly || c.id === calendarId)
                            .map((c) => ({ value: c.id, label: calendarName(c) })) ?? []),
                        ]}
                      />
                    </PlanningField>
                  )}
                  <PlanningDateTimePicker
                    value={{
                      date: startDate,
                      time: allDay ? "" : startClock,
                      endDate,
                      endTime: allDay ? "" : endClock,
                    }}
                    onChange={(v) => {
                      setStartDate(v.date);
                      setEndDate(v.endDate || v.date);
                      setAllDay(!v.time);
                      if (v.time) setStartClock(v.time);
                      if (v.endTime) setEndClock(v.endTime);
                    }}
                    zone={timeZone}
                    label={t("planner.editor.eventTime")}
                    range
                    clearable={false}
                    disabled={busy || !!readOnly}
                  />
                  {!synthetic && !todo && (
                    <>
                      <PlanningField label={t("planner.editor.notification")}>
                        <PlanningSelect
                          disabled={busy || !!readOnly}
                          value={notify}
                          onValueChange={setNotify}
                          options={notificationOptions(
                            t,
                            snapshot.calendars.find((c) => c.id === calendarId)?.reminderMinutes,
                          )}
                        />
                      </PlanningField>
                      <PlanningField label={t("planner.editor.repeat")}>
                        <PlanningSelect
                          disabled={busy || !!readOnly}
                          value={frequency}
                          onValueChange={(value) => setFrequency(value as typeof frequency)}
                          options={[
                            { value: "", label: t("planner.repeat.none") },
                            { value: "daily", label: t("planner.repeat.daily") },
                            { value: "weekly", label: t("planner.repeat.weekly") },
                            { value: "monthly", label: t("planner.repeat.monthly") },
                          ]}
                        />
                      </PlanningField>
                      {frequency && (
                        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                          <PlanningField label={t("planner.editor.interval")}>
                            <Input
                              variant="plain"
                              type="number"
                              min={1}
                              max={365}
                              value={interval}
                              onChange={(e) => setInterval(e.target.value)}
                            />
                          </PlanningField>
                          <PlanningField label={t("planner.editor.repeatUntil")}>
                            <PlanningDateTimePicker
                              value={{ date: until, time: "" }}
                              onChange={(v) => setUntil(v.date)}
                              zone={timeZone}
                              dateOnly
                              label={t("planner.editor.repeatUntil")}
                              disabled={busy || !!readOnly}
                            />
                          </PlanningField>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </fieldset>
            {error && (
              <SettingsNotice role="alert" variant="action-error">
                {error}
              </SettingsNotice>
            )}
            {readOnly && <p>{t("planner.editor.externalReadOnly")}</p>}
          </form>
          {target.kind === "todo" && todo && (
            <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 text-sm [&>h3]:font-medium [&>p]:text-muted-foreground [&>small]:text-xs [&>small]:text-muted-foreground">
              {scheduled.length > 0 ? (
                <>
                  <h3>{t("planner.editor.scheduledTimes")}</h3>
                  {scheduled.map((e) => (
                    <p key={e.id}>
                      {e.time.kind === "timed"
                        ? zonedParts(e.time.startAt, zone).date
                        : e.time.startDate}{" "}
                      · {timeLabel(e.time, zone)}
                    </p>
                  ))}
                </>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("planner.editor.unscheduled")}</span>
                  {onSchedule && (
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      className="rounded-full"
                      disabled={busy}
                      onClick={() => onSchedule(todo)}
                    >
                      {t("planner.editor.schedule")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogActions className="w-full">
            {(todo || event) && !readOnly && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy}
                onClick={async () => {
                  if (
                    await confirm({
                      title: t("planner.common.moveToTrash"),
                      description:
                        todo && !event
                          ? t("planner.editor.trashTask")
                          : synthetic
                            ? t("planner.editor.trashOccurrence")
                            : event?.recurrence
                              ? t("planner.editor.trashSeries")
                              : t("planner.editor.trashEvent"),
                      confirmLabel: t("planner.common.moveToTrash"),
                      cancelLabel: t("planner.common.keep"),
                      preferCancel: true,
                    })
                  )
                    await remove();
                }}
              >
                {t("planner.common.moveToTrash")}
              </Button>
            )}

            <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={busy}>
              {t("planner.common.cancel")}
            </Button>
            {!readOnly && (
              <Button variant="default" size="sm" disabled={busy} type="submit" form={formId}>
                {busy ? t("planner.common.saving") : t("planner.common.save")}
              </Button>
            )}
          </DialogActions>
        </DialogFooter>
      </DialogContent>
      {dialog}
    </Dialog>
  );
}
