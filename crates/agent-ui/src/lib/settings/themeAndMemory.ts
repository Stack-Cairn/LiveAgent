import type { EffectiveTheme, Theme } from "./types";

const SYSTEM_THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function normalizeTheme(input: unknown): Theme {
  if (input === "dark") return "dark";
  if (input === "system" || input === "auto") return "system";
  return "light";
}

export function resolveEffectiveTheme(theme: Theme): EffectiveTheme {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(SYSTEM_THEME_MEDIA_QUERY).matches ? "dark" : "light";
}

export function getNextTheme(theme: Theme): Theme {
  if (theme === "light") return "dark";
  if (theme === "dark") return "system";
  return "light";
}

export function subscribeToSystemThemePreference(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  const query = window.matchMedia(SYSTEM_THEME_MEDIA_QUERY);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }

  query.addListener(listener);
  return () => query.removeListener(listener);
}
