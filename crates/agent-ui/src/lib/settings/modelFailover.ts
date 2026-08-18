import {
  type CustomProvider,
  DEFAULT_PROVIDER_FAILOVER_SETTINGS,
  getDefaultModelFailoverSettings,
  MODEL_FAILOVER_QUEUE_LIMIT,
  type ModelFailoverSettings,
  PROVIDER_FAILOVER_TYPES,
  type ProviderFailoverSettings,
  type ProviderId,
  type SelectedModel,
} from "./types";

/**
 * Returns whether a provider has the minimum visible configuration required
 * for a failover candidate. WebUI may redact the API key value while
 * preserving the `apiKeyConfigured` marker, so that marker is treated as
 * configured here; the runtime still requires the actual key value.
 */
export function hasProviderFailoverConfiguration(
  provider: Pick<CustomProvider, "baseUrl" | "apiKey" | "apiKeyConfigured">,
): boolean {
  return (
    provider.baseUrl.trim().length > 0 &&
    (provider.apiKey.trim().length > 0 || provider.apiKeyConfigured === true)
  );
}

function clampFailoverInteger(input: unknown, min: number, max: number, fallback: number): number {
  const value =
    typeof input === "number" && Number.isFinite(input)
      ? Math.round(input)
      : typeof input === "string" && input.trim() !== ""
        ? Math.round(Number(input))
        : Number.NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalizes one vendor's failover config. Queue entries must reference an
 * existing provider of `providerType` — cross-vendor entries (e.g. a Codex
 * provider inside the Claude queue) are dropped so failover can never mix
 * vendors.
 *
 * Legacy entry migration: the queue used to hold {customProviderId, model}
 * objects. Those collapse to their provider id (deduped), because failover now
 * always re-sends the conversation's own model to the fallback provider.
 */
export function normalizeProviderFailoverSettings(
  input: unknown,
  customProviders: CustomProvider[],
  providerType: ProviderId,
): ProviderFailoverSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const defaults = DEFAULT_PROVIDER_FAILOVER_SETTINGS;

  const queue: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(obj.queue)) {
    for (const raw of obj.queue) {
      const providerId =
        typeof raw === "string"
          ? raw
          : raw &&
              typeof raw === "object" &&
              typeof (raw as SelectedModel).customProviderId === "string"
            ? (raw as SelectedModel).customProviderId
            : "";
      if (!providerId) continue;
      const provider = customProviders.find((item) => item.id === providerId);
      if (!provider || provider.type !== providerType) continue;
      if (seen.has(providerId)) continue;
      seen.add(providerId);
      queue.push(providerId);
      if (queue.length >= MODEL_FAILOVER_QUEUE_LIMIT) break;
    }
  }

  return {
    // An enabled toggle with an empty queue is a harmless no-op at runtime;
    // keep the user's toggle state instead of silently flipping it off.
    enabled: obj.enabled === true,
    queue,
    maxSwitches: clampFailoverInteger(obj.maxSwitches, 1, 10, defaults.maxSwitches),
    failureThreshold: clampFailoverInteger(obj.failureThreshold, 1, 10, defaults.failureThreshold),
    cooldownSeconds: clampFailoverInteger(obj.cooldownSeconds, 5, 3600, defaults.cooldownSeconds),
  };
}

/** True for the pre-per-vendor persisted shape ({enabled, queue, ...}). */
function isLegacyFlatModelFailoverShape(obj: Record<string, unknown>): boolean {
  return (
    !PROVIDER_FAILOVER_TYPES.some((type) => type in obj) &&
    ("enabled" in obj || "queue" in obj || "maxSwitches" in obj)
  );
}

export function normalizeModelFailoverSettings(
  input: unknown,
  customProviders: CustomProvider[],
): ModelFailoverSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  // Legacy migration: the old single global config becomes each vendor's
  // config. Cross-vendor queue entries are filtered per tab by the per-vendor
  // normalizer, so a mixed legacy queue splits cleanly into its vendors.
  if (isLegacyFlatModelFailoverShape(obj)) {
    const result = getDefaultModelFailoverSettings();
    for (const type of PROVIDER_FAILOVER_TYPES) {
      const migrated = normalizeProviderFailoverSettings(obj, customProviders, type);
      // Only vendors that actually kept queue entries stay enabled; an empty
      // migrated queue with enabled=true would surface confusing "on but
      // empty" warnings on tabs the user never configured.
      result[type] = {
        ...migrated,
        enabled: migrated.enabled && migrated.queue.length > 0,
      };
    }
    return result;
  }

  const result = getDefaultModelFailoverSettings();
  for (const type of PROVIDER_FAILOVER_TYPES) {
    result[type] = normalizeProviderFailoverSettings(obj[type], customProviders, type);
  }
  return result;
}
