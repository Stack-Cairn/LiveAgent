import type { LayerRef } from "../../lib/planning/layers";
import { planningStore } from "../../lib/planning/store";
import type { PlanningSnapshot } from "../../lib/planning/types";
import { updateCalendarPreferences } from "./calendarDisplay";

/** Recolor any layer through the write path its data lives on (store, subscription, device). */
export async function recolorLayer(snapshot: PlanningSnapshot, ref: LayerRef, color: string) {
  if (ref.kind === "cron") {
    updateCalendarPreferences({ cronColor: color });
    return;
  }
  if (ref.kind === "taskList") {
    if (!ref.id) {
      await planningStore.mutate({ action: "mytasks.update", data: { color } });
      return;
    }
    const group = snapshot.groups?.find((g) => g.id === ref.id);
    if (group)
      await planningStore.mutate({
        action: "group.update",
        id: group.id,
        expectedRevision: group.revision,
        data: { color },
      });
    return;
  }
  const calendar = snapshot.calendars.find((c) => c.id === ref.id);
  if (!calendar) return;
  if (calendar.sourceKind === "subscription")
    await planningStore.command("subscription.update", { id: calendar.id, color });
  else
    await planningStore.mutate({
      action: "calendar.update",
      id: calendar.id,
      expectedRevision: calendar.revision,
      data: { color },
    });
}
