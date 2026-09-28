import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCronOccurrences, initAutomation, useAutomation } from "../../lib/automation/store";
import type { CronOccurrencesResponse } from "../../lib/automation/types";
import { localizePlanningError, translate } from "../../lib/planning/i18n";

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Loads the scheduled-task layer for the visible range while it is enabled. Reloads when the
 * range or the cron task list changes and once a minute (runs finish, planned fires pass).
 */
export function useCronOccurrences(enabled: boolean, from: number, to: number) {
  const [data, setData] = useState<CronOccurrencesResponse | null>(null);
  const [error, setError] = useState("");
  const automation = useAutomation();
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const response = await fetchCronOccurrences(from, to);
      if (id !== request.current) return;
      setData(response);
      setError("");
    } catch (e) {
      if (id !== request.current) return;
      setError(translate("planner.cron.loadFailed", { error: localizePlanningError(e) }));
    }
  }, [from, to]);

  useEffect(() => {
    if (enabled) void initAutomation();
  }, [enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: task edits change the revision
  useEffect(() => {
    if (!enabled) {
      request.current += 1;
      setData(null);
      setError("");
      return;
    }
    void load();
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, load, automation.cron.revision]);

  return { data: enabled ? data : null, error: enabled ? error : "", reload: load };
}
