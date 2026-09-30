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
import { CRON_LAYER_COLOR } from "../../lib/planning/cronLayer";
import { calendarName, localizePlanningError } from "../../lib/planning/i18n";
import {
  type LayerGroup,
  type LayerRef,
  layerIdOf,
  listLayers,
  nextPaletteColor,
  PLANNING_COLORS,
} from "../../lib/planning/layers";
import { planningStore } from "../../lib/planning/store";
import { homeTaskList } from "../../lib/planning/taskLists";
import type {
  PlanningCalendar,
  PlanningCategory,
  PlanningSnapshot,
} from "../../lib/planning/types";
import { useCalendarPreferences } from "./calendarDisplay";
import { calendarNotificationOptions } from "./notifyOptions";
import { ColorSwatches, PlanningField, PlanningSelect } from "./PlanningControls";
import { type TaskListAction, TaskListDialog } from "./TaskListDialog";
import { usePlanningT } from "./usePlanningT";

type Selection = LayerRef | { kind: "newCalendar" } | { kind: "newList" };
const GROUP_TITLES: Record<LayerGroup, string> = {
  mine: "planner.sidebar.myCalendars",
  tasks: "planner.sidebar.taskLists",
  other: "planner.sidebar.otherCalendars",
  cron: "planner.cron.layer",
};
const CRON_COLORS = [
  CRON_LAYER_COLOR,
  ...PLANNING_COLORS.filter((c) => c.toLowerCase() !== CRON_LAYER_COLOR),
];

/**
 * 「日历与列表」: the one place to name and color every calendar, task list and the
 * scheduled-task layer. Visibility stays in the sidebar (it is a per-device view choice).
 */
