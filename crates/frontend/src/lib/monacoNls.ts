import { DEFAULT_LOCALE, type Locale } from "../i18n/config";

type MonacoNlsGlobals = typeof globalThis & {
  _VSCODE_NLS_LANGUAGE?: string;
  _VSCODE_NLS_MESSAGES?: string[];
};

let preferredLocale: Locale = DEFAULT_LOCALE;
let configuredLocale: Locale | null = null;
let localeLocked = false;
let zhCnMessagesPromise: Promise<void> | null = null;

function clearMonacoNlsGlobals() {
  const target = globalThis as MonacoNlsGlobals;
  delete target._VSCODE_NLS_LANGUAGE;
  delete target._VSCODE_NLS_MESSAGES;
}

export function setPreferredMonacoNlsLocale(locale: Locale) {
  if (localeLocked) return;
  preferredLocale = locale;
}

export async function preparePreferredMonacoNlsLocale() {
  const targetLocale = preferredLocale;
  if (localeLocked || configuredLocale === targetLocale) return;

  if (targetLocale === "zh-CN") {
    zhCnMessagesPromise ??= import("monaco-editor/esm/nls.messages.zh-cn.js").then(() => undefined);
    await zhCnMessagesPromise;
    if (localeLocked) return;
    if (preferredLocale !== targetLocale) {
      clearMonacoNlsGlobals();
      configuredLocale = "en-US";
      return;
    }
    configuredLocale = "zh-CN";
    return;
  }

  clearMonacoNlsGlobals();
  configuredLocale = "en-US";
}

export function lockMonacoNlsLocale() {
  localeLocked = true;
}
