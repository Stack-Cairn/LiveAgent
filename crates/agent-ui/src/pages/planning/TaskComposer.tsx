import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, List, ListFilter } from "../../components/IconSet";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { type DateTimeValue, dateTimeEvent } from "../../lib/planning/dateTime";
import { localizePlanningError } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import type { EventTime, Todo } from "../../lib/planning/types";
import { PlanningDateTimePicker } from "./PlanningDateTimePicker";
import { usePlanningT } from "./usePlanningT";
export function TaskComposer({
  listId,
  zone,
  calendarId,
  sort,
  onSort,
  parent,
  onClose,
}: {
  listId: string;
  zone: string;
  calendarId?: string;
  sort?: string;
  onSort?(value: string): void;
  parent?: Todo;
  onClose?(): void;
}) {
  const { t } = usePlanningT();

  const [open, setOpen] = useState(!!parent),
    [title, setTitle] = useState(""),
    [notes, setNotes] = useState("");
  const [schedule, setSchedule] = useState<DateTimeValue>({ date: "", time: "" });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) titleInput.current?.focus();
  }, [open]);
  const clear = () => {
    setOpen(false);
    setTitle("");
    setNotes("");
    setSchedule({ date: "", time: "" });
    onClose?.();
    setError("");
  };
  const save = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      let time: EventTime | undefined;
      if (schedule.date) {
        if (!calendarId) throw Error(t("planner.composer.needCalendar"));
        time = dateTimeEvent(schedule, zone);
      }
      await planningStore.mutate({
        action: "todo.create",
        data: {
          title: title.trim(),
          notes,
          ...(parent ? { parentId: parent.id } : {}),
          groupId: listId === "starred" ? null : listId || null,
          ...(listId === "starred" ? { priority: "high" } : {}),
          ...(time ? { schedule: { calendarId, time } } : {}),
        },
      });
      clear();
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shrink-0 border-b border-border/50">
      {!parent && (
        <div className="flex items-center gap-1 px-2 py-1">
          <Button
            variant="ghost"
            className={`h-8 min-w-0 flex-1 justify-start gap-2 rounded-full px-3 text-sm font-medium text-primary ${open ? "bg-accent" : ""}`}
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <CheckCircle2 className="size-4" />
            {t("planner.composer.add")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" />}
              aria-label={t("planner.composer.sortOptions")}
            >
              <ListFilter className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {[
                { id: "manual", name: t("planner.sort.manual") },
                { id: "created", name: t("planner.sort.created") },
                { id: "title", name: t("planner.sort.title") },
                { id: "priority", name: t("planner.sort.starred") },
              ].map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  disabled={sort === item.id}
                  onClick={() => onSort?.(item.id)}
                >
                  {item.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {open && (
        <form
          className="space-y-1.5 bg-accent/35 px-3 pb-2 pt-1.5"
          aria-label={
            parent
              ? t("planner.composer.addSubtaskFor", { title: parent.title })
              : t("planner.composer.details")
          }
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) {
              e.stopPropagation();
              clear();
            }
          }}
        >
          <div className="flex items-center gap-2">
            <Circle className="size-4 shrink-0 text-muted-foreground" />
            <Input
              variant="plain"
              className="h-8 border-0 bg-transparent px-0 shadow-none"
              ref={titleInput}
              aria-label={
                parent ? t("planner.composer.subtaskTitle") : t("planner.composer.taskTitle")
              }
              placeholder={parent ? t("planner.composer.subtaskTitle") : t("planner.editor.title")}
              value={title}
              maxLength={500}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex items-start gap-2">
            <List className="mt-1.5 size-4 shrink-0 text-muted-foreground" />
            <Textarea
              className="min-h-7 resize-none border-0 bg-transparent px-0 py-1 shadow-none"
              aria-label={t("planner.composer.notesLabel")}
              placeholder={t("planner.composer.notes")}
              rows={1}
              value={notes}
              maxLength={20000}
              disabled={busy}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            <PlanningDateTimePicker
              value={schedule}
              onChange={setSchedule}
              zone={zone}
              label={t("planner.dateTime.label")}
              range
              disabled={busy}
              className="h-7 rounded-full px-2"
            />
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={busy}
                onClick={clear}
              >
                {t("planner.common.cancel")}
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="submit"
                disabled={busy || !title.trim()}
              >
                {busy ? t("planner.common.saving") : t("planner.common.save")}
              </Button>
            </div>
          </div>
          {error && (
            <SettingsNotice role="alert" variant="inline-error">
              {error}
            </SettingsNotice>
          )}
        </form>
      )}
    </div>
  );
}
