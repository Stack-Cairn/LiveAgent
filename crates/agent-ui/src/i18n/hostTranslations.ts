import { SHARED_TRANSLATIONS } from "./sharedTranslations";

export type Locale = "zh-CN" | "en-US";

export const DEFAULT_LOCALE: Locale = "zh-CN";

export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const satisfies readonly Locale[];

function systemLanguagePreferences(): readonly string[] {
  if (typeof navigator === "undefined") return [];

  const languages = Array.from(navigator.languages ?? []);
  return languages.length > 0 ? languages : navigator.language ? [navigator.language] : [];
}

/**
 * Select the first supported language from the browser/WebView preference list.
 * The desktop WebView exposes the operating system's preferred UI languages.
 */
export function detectSystemLocale(
  preferredLanguages: readonly string[] = systemLanguagePreferences(),
): Locale {
  for (const language of preferredLanguages) {
    const normalized = language.trim().toLowerCase();
    if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
    if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  }

  return DEFAULT_LOCALE;
}

export function normalizeLocale(input: unknown): Locale {
  return input === "en-US" ? "en-US" : DEFAULT_LOCALE;
}

export function createHostTranslations(overrides: Record<Locale, Record<string, string>>) {
  const translations: Record<Locale, Record<string, string>> = {
    "zh-CN": {
      ...SHARED_TRANSLATIONS["zh-CN"],
      ...overrides["zh-CN"],
    },
    "en-US": {
      ...SHARED_TRANSLATIONS["en-US"],
      ...overrides["en-US"],
    },
  };

  return {
    translations,
    t(key: string, locale: Locale = DEFAULT_LOCALE) {
      return translations[locale]?.[key] ?? key;
    },
  };
}
