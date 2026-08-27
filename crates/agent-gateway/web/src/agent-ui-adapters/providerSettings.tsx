import type { AppSettings, CustomProvider, ProviderId } from "../lib/settings";
import type { SettingsSectionProps } from "../pages/settings/types";

/** WebUI 会脱敏 API Key，复制配置按钮仅在桌面端提供。 */
export function ProviderCopyConfigButton(_props: {
  provider: Pick<CustomProvider, "baseUrl" | "apiKey">;
}) {
  return null;
}

export function ProviderSettingsExtension(_props: {
  activeTab: ProviderId;
  settings: AppSettings;
  setSettings: SettingsSectionProps["setSettings"];
  triggerClassName?: string;
}) {
  return null;
}
