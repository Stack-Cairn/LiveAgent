import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n";
import { useSyncExternalStore } from "react";
import { kBrainStorageScope } from "../kbrain/mapping";
import {
  dismissTimeZoneNotice,
  getTimeZoneNotice,
  subscribeTimeZoneNotice,
} from "./timeZoneNotice";

export function TimeZoneNoticeBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useLocale();
  const scope = kBrainStorageScope();
  const notice = useSyncExternalStore(subscribeTimeZoneNotice, () => getTimeZoneNotice(scope));
  if (!notice) return null;
  const description = t(`planner.timezoneNotice.${notice.kind}`)
    .replace("{preference}", notice.preference ?? "")
    .replace("{effective}", notice.effective ?? "")
    .replace("{device}", notice.device ?? "");
  return (
    <SettingsNotice
      variant="warning"
      role="status"
      aria-live="polite"
      data-testid="timezone-notice"
      className="m-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2"
    >
      <div className="min-w-0 flex-1 basis-64 break-words">
        <p className="font-medium">{t("planner.timezoneNotice.title")}</p>
        <p>
          {description} {t("planner.timezoneNotice.preserved")}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          {t("planner.timezoneNotice.settings")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => dismissTimeZoneNotice(scope)}>
          {t("planner.timezoneNotice.dismiss")}
        </Button>
      </div>
    </SettingsNotice>
  );
}
