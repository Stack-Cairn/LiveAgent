import { detectSystemLocale, type Locale, normalizeLocale } from "../i18n/config";

/** localStorage key of the persisted WebUI preferences (see webSettings.ts). */
export const WEB_SETTINGS_STORAGE_KEY = "liveagent.gateway.webui.settings.v1";

/**
 * Locale for UI rendered outside the app's LocaleContext (detached dialogs and
 * standalone pages): the saved WebUI preference, else the browser language.
 * Kept free of settings imports so lightweight shims can use it.
 */
export function loadWebLocale(): Locale {
  try {
    const raw = window.localStorage.getItem(WEB_SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { locale?: unknown } | null) : null;
    if (parsed?.locale) return normalizeLocale(parsed.locale);
  } catch {
    // Unreadable storage falls back to the browser language.
  }
  return detectSystemLocale();
}
