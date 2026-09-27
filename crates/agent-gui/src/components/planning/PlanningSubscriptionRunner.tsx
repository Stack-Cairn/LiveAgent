import { parseCalendar } from "@liveagent/ui/lib/planning/calendarImport";
import { localizePlanningError } from "@liveagent/ui/lib/planning/i18n";
import { addDays, zonedParts } from "@liveagent/ui/lib/planning/time";
import type { PlanningSnapshot } from "@liveagent/ui/lib/planning/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

const POLL_MS = 60_000;
/** Mirror window: recent history plus the coming year, re-expanded on every refresh. */
const PAST_DAYS = 30;
const FUTURE_DAYS = 365;

/**
 * Desktop-only refresh loop for iCal subscriptions. The backend owns the URL and the HTTP
 * fetch; this runner reuses the tested ICS importer (time zones, recurrence) and hands the
 * entries back for an atomic mirror. WebUI clients only manage subscriptions.
 */
export function PlanningSubscriptionRunner() {
  useEffect(() => {
    let disposed = false;
    let running = false;
    const refresh = async () => {
      if (running || disposed) return;
      running = true;
      try {
        const due = await invoke<string[]>("planning_subscription_due");
        if (!due.length) return;
        const { timeZone } = await invoke<PlanningSnapshot>("planning_query", { query: {} });
        const today = zonedParts(Date.now(), timeZone).date;
        const range = {
          from: addDays(today, -PAST_DAYS),
          to: addDays(today, FUTURE_DAYS),
          zone: timeZone,
          maxDays: PAST_DAYS + FUTURE_DAYS + 2,
        };
        for (const id of due) {
          if (disposed) return;
          try {
            const text = await invoke<string>("planning_subscription_fetch", { id });
            const { entries } = parseCalendar(text, range);
            await invoke("planning_subscription_sync", { id, entries });
          } catch (error) {
            // Keep the raw code so every client localizes it in its own language.
            const message = error instanceof Error ? error.message : String(error ?? "");
            await invoke("planning_subscription_fail", {
              id,
              error: message || localizePlanningError(error),
            }).catch(() => {});
          }
        }
      } catch (error) {
        console.warn("Planning subscription refresh", error);
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    // "Refresh now" and new subscriptions reset the due time and emit a change event.
    let unlisten: (() => void) | undefined;
    void listen("planning:changed", () => void refresh()).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      unlisten?.();
    };
  }, []);
  return null;
}
