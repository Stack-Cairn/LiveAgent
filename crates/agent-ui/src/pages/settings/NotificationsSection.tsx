import { type NotificationPreferences, updateSystem } from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { invoke } from "@liveagent/app/shims/tauriCore";
import { useState } from "react";
import { Bell, ExternalLink } from "../../components/IconSet";
import { SettingsSection } from "../../components/settings/SettingsLayout";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toast-manager";
import type { UiSurface } from "../../contracts/registry";
import { useLocale } from "../../i18n/index";
import { SettingsGroup, SettingsRow } from "./shared";

type NotifyOutcome = "sent" | "disabled" | "throttled" | "disabledByEnv";

const CATEGORIES: { key: keyof NotificationPreferences; label: string }[] = [
  { key: "planning", label: "settings.notifications.planning" },
  { key: "cronFailure", label: "settings.notifications.cronFailure" },
  { key: "cronSuccess", label: "settings.notifications.cronSuccess" },
  { key: "agent", label: "settings.notifications.agent" },
];

/**
 * 设置 → 通知：各类别是否弹桌面系统通知。历史、免打扰与权限都交给操作系统，
 * 因此这里只有开关、测试通知与打开系统通知设置（后两者只在桌面端可用）。
 */
export function NotificationsSection({
  settings,
  setSettings,
  surface = "desktop",
}: SettingsSectionProps & { surface?: UiSurface }) {
  const { t } = useLocale();
  const [testing, setTesting] = useState(false);
  const preferences = settings.system.notifications;
  const desktop = surface === "desktop";

  const toggle = (key: keyof NotificationPreferences, next: boolean) =>
    setSettings((prev) =>
      updateSystem(prev, { notifications: { ...prev.system.notifications, [key]: next } }),
    );

  const sendTest = async () => {
    setTesting(true);
    try {
      const outcome = await invoke<NotifyOutcome>("notifications_test");
      if (outcome === "disabledByEnv") toast.warning(t("settings.notifications.testDisabledByEnv"));
      else toast.success(t("settings.notifications.testSent"));
    } catch (error) {
      toast.error(
        t("settings.notifications.testFailed").replace(
          "{error}",
          error instanceof Error ? error.message : String(error),
        ),
      );
    } finally {
      setTesting(false);
    }
  };

  const openSystemSettings = () => {
    void invoke("notifications_open_settings").catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // 系统通知设置的深链只有 macOS / Windows 有。
      if (message.includes("E:unsupported"))
        toast.warning(t("settings.notifications.openUnsupported"));
      else toast.error(message);
    });
  };

  return (
    <div className="mx-auto w-full max-w-920px space-y-8">
      <SettingsSection description={t("settings.notifications.desc")} />
      <SettingsGroup title={t("settings.notifications.types")}>
        {CATEGORIES.map(({ key, label }) => (
          <SettingsRow
            key={key}
            title={t(label)}
            description={t(`${label}Desc`)}
            control={
              <Switch
                checked={preferences[key]}
                aria-label={t(label)}
                onCheckedChange={(next) => toggle(key, next)}
              />
            }
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title={t("settings.notifications.system")}>
        <SettingsRow
          title={t("settings.notifications.check")}
          description={
            desktop
              ? t("settings.notifications.systemDesc")
              : t("settings.notifications.desktopOnly")
          }
          control={
            desktop ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="outline" size="sm" onClick={openSystemSettings}>
                  <ExternalLink className="size-3.5" aria-hidden />
                  {t("settings.notifications.openSettings")}
                </Button>
                <Button size="sm" disabled={testing} onClick={() => void sendTest()}>
                  <Bell className="size-3.5" aria-hidden />
                  {t("settings.notifications.test")}
                </Button>
              </div>
            ) : null
          }
        />
      </SettingsGroup>
    </div>
  );
}
