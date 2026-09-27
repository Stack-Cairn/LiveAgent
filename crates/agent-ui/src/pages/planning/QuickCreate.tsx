import { type ReactNode, useState } from "react";
import { CalendarDays, Clock3, List, ListChecks, Target, X } from "../../components/IconSet";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Popover, PopoverContent, PopoverTitle } from "../../components/ui/popover";
import { Textarea } from "../../components/ui/textarea";
import { calendarName, localizePlanningError } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import { homeTaskList, taskLists } from "../../lib/planning/taskLists";
import { addDays, localEpoch, zonedParts } from "../../lib/planning/time";
import type { EventTime, PlanningSnapshot } from "../../lib/planning/types";
import { PlanningSelect } from "./PlanningControls";
import { PlanningDateTimePicker } from "./PlanningDateTimePicker";
import type { EditorDraft, EditorTarget } from "./PlanningEditor";
import { usePlanningT } from "./usePlanningT";

export type QuickKind = EditorTarget["kind"];

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-4">
      <span className="flex h-8 w-5 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Dot({ color }: { color?: string }) {
  return (
    <span
      className="mr-2 inline-block size-2.5 shrink-0 rounded-full align-middle"
      style={{ background: color }}
    />
  );
}

/**
 * Google-style quick create: a card beside the draft block with title, 活动/任务 tabs and the
 * essentials. "More options" carries everything typed so far into the full editor.
 */
