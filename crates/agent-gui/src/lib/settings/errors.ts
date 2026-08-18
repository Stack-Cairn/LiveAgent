import type { Locale } from "../../i18n/config";

export type SettingsStorageErrorCode =
  | "load_failed"
  | "save_failed"
  | "gateway_sync_failed"
  | "ssh_settings_changed";

function errorText(error: unknown) {
  if (error instanceof Error) return error.message.trim();
  return String(error ?? "").trim();
}

export class SettingsStorageError extends Error {
  readonly code: SettingsStorageErrorCode;
  readonly originalError: unknown;

  constructor(code: SettingsStorageErrorCode, originalError?: unknown) {
    super(errorText(originalError) || "Settings storage operation failed");
    this.name = "SettingsStorageError";
    this.code = code;
    this.originalError = originalError;
  }
}

export function getSettingsErrorMessage(
  error: unknown,
  fallback: string,
  locale: Locale,
  translate: (key: string, locale: Locale) => string,
) {
  if (error instanceof SettingsStorageError) {
    if (error.code === "ssh_settings_changed") {
      return translate("app.settingsSshSettingsChanged", locale);
    }
    const concreteMessage = errorText(error.originalError);
    if (concreteMessage) {
      return concreteMessage;
    }
    if (error.code === "gateway_sync_failed") {
      return translate("app.gatewaySettingsSyncFailed", locale);
    }
    return fallback;
  }

  return errorText(error) || fallback;
}
