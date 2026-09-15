import {
  type CustomProvider,
  DEFAULT_PROVIDER_FAILOVER_SETTINGS,
  getDefaultModelFailoverSettings,
  getProviderImplicitChatProtocol,
  isProviderChatProtocolEnabled,
  LEGACY_FAILOVER_TYPE_FAMILY,
  MODEL_FAILOVER_QUEUE_LIMIT,
  type ModelFailoverSettings,
  PROVIDER_CHAT_PROTOCOLS,
  PROVIDER_PROTOCOL_FAMILIES,
  PROVIDER_PROTOCOL_FAMILY,
  type ProviderFailoverSettings,
  type ProviderId,
  type ProviderProtocolFamily,
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

function queueEntryProviderId(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (
    raw &&
    typeof raw === "object" &&
    typeof (raw as SelectedModel).customProviderId === "string"
  ) {
    return (raw as SelectedModel).customProviderId;
  }
  return "";
}

/**
 * 故障转移分组依据是接口家族（设计文档 8.2）。一个供应商属于某家族的条件是它至少
 * 有一个该家族的接口**已启用**（显式端点未关闭；无显式端点时默认 / 旧推导接口视为
 * 启用）；候选是否真的能服务某个模型由计划构造器按路由再判定。默认接口的家族排在前面。
 */
export function providerFailoverFamilies(
  provider: Pick<
    CustomProvider,
    "type" | "defaultChatProtocol" | "endpointConfigs" | "requestFormat"
  >,
): ProviderProtocolFamily[] {
  const implicitProtocol = getProviderImplicitChatProtocol(provider);
  const families = new Set<ProviderProtocolFamily>();
  for (const protocol of [implicitProtocol, ...PROVIDER_CHAT_PROTOCOLS]) {
    if (isProviderChatProtocolEnabled(provider, protocol, implicitProtocol)) {
      families.add(PROVIDER_PROTOCOL_FAMILY[protocol]);
    }
  }
  return [...families];
}

/**
 * Normalizes one family's failover config. Queue entries must reference an
 * existing provider that serves the family — cross-family entries are dropped
 * so failover can never mix incompatible wire families.
 *
 * Legacy entry migration: the queue used to hold {customProviderId, model}
 * objects. Those collapse to their provider id (deduped), because failover now
 * always re-sends the conversation's own model to the fallback provider.
 */
export function normalizeProviderFailoverSettings(
  input: unknown,
  customProviders: CustomProvider[],
  family: ProviderProtocolFamily,
): ProviderFailoverSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const defaults = DEFAULT_PROVIDER_FAILOVER_SETTINGS;

  const queue: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(obj.queue)) {
    for (const raw of obj.queue) {
      const providerId = queueEntryProviderId(raw);
      if (!providerId) continue;
      const provider = customProviders.find((item) => item.id === providerId);
      if (!provider || !providerFailoverFamilies(provider).includes(family)) continue;
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

const LEGACY_TYPES = Object.keys(LEGACY_FAILOVER_TYPE_FAMILY) as ProviderId[];

// "gemini" 既是旧 ProviderId 键也是新家族键，判定新旧形状时不能用它。
const NEW_ONLY_FAMILIES: readonly ProviderProtocolFamily[] = ["anthropic", "openai"];
const LEGACY_ONLY_TYPES: readonly ProviderId[] = LEGACY_TYPES.filter((type) => type !== "gemini");

/** True for the pre-per-vendor persisted shape ({enabled, queue, ...}). */
function isLegacyFlatModelFailoverShape(obj: Record<string, unknown>): boolean {
  return (
    !PROVIDER_PROTOCOL_FAMILIES.some((family) => family in obj) &&
    !LEGACY_TYPES.some((type) => type in obj) &&
    ("enabled" in obj || "queue" in obj || "maxSwitches" in obj)
  );
}

/** True for the per-ProviderId shape ({claude_code, codex, gemini, xai, deepseek}). */
function isLegacyPerTypeShape(obj: Record<string, unknown>): boolean {
  return (
    !NEW_ONLY_FAMILIES.some((family) => family in obj) &&
    LEGACY_ONLY_TYPES.some((type) => type in obj)
  );
}

/**
 * 旧的五个 ProviderId 分组合并为三个家族：codex / xai / deepseek 三份队列按序追加
 * 去重；任一旧分组启用即家族启用；阈值取该家族第一份旧分组的值。
 */
function mergeLegacyPerTypeShape(obj: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const type of LEGACY_TYPES) {
    const raw = obj[type];
    if (!raw || typeof raw !== "object") continue;
    const source = raw as Record<string, unknown>;
    const family: string = LEGACY_FAILOVER_TYPE_FAMILY[type];
    if (!merged[family]) merged[family] = { enabled: false, queue: [] as unknown[] };
    const target = merged[family];
    if (source.enabled === true) target.enabled = true;
    // 阈值优先取启用过的旧分组（用户真正调过的那份），否则取第一份。
    const knobsFromEnabled = target.__knobsFromEnabled === true;
    if (
      source.maxSwitches !== undefined &&
      (target.maxSwitches === undefined || (source.enabled === true && !knobsFromEnabled))
    ) {
      target.maxSwitches = source.maxSwitches;
      target.failureThreshold = source.failureThreshold;
      target.cooldownSeconds = source.cooldownSeconds;
      if (source.enabled === true) target.__knobsFromEnabled = true;
    }
    if (Array.isArray(source.queue)) (target.queue as unknown[]).push(...source.queue);
  }
  return merged;
}

export function normalizeModelFailoverSettings(
  input: unknown,
  customProviders: CustomProvider[],
): ModelFailoverSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  // Legacy migration: the old single global config becomes each family's
  // config. Cross-family queue entries are filtered per family by the
  // per-family normalizer, so a mixed legacy queue splits cleanly.
  if (isLegacyFlatModelFailoverShape(obj)) {
    const result = getDefaultModelFailoverSettings();
    for (const family of PROVIDER_PROTOCOL_FAMILIES) {
      const migrated = normalizeProviderFailoverSettings(obj, customProviders, family);
      // Only families that actually kept queue entries stay enabled; an empty
      // migrated queue with enabled=true would surface confusing "on but
      // empty" warnings on families the user never configured.
      result[family] = {
        ...migrated,
        enabled: migrated.enabled && migrated.queue.length > 0,
      };
    }
    return result;
  }

  const source: Record<string, unknown> = isLegacyPerTypeShape(obj)
    ? mergeLegacyPerTypeShape(obj)
    : obj;
  const result = getDefaultModelFailoverSettings();
  for (const family of PROVIDER_PROTOCOL_FAMILIES) {
    result[family] = normalizeProviderFailoverSettings(source[family], customProviders, family);
  }
  return result;
}
