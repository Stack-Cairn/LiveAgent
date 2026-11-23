import "@liveagent/ui/i18n/namespaces/settings";

const REASON_KEYS: Record<string, string> = {
  invalid_api_key: "settings.modelDiscoveryError.invalidApiKey",
  not_found: "settings.modelDiscoveryError.notFound",
  rate_limited: "settings.modelDiscoveryError.rateLimited",
  unreachable: "settings.modelDiscoveryError.unreachable",
  upstream_error: "settings.modelDiscoveryError.upstreamError",
};

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/**
 * Text for a failed provider model discovery. K-brain answers one with a 502
 * whose errorCode says why, plus upstreamStatus and upstreamMessage when the
 * provider itself answered; the host adapters copy those onto the thrown
 * Error. Errors without a known errorCode (older backends, other failures)
 * keep their own message.
 */
export function describeModelDiscoveryError(error: unknown, t: (key: string) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  const reason = (error ?? {}) as {
    errorCode?: unknown;
    upstreamStatus?: unknown;
    upstreamMessage?: unknown;
  };
  const key = typeof reason.errorCode === "string" ? REASON_KEYS[reason.errorCode] : undefined;
  if (!key) return message;
  let text = t(key);
  if (typeof reason.upstreamStatus === "number" && reason.upstreamStatus > 0) {
    text = fill(t("settings.modelDiscoveryError.withStatus"), {
      reason: text,
      status: reason.upstreamStatus,
    });
  }
  const detail = typeof reason.upstreamMessage === "string" ? reason.upstreamMessage.trim() : "";
  return detail
    ? fill(t("settings.modelDiscoveryError.withDetail"), { reason: text, detail })
    : text;
}
