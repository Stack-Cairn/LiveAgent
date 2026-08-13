import { SHARED_TRANSLATIONS } from "./sharedTranslations";

export type Locale = "zh-CN" | "en-US";

export const DEFAULT_LOCALE: Locale = "zh-CN";

export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const satisfies readonly Locale[];

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
