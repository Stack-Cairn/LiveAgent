import { t as hostTranslate } from "@liveagent/app/i18n/config";
import { useCallback } from "react";
import { useLocale } from "../../i18n/LocaleContext";
import { format, type PlanningVars, setPlanningLocale } from "../../lib/planning/i18n";

/** Planning translations with `{name}` placeholders; also syncs the locale for pure helpers. */
export function usePlanningT() {
  const { locale } = useLocale();
  setPlanningLocale(locale);
  const t = useCallback(
    (key: string, vars?: PlanningVars) => format(hostTranslate(key, locale), vars),
    [locale],
  );
  return { t, locale };
}