export function QuickCreate({
  kind,
  time,
  anchor,
  snapshot,
  onKind,
  onTitleChange,
  onTimeChange,
  onClose,
  onMore,
}: {
  kind: QuickKind;
  time: EventTime;
  anchor: Element;
  snapshot: PlanningSnapshot;
  onKind(kind: QuickKind): void;
  /** Mirrors the title into the draft block. */
  onTitleChange(title: string): void;
  /** Keeps the draft block in the grid in sync with the chosen time. */
  onTimeChange(time: EventTime): void;
  onClose(): void;
  onMore(target: EditorTarget): void;
}) {
  const { t } = usePlanningT();
  const zone = time.timeZone || snapshot.timeZone;
  const start =
    time.kind === "timed" ? zonedParts(time.startAt, zone) : { date: time.startDate, time: "" };
  const end =
    time.kind === "timed"
      ? zonedParts(time.endAt, zone)
      : { date: addDays(time.endDateExclusive, -1), time: "" };
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [calendarId, setCalendarId] = useState(
    snapshot.calendars.find((c) => c.isDefault && !c.readOnly)?.id ??
      snapshot.calendars.find((c) => !c.readOnly)?.id ??
      "",
  );
  const [groupId, setGroupId] = useState(homeTaskList(snapshot));
  const [frequency, setFrequency] = useState<NonNullable<EditorDraft["frequency"]>>("");
  // Google tasks take a time block plus an optional, separate deadline.
  const [due, setDue] = useState({ date: "", time: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const draft = (): EditorDraft => ({
    title,
    notes,
    calendarId,
    groupId,
    frequency,
    due: due.date ? due : undefined,
    schedule: { calendarId, time },
  });
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const name = title.trim() || t("planner.quick.untitled");
      if (kind === "todo") {
        await planningStore.mutate({
          action: "todo.create",
          data: {
            title: name,
            notes,
            groupId: groupId || null,
            dueAt: due.date && due.time ? localEpoch(due.date, due.time, zone) : null,
            dueDate: due.date && !due.time ? due.date : null,
            dueTimeZone: due.date ? zone : null,
            // The dragged range becomes the task's block in the calendar, as in Google.
            schedule: { calendarId, time },
          },
        });
      } else {
        await planningStore.mutate({
          action: "event.create",
          data: {
            title: name,
            notes,
            calendarId,
            time,
            recurrence: frequency
              ? {
                  frequency,
                  interval: 1,
                  weekdays: [],
                  excludedDates: [],
                  until: null,
                  count: null,
                }
              : null,
          },
        });
      }
      onClose();
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
      setBusy(false);
    }
  };
  const setAllDay = (allDay: boolean) =>
    onTimeChange(
      allDay
        ? {
            kind: "allDay",
            startDate: start.date,
            endDateExclusive: addDays(end.date, 1),
            timeZone: zone,
          }
        : {
            kind: "timed",
            startAt: localEpoch(start.date, "09:00", zone),
            endAt: localEpoch(start.date, "10:00", zone),
            timeZone: zone,
          },
    );
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <PopoverContent
        anchor={anchor}
        side="left"
        align="start"
        sideOffset={12}
        className="w-[28rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl bg-popover p-0 shadow-xl"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex items-center justify-end bg-muted/50 px-3 py-2">
            <PopoverTitle className="sr-only">{t("planner.quick.label")}</PopoverTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label={t("planner.common.close")}
              disabled={busy}
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
          <fieldset className="space-y-4 px-5 pb-4 pt-3" disabled={busy}>
            <div className="pl-9">
              <Input
                variant="plain"
                autoFocus
                aria-label={t("planner.editor.title")}
                placeholder={t("planner.editor.addTitle")}
                className="h-11 rounded-none border-0 border-b bg-transparent px-0 text-xl shadow-none focus:bg-transparent focus:ring-0 focus-visible:border-primary focus-visible:ring-0"
                maxLength={500}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  onTitleChange(e.target.value);
                }}
              />
            </div>
            <fieldset className="flex gap-2 pl-9" aria-label={t("planner.editor.createKind")}>
              {(
                [
                  ["event", t("planner.kind.event")],
                  ["todo", t("planner.kind.task")],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={kind === value ? "secondary" : "ghost"}
                  className="rounded-lg px-3"
                  aria-pressed={kind === value}
                  onClick={() => value !== kind && onKind(value)}
                >
                  {label}
                </Button>
              ))}
            </fieldset>
            <Row icon={<Clock3 className="size-5" />}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <PlanningDateTimePicker
                  value={{
                    date: start.date,
                    time: start.time,
                    endDate: end.date,
                    endTime: end.time,
                  }}
                  onChange={(v) =>
                    onTimeChange(
                      v.time
                        ? {
                            kind: "timed",
                            startAt: localEpoch(v.date, v.time, zone),
                            endAt: localEpoch(v.endDate || v.date, v.endTime || v.time, zone),
                            timeZone: zone,
                          }
                        : {
                            kind: "allDay",
                            startDate: v.date,
                            endDateExclusive: addDays(v.endDate || v.date, 1),
                            timeZone: zone,
                          },
                    )
                  }
                  zone={zone}
                  label={t("planner.editor.eventTime")}
                  range
                  clearable={false}
                />
                <Label className="flex items-center gap-2 text-sm font-normal">
                  <Checkbox
                    checked={time.kind === "allDay"}
                    onCheckedChange={(checked) => setAllDay(checked)}
                  />
                  {t("planner.allDay")}
                </Label>
              </div>
              {kind === "event" && (
                <PlanningSelect
                  className="mt-2 w-auto"
                  aria-label={t("planner.editor.repeat")}
                  value={frequency}
                  onValueChange={(value) => setFrequency(value as typeof frequency)}
                  options={[
                    { value: "", label: t("planner.repeat.none") },
                    { value: "daily", label: t("planner.repeat.daily") },
                    { value: "weekly", label: t("planner.repeat.weekly") },
                    { value: "monthly", label: t("planner.repeat.monthly") },
                  ]}
                />
              )}
            </Row>
            {kind === "todo" && (
              <Row icon={<Target className="size-5" />}>
                <PlanningDateTimePicker
                  value={due}
                  onChange={(v) => setDue({ date: v.date, time: v.time })}
                  zone={zone}
                  label={t("planner.quick.addDue")}
                />
              </Row>
            )}
            <Row icon={<List className="size-5" />}>
              <Textarea
                variant="plain"
                rows={1}
                aria-label={t("planner.editor.notes")}
                placeholder={t("planner.quick.addNotes")}
                className="min-h-8 resize-none border-0 bg-transparent px-0 py-1.5 shadow-none focus:bg-transparent focus:ring-0 focus-visible:ring-0 field-sizing-content max-h-32"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Row>
            {kind === "todo" ? (
              <Row icon={<ListChecks className="size-5" />}>
                <PlanningSelect
                  className="w-auto"
                  aria-label={t("planner.taskList")}
                  value={groupId}
                  onValueChange={setGroupId}
                  options={taskLists(snapshot).map((list) => ({
                    value: list.id,
                    label: (
                      <>
                        <Dot color={list.color} />
                        {list.name}
                      </>
                    ),
                  }))}
                />
              </Row>
            ) : (
              <Row icon={<CalendarDays className="size-5" />}>
                <PlanningSelect
                  className="w-auto"
                  aria-label={t("planner.calendar")}
                  value={calendarId}
                  onValueChange={setCalendarId}
                  options={snapshot.calendars
                    .filter((c) => !c.readOnly)
                    .map((c) => ({
                      value: c.id,
                      label: (
                        <>
                          <Dot color={c.color} />
                          {calendarName(c)}
                        </>
                      ),
                    }))}
                />
              </Row>
            )}
            {error && (
              <SettingsNotice role="alert" variant="action-error">
                {error}
              </SettingsNotice>
            )}
          </fieldset>
          <div className="flex items-center justify-end gap-2 px-5 pb-5">
            <Button
              type="button"
              variant="ghost"
              className="rounded-full text-primary"
              disabled={busy}
              onClick={() =>
                onMore(kind === "todo" ? { kind, draft: draft() } : { kind, time, draft: draft() })
              }
            >
              {t("planner.quick.more")}
            </Button>
            <Button type="submit" className="rounded-full px-6" disabled={busy}>
              {busy ? t("planner.common.saving") : t("planner.common.save")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
