import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { HubHeader } from "@liveagent/ui/components/hub/HubChrome";
import { useLocale } from "@liveagent/ui/i18n";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { CronSection } from "../settings/CronSection";
import { MemoryPanel } from "../settings/memory/MemoryPanel";

export function ResourceManagementPage({
  resource,
  settings,
  setSettings,
}: SettingsSectionProps & { resource: "memory" | "cron" }) {
  const { t } = useLocale();
  const memory = resource === "memory";
  return (
    <div className="hub-page hub-page-enter relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <HubHeader title={t(memory ? "settings.navMemory" : "settings.navCron")} prominent />
      <div
        className={cn(
          "hub-scroll min-h-0 flex-1 px-5 pb-6 sm:px-6 lg:px-8 xl:px-10",
          memory ? "flex flex-col overflow-hidden" : "overflow-y-auto",
        )}
      >
        <div
          className={cn("mx-auto w-full max-w-[1320px]", memory && "flex min-h-0 flex-1 flex-col")}
        >
          {memory ? (
            <MemoryPanel
              workdir={settings.system.workdir}
              settings={settings}
              setSettings={setSettings}
            />
          ) : (
            <CronSection settings={settings} setSettings={setSettings} />
          )}
        </div>
      </div>
    </div>
  );
}
