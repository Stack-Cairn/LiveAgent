import { DEFAULT_LOCALE, type Locale, t as translate } from "@liveagent/app/i18n/config";
import { createContext, useContext, useMemo } from "react";

type LocaleContextValue = {
  locale: Locale;
  t: (key: string) => string;
};

export const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  t: (key) => translate(key, DEFAULT_LOCALE),
});

export function useLocale() {
  return useContext(LocaleContext);
}

export function useLocaleContextValue(locale: Locale) {
  return useMemo(
    () => ({
      locale,
      t: (key: string) => translate(key, locale),
    }),
    [locale],
  );
}
