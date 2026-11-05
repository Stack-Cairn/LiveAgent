import { type Locale, t } from "../../i18n/config";

/**
 * K-brain publishes `hook.warning` when a configured backend hook fails (non-zero exit,
 * timeout, HTTP error); the run itself continues. Payload, from internal/backend/server.go:
 * `{ hookName, hookType: "command" | "http", event, message }`.
 */
export type KBrainHookWarning = {
  hookName: string;
  hookType: string;
  event: string;
  message: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseHookWarning(payload: unknown): KBrainHookWarning | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const warning = {
    hookName: text(record.hookName),
    hookType: text(record.hookType),
    event: text(record.event),
    message: text(record.message),
  };
  return warning.hookName || warning.message ? warning : null;
}

/** Toast copy for a failed hook: the hook names the title, the lifecycle event and error explain it. */
export function hookWarningNotice(warning: KBrainHookWarning, locale?: Locale) {
  const hook = warning.hookName || t("chat.hookWarning.unnamed", locale);
  const message = warning.message || t("chat.hookWarning.noDetail", locale);
  return {
    title: t("chat.hookWarning.title", locale).replace("{hook}", hook),
    description: warning.event ? `${warning.event}: ${message}` : message,
  };
}
