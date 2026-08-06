export type Locale = "zh-CN" | "en-US";

export const DEFAULT_LOCALE: Locale = "zh-CN";

export function normalizeLocale(input: unknown): Locale {
  return input === "en-US" ? "en-US" : DEFAULT_LOCALE;
}
