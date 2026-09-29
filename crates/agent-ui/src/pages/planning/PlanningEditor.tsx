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
import type {
  EventTime,
  PlanningEvent,
  PlanningSnapshot,
  Recurrence,
  Todo,
} from "../../lib/planning/types";
import { eventNotificationOptions } from "./notifyOptions";
import { PlanningField, PlanningSelect } from "./PlanningControls";
import { PlanningDateTimePicker } from "./PlanningDateTimePicker";
import { RecurrenceFields, type RepeatValue, repeatRule } from "./RecurrenceFields";
import { dayOffset, firstDay, rulePreset, seriesTime, shiftRuleDays } from "./recurrence";
import { type SeriesScope, useSeriesScope } from "./SeriesScopeDialog";
import { usePlanningT } from "./usePlanningT";

/** Values typed into the quick-create card, carried over by "More options". */
export interface EditorDraft {
  title: string;
  notes: string;
  calendarId?: string;
  groupId?: string;
  repeat?: RepeatValue;
  due?: { date: string; time: string };
  /** A new task's time block chosen in quick create; created together with the task. */
  schedule?: { calendarId: string; time: EventTime };
}
/** Compare rules ignoring null/undefined differences from storage. */
const ruleKey = (rule: Recurrence | null | undefined) =>
  rule
    ? JSON.stringify([
        rule.frequency,
        rule.interval,
        [...rule.weekdays].sort(),
        rule.count ?? null,
        rule.until ?? null,
      ])
    : "";
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
  // A new task's time block from quick create; the user may drop it here.
  const [schedule, setSchedule] = useState(draft?.schedule);
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
  // Occurrences of a recurring event (expanded instances and saved exceptions) edit the
  // series' rule; changes ask "此日程 / 所有日程" on save like Google.
  const seriesId = event?.seriesId && event.originalDate ? event.seriesId : undefined;
  const master = seriesId
    ? (snapshot.eventMasters ?? snapshot.events).find((e) => e.id === seriesId)
    : undefined;
  const synthetic = !!seriesId && !!event?.id.includes("@");
  const ruleSource = seriesId ? master?.recurrence : event?.recurrence;
  const masterDay = master ? firstDay(master.time) : undefined;
  const [repeat, setRepeat] = useState<RepeatValue>(
    draft?.repeat ?? {
      preset: rulePreset(ruleSource, masterDay ?? initialStart.date),
      rule: ruleSource ?? null,
    },
  );
  const { askScope, scopeDialog } = useSeriesScope();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  const readOnly = event && snapshot.calendars.find((c) => c.id === event.calendarId)?.readOnly;
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
  const save = async () => {
    let scope: SeriesScope | undefined;
    if (seriesId && event && title.trim()) {
      const rule = repeatRule(repeat, masterDay ?? startDate, ruleSource);
      const seriesOnly =
        ruleKey(rule) !== ruleKey(ruleSource) ||
        (synthetic &&
          (calendarId !== event.calendarId ||
            (notify === "" ? null : Number(notify)) !== (event.reminderMinutes ?? null)));
      const chosen = await askScope(t("planner.series.editTitle"), {
        allowThis: !seriesOnly,
        allowFollowing: event.originalDate !== masterDay,
      });
      if (!chosen) return;
      scope = chosen;
    }
    await perform(async () => {
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
          data: !todo && schedule ? { ...data, schedule } : data,
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
        const reminderMinutes = notify === "" ? null : Number(notify);
        if (scope === "all" && event?.originalDate) {
          if (!master || !masterDay) throw new Error(t("planner.series.missing"));
          const moved = seriesTime(masterDay, event.originalDate, time);
          // An untouched custom weekly rule moves its weekdays with the series.
          const seriesRule = () => {
            const rule = repeatRule(repeat, firstDay(moved), ruleSource);
            return rule && repeat.preset === "custom" && ruleKey(rule) === ruleKey(ruleSource)
              ? shiftRuleDays(rule, dayOffset(masterDay, firstDay(moved)))
              : rule;
          };
          await planningStore.mutate({
            action: "event.update",
            id: master.id,
            expectedRevision: master.revision,
            data: {
              title: title.trim(),
              notes,
              calendarId,
              reminderMinutes,
              time: moved,
              recurrence: seriesRule(),
            },
          });
        } else if (scope === "following" && event?.originalDate) {
          if (!master) throw new Error(t("planner.series.missing"));
          // Unchanged rules let the store carry the remaining count and deleted dates over.
          const rule = repeatRule(repeat, startDate, ruleSource);
          await planningStore.mutate({
            action: "event.split",
            id: master.id,
            expectedRevision: master.revision,
            data: {
              date: event.originalDate,
              title: title.trim(),
              notes,
              calendarId,
              reminderMinutes,
              time,
              ...(ruleKey(rule) === ruleKey(ruleSource)
                ? {}
                : { recurrence: rule && { ...rule, excludedDates: [] } }),
            },
          });
        } else if (synthetic && event?.seriesId) {
          await planningStore.mutate({
            action: "event.exception",
            id: event.seriesId,
            expectedRevision: event.revision,
            data: { date: event.originalDate, time, title, notes },
          });
        } else if (seriesId && event) {
          // A saved exception is an ordinary event row.
          await planningStore.mutate({
            action: "event.update",
            id: event.id,
            expectedRevision: event.revision,
            data: { title: title.trim(), notes, calendarId, time, reminderMinutes },
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
              reminderMinutes,
              recurrence: todo ? null : repeatRule(repeat, startDate, ruleSource),
            },
          });
        }
      }
    });
  };
  const remove = (scope?: SeriesScope) =>
    perform(async () => {
      if (event && scope === "following" && event.originalDate) {
        if (!master) throw new Error(t("planner.series.missing"));
        await planningStore.mutate({
          action: "event.split",
          id: master.id,
          expectedRevision: master.revision,
          data: { date: event.originalDate, delete: true },
        });
      } else if (event && scope === "all") {
        if (!master) throw new Error(t("planner.series.missing"));
        await planningStore.mutate({
          action: "event.delete",
          id: master.id,
          expectedRevision: master.revision,
          data: {},
        });
      } else if (event)
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
                  disabled={target.kind === "event" && !!todo && !event}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                />
              </PlanningField>
              {target.kind === "todo" ? (
                <>
                  {!todo && schedule && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">
                        {t("planner.editor.scheduledTimes")}
                      </span>
                      <span className="min-w-0 truncate">
                        {schedule.time.kind === "timed"
                          ? zonedParts(schedule.time.startAt, zone).date
                          : schedule.time.startDate}{" "}
                        · {timeLabel(schedule.time, zone)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto shrink-0"
                        onClick={() => setSchedule(undefined)}
                      >
                        {t("planner.quick.removeSchedule")}
                      </Button>
                    </div>
                  )}
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
                  {todo && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">{t("planner.taskList")}</span>
                      <span>
                        {snapshot.groups?.find((g) => g.id === todo.groupId)?.name ??
                          t("planner.myTasks")}
                      </span>
                    </div>
                  )}
                  {
                    <PlanningField label={t("planner.calendar")}>
                      <PlanningSelect
                        disabled={busy || !!readOnly}
                        value={calendarId}
                        onValueChange={(value) => setCalendarId(value)}
                        options={[
                          ...(snapshot.calendars
                            .filter((c) => !c.readOnly || c.id === calendarId)
                            .map((c) => ({ value: c.id, label: calendarName(c) })) ?? []),
                        ]}
                      />
                    </PlanningField>
                  }
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
                  {(event || !todo) && (
                    <PlanningField label={t("planner.editor.notification")}>
                      <PlanningSelect
                        disabled={busy || !!readOnly}
                        value={notify}
                        onValueChange={setNotify}
                        options={eventNotificationOptions(
                          t,
                          snapshot.calendars.find((c) => c.id === calendarId)?.reminderMinutes,
                          notify,
                        )}
                      />
                    </PlanningField>
                  )}
                  {!todo && (
                    <RecurrenceFields
                      value={repeat}
                      date={masterDay ?? startDate}
                      zone={timeZone}
                      disabled={busy || !!readOnly}
                      onChange={setRepeat}
                    />
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
                  if (seriesId && event) {
                    const scope = await askScope(t("planner.series.deleteTitle"), {
                      allowFollowing: event.originalDate !== masterDay,
                    });
                    if (scope) await remove(scope);
                    return;
                  }
                  if (
                    await confirm({
                      title: t("planner.common.moveToTrash"),
                      description:
                        todo && !event
                          ? t("planner.editor.trashTask")
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
      {scopeDialog}
    </Dialog>
  );
}
