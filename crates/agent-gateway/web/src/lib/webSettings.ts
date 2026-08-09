import { redactSettingsForWebStorage } from "@liveagent/ui/lib/settings/sync";
import { type AppSettings, getDefaultSettings, normalizeSettings } from "@/lib/settings";

const WEB_SETTINGS_STORAGE_KEY = "liveagent.gateway.webui.settings.v1";

export type WebSettingsSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

export function getWebDefaultSettings(token: string): AppSettings {
  const defaults = getDefaultSettings();
  return normalizeSettings({
    ...defaults,
    system: {
      ...defaults.system,
      executionMode: "tools",
      workdir: "",
    },
    remote: {
      ...defaults.remote,
      enabled: token.trim() !== "",
      gatewayUrl: typeof window !== "undefined" ? window.location.origin : "",
      token: token.trim(),
    },
  });
}

export function loadWebSettings(token: string): AppSettings {
  const fallback = getWebDefaultSettings(token);
  try {
    const raw = window.localStorage.getItem(WEB_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings> | null;
    const normalized = redactSettingsForWebStorage(
      normalizeSettings({
        ...fallback,
        ...(parsed ?? {}),
        remote: {
          ...fallback.remote,
          ...(parsed?.remote ?? {}),
          gatewayUrl: fallback.remote.gatewayUrl,
          token: token.trim(),
          enabled: token.trim() !== "" || parsed?.remote?.enabled === true,
        },
      }),
    );
    window.localStorage.setItem(WEB_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    return fallback;
  }
}

export function persistWebSettings(settings: AppSettings): void {
  window.localStorage.setItem(
    WEB_SETTINGS_STORAGE_KEY,
    JSON.stringify(redactSettingsForWebStorage(settings)),
  );
}
