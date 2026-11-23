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

type TranslationTable = Record<Locale, Record<string, string>>;

type HostTable = { translations: TranslationTable; overrides: TranslationTable };

// Feature namespaces registered so far, and the host tables they merge into.
const registeredNamespaces: TranslationTable[] = [];
const hostTables: HostTable[] = [];

function mergeNamespace(host: HostTable, namespace: TranslationTable) {
  for (const locale of SUPPORTED_LOCALES) {
    const target = host.translations[locale];
    const overrides = host.overrides[locale];
    for (const [key, value] of Object.entries(namespace[locale])) {
      // Host overrides win over shared messages, as they do for the core table.
      if (!Object.hasOwn(overrides, key)) target[key] = value;
    }
  }
}

/**
 * Adds a feature's messages (both locales) to the host translations. Feature
 * namespaces live in `i18n/namespaces/` and call this when their module is
 * evaluated; every module that renders one of their keys imports the namespace
 * module, so the messages are in place before that module's first render, and a
 * language switch finds both locales already loaded.
 */
export function registerTranslations(namespace: TranslationTable) {
  registeredNamespaces.push(namespace);
  for (const host of hostTables) mergeNamespace(host, namespace);
}

/**
 * A shared message without host overrides: the core table, then the namespaces
 * registered so far. For code that formats shared messages outside a host's `t`.
 */
export function sharedMessage(key: string, locale: Locale): string | undefined {
  const core: Record<string, string> = SHARED_TRANSLATIONS[locale];
  if (Object.hasOwn(core, key)) return core[key];
  for (const namespace of registeredNamespaces) {
    if (Object.hasOwn(namespace[locale], key)) return namespace[locale][key];
  }
  return undefined;
}

export function createHostTranslations(overrides: TranslationTable) {
  const translations: TranslationTable = {
    "zh-CN": {
      ...SHARED_TRANSLATIONS["zh-CN"],
      ...overrides["zh-CN"],
    },
    "en-US": {
      ...SHARED_TRANSLATIONS["en-US"],
      ...overrides["en-US"],
    },
  };
  const host = { translations, overrides };
  hostTables.push(host);
  for (const namespace of registeredNamespaces) mergeNamespace(host, namespace);

  return {
    translations,
    t(key: string, locale: Locale = DEFAULT_LOCALE) {
      return translations[locale]?.[key] ?? key;
    },
  };
}