export function LayerManager({
  snapshot,
  initial,
  onClose,
}: {
  snapshot: PlanningSnapshot;
  /** Open with this row selected (e.g. from a sidebar row or a settings row). */
  initial?: LayerRef;
  onClose(): void;
}) {
  const { t } = usePlanningT();
  const formId = useId();
  const [preferences, setPreferences] = useCalendarPreferences();
  const layers = listLayers(snapshot, preferences.cronColor);
  const [selection, setSelection] = useState<Selection>(
    initial ?? layers[0]?.ref ?? { kind: "newCalendar" },
  );
  const calendar =
    selection.kind === "calendar"
      ? snapshot.calendars.find((c) => c.id === selection.id)
      : undefined;
  const group =
    selection.kind === "taskList" && selection.id
      ? snapshot.groups?.find((g) => g.id === selection.id)
      : undefined;
  const fields = (next: Selection) => {
    const cal =
      next.kind === "calendar" ? snapshot.calendars.find((c) => c.id === next.id) : undefined;
    const layer = layers.find((l) => "id" in next && l.layerId === layerIdOf(next as LayerRef));
    return {
      name: cal?.name ?? (next.kind === "taskList" ? (layer?.name ?? "") : ""),
      color:
        next.kind === "newCalendar"
          ? nextPaletteColor(snapshot.calendars.map((c) => c.color))
          : next.kind === "newList"
            ? nextPaletteColor(layers.filter((l) => l.group === "tasks").map((l) => l.color))
            : (layer?.color ?? PLANNING_COLORS[0]),
      minutes: cal ? (cal.reminderMinutes === null ? "" : String(cal.reminderMinutes)) : "0",
      isDefault: cal?.isDefault ?? false,
    };
  };
  const [form, setForm] = useState(() => fields(selection));
  const [moveTo, setMoveTo] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [listAction, setListAction] = useState<TaskListAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const select = (next: Selection) => {
    setSelection(next);
    setForm(fields(next));
    setDeleting(false);
    setError("");
  };
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const subscribed = calendar?.sourceKind === "subscription";
  // Imported read-only calendars keep their name; only the color is a local choice.
  const colorOnly = !!calendar?.readOnly && !subscribed;
  const myTasks = selection.kind === "taskList" && selection.id === "";
  const isCron = selection.kind === "cron";
  const localCalendar = selection.kind === "newCalendar" || (calendar && !calendar.readOnly);
  const nameLocked = colorOnly || myTasks;

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const name = form.name.trim();
      if (selection.kind === "newCalendar") {
        const created = await planningStore.mutate<PlanningCalendar>({
          action: "calendar.create",
          data: { name, color: form.color },
        });
        if (created && (form.minutes !== "0" || form.isDefault))
          await planningStore.mutate({
            action: "calendar.update",
            id: created.id,
            expectedRevision: created.revision,
            data: {
              reminderMinutes: form.minutes === "" ? null : Number(form.minutes),
              ...(form.isDefault ? { isDefault: true } : {}),
            },
          });
        if (created) select({ kind: "calendar", id: created.id });
      } else if (selection.kind === "newList") {
        const created = await planningStore.mutate<PlanningCategory>({
          action: "group.create",
          data: { name, color: form.color },
        });
        if (created) select({ kind: "taskList", id: created.id });
      } else if (calendar && subscribed) {
        await planningStore.command("subscription.update", {
          id: calendar.id,
          name,
          color: form.color,
        });
      } else if (calendar) {
        await planningStore.mutate({
          action: "calendar.update",
          id: calendar.id,
          expectedRevision: calendar.revision,
          data: colorOnly
            ? { color: form.color }
            : {
                name,
                color: form.color,
                reminderMinutes: form.minutes === "" ? null : Number(form.minutes),
                isDefault: form.isDefault,
              },
        });
      } else if (myTasks) {
        await planningStore.mutate({ action: "mytasks.update", data: { color: form.color } });
      } else if (group) {
        await planningStore.mutate({
          action: "group.update",
          id: group.id,
          expectedRevision: group.revision,
          data: { name, color: form.color },
        });
      }
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
      setBusy(false);
    }
  };
  const removeCalendar = async () => {
    if (!calendar) return;
    setBusy(true);
    setError("");
    try {
      await planningStore.mutate({
        action: "calendar.delete",
        id: calendar.id,
        expectedRevision: calendar.revision,
        data: { moveTo },
      });
      select(layers[0]?.ref ?? { kind: "newCalendar" });
    } catch (e) {
      setError(localizePlanningError(e));
    } finally {
      setBusy(false);
    }
  };
  const deleteList = () => {
    const home = homeTaskList(snapshot);
    if (group)
      setListAction({
        kind: "delete",
        list: group,
        fallback:
          (group.id !== home && snapshot.groups?.find((g) => g.id === home)?.name) ||
          t("planner.myTasks"),
      });
    else if (myTasks)
      setListAction({
        kind: "deleteMyTasks",
        lists: snapshot.groups ?? [],
        taskCount: snapshot.todos.filter((todo) => !todo.groupId && !todo.deletedAt).length,
      });
  };
  const rowClass =
    "justify-start gap-2 font-normal aria-pressed:bg-accent aria-pressed:text-accent-foreground";
  const selectedId =
    selection.kind === "newCalendar" || selection.kind === "newList"
      ? selection.kind
      : layerIdOf(selection);

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
          <DialogTitle>{t("planner.layers.title")}</DialogTitle>
          <DialogDescription>{t("planner.layers.hint")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid min-w-0 gap-5 sm:grid-cols-[13rem_minmax(0,1fr)]">
            <nav
              className="flex flex-col gap-3 sm:border-r sm:border-border sm:pr-3"
              aria-label={t("planner.layers.title")}
            >
              {(["mine", "tasks", "other", "cron"] as const).map((key) => {
                const rows = layers.filter((l) => l.group === key);
                if (!rows.length) return null;
                return (
                  <section key={key} aria-label={t(GROUP_TITLES[key])} className="space-y-0.5">
                    <h3 className="px-2 text-xs font-medium text-muted-foreground">
                      {t(GROUP_TITLES[key])}
                    </h3>
                    {rows.map((layer) => (
                      <Button
                        key={layer.layerId}
                        variant="ghost"
                        size="sm"
                        type="button"
                        className={`w-full ${rowClass}`}
                        disabled={busy}
                        aria-pressed={selectedId === layer.layerId}
                        onClick={() => select(layer.ref)}
                      >
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: layer.color }}
                        />
                        <span className="min-w-0 flex-1 truncate text-left">{layer.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {layer.group === "cron"
                            ? t("planner.layers.localTag")
                            : layer.isDefault
                              ? t("planner.calendar.default")
                              : layer.subscription
                                ? t("planner.subscription.tag")
                                : layer.readOnly
                                  ? t("planner.calendar.readOnly")
                                  : ""}
                        </span>
                      </Button>
                    ))}
                  </section>
                );
              })}
              <div className="flex flex-col gap-0.5 border-t border-border pt-2">
                {(
                  [
                    ["newCalendar", t("planner.calendar.new")],
                    ["newList", t("planner.list.new")],
                  ] as const
                ).map(([kind, label]) => (
                  <Button
                    key={kind}
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={busy}
                    aria-pressed={selectedId === kind}
                    className={rowClass}
                    onClick={() => select({ kind })}
                  >
                    <Plus className="size-4" />
                    {label}
                  </Button>
                ))}
              </div>
            </nav>
            <div className="min-w-0">
              {isCron ? (
                // The layer is a local view of scheduled tasks: changes apply immediately.
                <div className="space-y-4">
                  <Label className="flex items-center gap-2 text-sm font-normal">
                    <Checkbox
                      checked={preferences.showCronTasks}
                      onCheckedChange={(checked) => setPreferences({ showCronTasks: checked })}
                    />
                    {t("planner.settings.showCronTasks")}
                  </Label>
                  <ColorSwatches
                    label={t("planner.display.cronColor")}
                    value={preferences.cronColor}
                    palette={CRON_COLORS}
                    onChange={(cronColor) => setPreferences({ cronColor })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("planner.layers.cronLocalHint")}
                  </p>
                </div>
              ) : (
                <form
                  id={formId}
                  className="flex min-h-0 flex-col gap-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                >
                  <fieldset className="min-w-0 space-y-4" disabled={busy}>
                    <PlanningField
                      label={
                        selection.kind === "taskList" || selection.kind === "newList"
                          ? t("planner.list.nameLabel")
                          : t("planner.calendar.name")
                      }
                    >
                      <Input
                        variant="plain"
                        required={!nameLocked}
                        disabled={nameLocked}
                        maxLength={
                          selection.kind === "taskList" || selection.kind === "newList" ? 100 : 60
                        }
                        placeholder={t("planner.calendar.namePlaceholder")}
                        value={colorOnly && calendar ? calendarName(calendar) : form.name}
                        onChange={(e) => set({ name: e.target.value })}
                      />
                    </PlanningField>
                    <ColorSwatches
                      label={
                        selection.kind === "taskList" || selection.kind === "newList"
                          ? t("planner.list.color")
                          : t("planner.calendar.color")
                      }
                      value={form.color}
                      disabled={busy}
                      onChange={(color) => set({ color })}
                    />
                    {localCalendar && (
                      <>
                        {/* The "Default" choice of each event's notification reads this value. */}
                        <PlanningField
                          label={t("planner.calendar.eventNotification")}
                          description={t("planner.calendar.eventNotificationHint")}
                        >
                          <PlanningSelect
                            value={form.minutes}
                            onValueChange={(minutes) => set({ minutes })}
                            options={calendarNotificationOptions(t, form.minutes)}
                          />
                        </PlanningField>
                        <Label className="flex items-center gap-2 text-sm font-normal">
                          <Checkbox
                            checked={form.isDefault}
                            disabled={busy || calendar?.isDefault}
                            onCheckedChange={(checked) => set({ isDefault: checked })}
                          />
                          {t("planner.calendar.makeDefault")}
                        </Label>
                      </>
                    )}
                    {subscribed && (
                      <p className="text-xs text-muted-foreground">
                        {t("planner.calendar.subscribedHint")}
                      </p>
                    )}
                    {myTasks && (
                      <p className="text-xs text-muted-foreground">
                        {t("planner.list.builtinHint")}
                      </p>
                    )}
                  </fieldset>
                  {error && (
                    <SettingsNotice role="alert" variant="action-error">
                      {error}
                    </SettingsNotice>
                  )}
                </form>
              )}
              {deleting && calendar && (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm [&>p]:w-full">
                  <p>{t("planner.calendar.deleteMove", { name: calendarName(calendar) })}</p>
                  <PlanningSelect
                    disabled={busy}
                    aria-label={t("planner.calendar.moveTo")}
                    value={moveTo}
                    onValueChange={setMoveTo}
                    options={snapshot.calendars
                      .filter((c) => c.id !== calendar.id && !c.readOnly)
                      .map((c) => ({ value: c.id, label: calendarName(c) }))}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={busy || !moveTo}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => void removeCalendar()}
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
        {!isCron && (
          <DialogFooter>
            <DialogActions className="w-full">
              {calendar && !calendar.readOnly && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busy || snapshot.calendars.filter((c) => !c.readOnly).length < 2}
                  onClick={() => {
                    setDeleting(true);
                    setMoveTo(
                      snapshot.calendars.find((c) => c.id !== calendar.id && !c.readOnly)?.id ?? "",
                    );
                  }}
                >
                  {t("planner.calendar.delete")}
                </Button>
              )}
              {(group || myTasks) && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busy}
                  onClick={deleteList}
                >
                  {t("planner.list.delete")}
                </Button>
              )}
              <Button variant="default" size="sm" type="submit" form={formId} disabled={busy}>
                {busy
                  ? t("planner.common.saving")
                  : selection.kind === "newCalendar"
                    ? t("planner.calendar.create")
                    : selection.kind === "newList"
                      ? t("planner.list.create")
                      : t("planner.common.save")}
              </Button>
            </DialogActions>
          </DialogFooter>
        )}
      </DialogContent>
      {listAction && (
        <TaskListDialog
          action={listAction}
          onClose={() => setListAction(null)}
          onSelect={() => select(layers[0]?.ref ?? { kind: "newCalendar" })}
        />
      )}
    </Dialog>
  );
}
