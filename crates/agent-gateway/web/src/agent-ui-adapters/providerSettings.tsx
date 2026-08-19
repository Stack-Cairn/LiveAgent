import type { AppSettings, ProviderId } from "../lib/settings";
import type { SettingsSectionProps } from "../pages/settings/types";

export function ProviderSettingsExtension(_props: {
  activeTab: ProviderId;
  settings: AppSettings;
  setSettings: SettingsSectionProps["setSettings"];
  triggerClassName?: string;
}) {
  return null;
}
