import { useState } from "react";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
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
import {
  IMPORT_BATCH,
  type ImportPreview,
  readCalendarFile,
} from "../../lib/planning/calendarImport";
import { calendarName, localizePlanningError, translate } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import { addDays, timeLabel, zonedParts } from "../../lib/planning/time";
import type { PlanningSnapshot } from "../../lib/planning/types";
import { PlanningField, PlanningSelect } from "./PlanningControls";

const PREVIEW_ROWS = 100;
function chunks<T>(items: T[]) {
  return Array.from({ length: Math.ceil(items.length / IMPORT_BATCH) }, (_, i) =>
    items.slice(i * IMPORT_BATCH, (i + 1) * IMPORT_BATCH),
  );
}

export function CalendarImport({
  snapshot,
  onClose,
}: {
  snapshot: PlanningSnapshot;
  onClose(): void;
}) {
  const [calendarId, setCalendarId] = useState(
    snapshot.calendars.find((c) => c.isDefault)?.id ?? "",
  );
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<ImportPreview | null>(null);
  const [from, setFrom] = useState(zonedParts(Date.now(), snapshot.timeZone).date),
    [to, setTo] = useState(addDays(from, 90));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState(""),
    [progress, setProgress] = useState("");
  const review = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult("");
    setPreview(null);
    try {
      setPreview(await readCalendarFile(file, { from, to, zone: snapshot.timeZone }));
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
      setBusy(false);
    }
  };
  const total = (preview?.entries.length ?? 0) + (preview?.tasks.length ?? 0);
  // The backend accepts 200 items per request; larger exports are sent in ordered batches
  // (task parents precede subtasks, so later batches can attach to earlier ones).
  const save = async () => {
    if (!preview || !total) return;
    setBusy(true);
    setError("");
    const done = { events: 0, tasks: 0, skipped: 0 };
    try {
      const calendar = snapshot.calendars.find((c) => c.id === calendarId);
      if (preview.entries.length && !calendar)
        throw Error(translate("planner.import.needCalendar"));
      const batches = [
        ...chunks(preview.entries).map((entries) => ({ kind: "events" as const, entries })),
        ...chunks(preview.tasks).map((entries) => ({ kind: "tasks" as const, entries })),
      ];
      for (const [index, batch] of batches.entries()) {
        setProgress(
          translate("planner.import.progress", { current: index + 1, total: batches.length }),
        );
        const saved = await planningStore.mutate<{ imported: number; skipped: number }>(
          batch.kind === "events"
            ? {
                action: "calendar.import",
                id: calendar?.id,
                expectedRevision: calendar?.revision,
                data: { entries: batch.entries },
              }
            : { action: "todo.import", data: { entries: batch.entries } },
        );
        done[batch.kind] += saved?.imported ?? 0;
        done.skipped += saved?.skipped ?? 0;
      }
      setPreview(null);
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
      setResult(
        done.events || done.tasks || done.skipped ? translate("planner.import.doneAll", done) : "",
      );
      setProgress("");
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-85dvh max-w-xl flex-col"
        showCloseButton
        closeLabel={translate("planner.common.close")}
        closeDisabled={busy}
      >
        <DialogHeader>
          <DialogTitle>{translate("planner.import.title")}</DialogTitle>
          <DialogDescription>{translate("planner.import.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <PlanningField label={translate("planner.import.target")}>
            <PlanningSelect
              value={calendarId}
              disabled={busy}
              onValueChange={setCalendarId}
              options={snapshot.calendars
                .filter((c) => !c.readOnly)
                .map((c) => ({ value: c.id, label: calendarName(c) }))}
            />
          </PlanningField>
          <div className="grid grid-cols-2 gap-3">
            <PlanningField label={translate("planner.import.startDate")}>
              <Input
                variant="plain"
                type="date"
                value={from}
                disabled={busy}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPreview(null);
                }}
              />
            </PlanningField>
            <PlanningField label={translate("planner.import.endDate")}>
              <Input
                variant="plain"
                type="date"
                value={to}
                disabled={busy}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPreview(null);
                }}
              />
            </PlanningField>
          </div>
          <PlanningField
            label={translate("planner.import.file")}
            description={translate("planner.import.fileHint")}
          >
            <Input
              type="file"
              accept=".ics,.eml,.zip,.json,text/calendar,message/rfc822,application/zip,application/json"
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setResult("");
              }}
            />
          </PlanningField>
          {error && (
            <SettingsNotice variant="action-error" role="alert">
              {error}
            </SettingsNotice>
          )}
          {result && (
            <p role="status" className="text-sm text-success">
              {result}
            </p>
          )}
          {preview && (
            <div className="space-y-3">
              <p className="text-sm font-medium">
                {translate("planner.import.previewCounts", {
                  events: preview.entries.length,
                  tasks: preview.tasks.length,
                })}
              </p>
              {preview.warnings.length > 0 && (
                <SettingsNotice variant="warning" role="status">
                  <p>{translate("planner.import.skippedTitle")}</p>
                  <ul className="list-disc pl-4">
                    {[...new Set(preview.warnings)].map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </SettingsNotice>
              )}
              <ul className="divide-y divide-border">
                {preview.entries.slice(0, PREVIEW_ROWS).map((entry) => (
                  <li key={entry.uid} className="py-2">
                    <p className="text-sm">{entry.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.time.kind === "timed"
                        ? zonedParts(entry.time.startAt, snapshot.timeZone).date
                        : ""}{" "}
                      {timeLabel(entry.time, snapshot.timeZone)}
                    </p>
                  </li>
                ))}
                {preview.tasks.slice(0, PREVIEW_ROWS).map((task) => (
                  <li key={task.uid} className="py-2">
                    <p className="text-sm">
                      {task.parentUid ? "↳ " : ""}
                      {task.title}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[
                        translate("planner.import.taskList", {
                          name: task.list || translate("planner.myTasks"),
                        }),
                        task.dueDate,
                        task.status === "completed" ? translate("planner.status.completed") : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
              {total > PREVIEW_ROWS * 2 && (
                <p className="text-xs text-muted-foreground">
                  {translate("planner.import.previewTruncated")}
                </p>
              )}
            </div>
          )}
          {progress && (
            <p role="status" className="text-sm text-muted-foreground">
              {progress}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogActions>
            <Button
              variant="outline"
              disabled={busy || !file || !from || !to}
              onClick={() => void review()}
            >
              {busy ? translate("planner.import.processing") : translate("planner.import.preview")}
            </Button>
            <Button disabled={busy || !total} onClick={() => void save()}>
              {translate("planner.import.submit", { count: total })}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
