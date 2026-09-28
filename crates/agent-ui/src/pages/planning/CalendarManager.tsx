import { useId, useState } from "react";
import { Plus } from "../../components/IconSet";
import { SettingsNotice } from "../../components/settings/SettingsNotice";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
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
import { calendarName, localizePlanningError } from "../../lib/planning/i18n";
import { planningStore } from "../../lib/planning/store";
import type { PlanningCalendar, PlanningSnapshot } from "../../lib/planning/types";
import { ColorSwatches, PLANNING_COLORS, PlanningField, PlanningSelect } from "./PlanningControls";
import { usePlanningT } from "./usePlanningT";
export function CalendarManager({
  snapshot,
  onClose,
}: {
  snapshot: PlanningSnapshot;
  onClose(): void;
}) {
  const { t } = usePlanningT();
  const formId = useId();
  const [selected, setSelected] = useState<PlanningCalendar | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PLANNING_COLORS[0]);
  const [minutes, setMinutes] = useState("0");
  const [isDefault, setIsDefault] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const select = (calendar: PlanningCalendar | null) => {
    setSelected(calendar);
    setName(calendar?.name ?? "");
    setColor(calendar?.color ?? PLANNING_COLORS[0]);
    setMinutes(calendar?.reminderMinutes === null ? "" : String(calendar?.reminderMinutes ?? 0));
    setIsDefault(calendar?.isDefault ?? false);
    setDeleting(false);
    setError("");
  };
  // Subscribed calendars are read-only mirrors, but their name and color are local choices.
  const subscribed = selected?.sourceKind === "subscription";
  const locked = !!selected?.readOnly && !subscribed;
  const run = async (remove: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (remove && selected)
        await planningStore.mutate({
          action: "calendar.delete",
          id: selected.id,
          expectedRevision: selected.revision,
          data: { moveTo },
        });
      else if (selected && subscribed)
        await planningStore.command("subscription.update", {
          id: selected.id,
          name: name.trim(),
          color,
        });
      else if (selected)
        await planningStore.mutate({
          action: "calendar.update",
          id: selected.id,
          expectedRevision: selected.revision,
          data: {
            name,
            color,
            reminderMinutes: minutes === "" ? null : Number(minutes),
            isDefault,
          },
        });
      else {
        const calendar = await planningStore.mutate<PlanningCalendar>({
          action: "calendar.create",
          data: { name, color },
        });
        if (calendar && (minutes !== "0" || isDefault))
          await planningStore.mutate({
            action: "calendar.update",
            id: calendar.id,
            expectedRevision: calendar.revision,
            data: {
              reminderMinutes: minutes === "" ? null : Number(minutes),
              ...(isDefault ? { isDefault } : {}),
            },
          });
      }
      select(null);
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
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
        className="flex max-h-85dvh max-w-2xl flex-col"
        showCloseButton
        closeLabel={t("planner.common.close")}
        closeDisabled={busy}
      >
        <DialogHeader>
          <DialogTitle>{t("planner.toolbar.manageCalendars")}</DialogTitle>
          <DialogDescription>{t("planner.calendar.manageHint")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid min-w-0 gap-5 sm:grid-cols-[11rem_minmax(0,1fr)]">
            {/* Calendar list on the left, like Google's settings sidebar. */}
            <nav
              className="flex flex-col gap-0.5 sm:border-r sm:border-border sm:pr-3"
              aria-label={t("planner.toolbar.manageCalendars")}
            >
              {snapshot.calendars.map((c) => (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  key={c.id}
                  onClick={() => select(c)}
                  className="justify-start gap-2 font-normal aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                  disabled={busy}
                  aria-pressed={selected?.id === c.id}
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{calendarName(c)}</span>
                  {(c.isDefault || c.readOnly) && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {c.isDefault ? t("planner.calendar.default") : t("planner.calendar.readOnly")}
                    </span>
                  )}
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={busy}
                aria-pressed={selected === null}
                className="justify-start gap-2 font-normal aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                onClick={() => select(null)}
              >
                <Plus className="size-4" />
                {t("planner.calendar.new")}
              </Button>
            </nav>
            <div className="min-w-0">
              <form
                id={formId}
                className="flex min-h-0 flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(false);
                }}
              >
                <fieldset className="min-w-0 space-y-4" disabled={busy || locked}>
                  <PlanningField label={t("planner.calendar.name")}>
                    <Input
                      variant="plain"
                      required
                      maxLength={60}
                      placeholder={t("planner.calendar.namePlaceholder")}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </PlanningField>
                  <ColorSwatches
                    label={t("planner.calendar.color")}
                    value={color}
                    disabled={busy || locked}
                    onChange={setColor}
                  />
                  {/* The "Default" choice of each event's notification reads this value. */}
                  <PlanningField
                    label={t("planner.calendar.eventNotification")}
                    description={t("planner.calendar.eventNotificationHint")}
                  >
                    <PlanningSelect
                      disabled={busy || selected?.readOnly}
                      value={minutes}
                      onValueChange={(value) => setMinutes(value)}
                      options={[
                        { value: "", label: t("planner.calendar.noReminder") },
                        ...([0, 5, 15, 30, 60, 1440].map((m) => ({
                          value: m,
                          label:
                            m === 0
                              ? t("planner.calendar.atStart")
                              : m === 1440
                                ? t("planner.calendar.dayBefore")
                                : t("planner.calendar.minutesBefore", { count: m }),
                        })) ?? []),
                      ]}
                    />
                  </PlanningField>
                  <Label className="flex items-center gap-2 text-sm font-normal">
                    <Checkbox
                      checked={isDefault}
                      disabled={busy || selected?.readOnly || selected?.isDefault}
                      onCheckedChange={(checked) => setIsDefault(checked)}
                    />
                    {t("planner.calendar.makeDefault")}
                  </Label>
                  {subscribed && (
                    <p className="text-xs text-muted-foreground">
                      {t("planner.calendar.subscribedHint")}
                    </p>
                  )}
                </fieldset>
                {error && (
                  <SettingsNotice role="alert" variant="action-error">
                    {error}
                  </SettingsNotice>
                )}
              </form>
              {deleting && selected && (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm [&>p]:w-full">
                  <p>{t("planner.calendar.deleteMove", { name: calendarName(selected) })}</p>
                  <PlanningSelect
                    disabled={busy || selected?.readOnly}
                    aria-label={t("planner.calendar.moveTo")}
                    value={moveTo}
                    onValueChange={(value) => setMoveTo(value)}
                    options={[
                      ...(snapshot.calendars
                        .filter((c) => c.id !== selected.id && !c.readOnly)
                        .map((c) => ({ value: c.id, label: calendarName(c) })) ?? []),
                    ]}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={busy || !moveTo}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => void run(true)}
                  >
                    {t("planner.calendar.moveAndDelete")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDeleting(false)}
                  >
                    {t("planner.common.cancel")}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogActions className="w-full">
            {selected && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={
                  busy ||
                  selected.readOnly ||
                  snapshot.calendars.filter((c) => !c.readOnly).length < 2
                }
                onClick={() => {
                  setDeleting(true);
                  setMoveTo(
                    snapshot.calendars.find((c) => c.id !== selected.id && !c.readOnly)?.id ?? "",
                  );
                }}
              >
                {t("planner.calendar.delete")}
              </Button>
            )}
            <Button
              variant="default"
              size="sm"
              type="submit"
              form={formId}
              disabled={busy || locked}
            >
              {busy
                ? t("planner.common.saving")
                : selected
                  ? t("planner.common.save")
                  : t("planner.calendar.create")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
