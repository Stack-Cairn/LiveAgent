// 预设注册表：生成层（models.dev）与覆盖层合并后的只读数据，以及供设置页、
// 探测与路由使用的查询函数（设计文档第 3 节）。

import { type ModelFamily, resolveModelFamily, stripModelVendorPrefix } from "./families";
import { endpointHostKey } from "./hosts";
import {
  GENERATED_PRESETS,
  type GeneratedPreset,
  type GeneratedPresetModel,
} from "./presets.generated";
import {
  PRESET_OVERLAYS,
  type PresetCategory,
  type PresetEndpointOverlay,
  type PresetIdentity,
  type PresetInputKind,
  type PresetModelRule,
  type PresetOverlay,
} from "./presets.overlay";
import {
  PROVIDER_CHAT_PROTOCOLS,
  PROVIDER_PROTOCOL_FAMILY,
  type ProviderChatProtocol,
  type ProviderWireDialect,
} from "./protocols";

export type PresetEndpoint = PresetEndpointOverlay & { baseUrl: string };

export type ProviderPreset = {
  id: string;
  name: string;
  native: boolean;
  category: PresetCategory;
  input: PresetInputKind;
  defaultOrigin?: string;
  authOptional: boolean;
  dialect?: ProviderWireDialect;
  defaultChatProtocol: ProviderChatProtocol;
  /** 该渠道提供的接口。键不存在 = 不提供，探测也不会去试；自定义渠道为空 */
  endpoints: Partial<Record<ProviderChatProtocol, PresetEndpoint>>;
  modelListSource: "api" | "catalog";
  /** 目录模型（来自 models.dev），供无列表接口的渠道与限额初值使用 */
  catalogModels: readonly GeneratedPresetModel[];
  models: readonly PresetModelRule[];
  identity?: PresetIdentity;
  doc?: string;
  apiKeyUrl?: string;
  envKeys: readonly string[];
  hidden: boolean;
  order: number;
};

function mergePreset(
  generated: GeneratedPreset | undefined,
  overlay: PresetOverlay | undefined,
): ProviderPreset {
  const id = overlay?.id ?? generated?.id ?? "custom";
  const endpoints: Partial<Record<ProviderChatProtocol, PresetEndpoint>> = {};
  if (generated) {
    for (const protocol of generated.protocols) {
      endpoints[protocol] = { baseUrl: generated.baseUrl };
    }
  }
  for (const [protocol, patch] of Object.entries(overlay?.endpoints ?? {}) as [
    ProviderChatProtocol,
    PresetEndpointOverlay,
  ][]) {
    const base = endpoints[protocol];
    const baseUrl = patch.baseUrl ?? base?.baseUrl;
    if (!baseUrl) continue;
    endpoints[protocol] = { ...base, ...patch, baseUrl };
  }
  const configured = PROVIDER_CHAT_PROTOCOLS.filter((protocol) => endpoints[protocol]);
  const defaultChatProtocol =
    overlay?.defaultChatProtocol ??
    generated?.protocols[0] ??
    configured[0] ??
    "openai-completions";
  return {
    id,
    name: overlay?.name ?? generated?.name ?? id,
    native: overlay?.native === true,
    category: overlay?.category ?? "official",
    input: overlay?.input ?? "key",
    defaultOrigin: overlay?.defaultOrigin,
    authOptional: overlay?.authOptional === true,
    dialect: overlay?.dialect,
    defaultChatProtocol,
    endpoints,
    modelListSource: overlay?.modelListSource ?? "api",
    catalogModels: generated?.models ?? [],
    models: overlay?.models ?? [],
    identity: overlay?.identity,
    doc: generated?.doc,
    apiKeyUrl: overlay?.apiKeyUrl,
    envKeys: generated?.envKeys ?? [],
    hidden: overlay?.hidden === true,
    order: overlay?.order ?? 500,
  };
}

function buildPresets(): readonly ProviderPreset[] {
  const generatedById = new Map(GENERATED_PRESETS.map((preset) => [preset.id, preset]));
  const overlayById = new Map(PRESET_OVERLAYS.map((overlay) => [overlay.id, overlay]));
  const ids = new Set<string>([...overlayById.keys(), ...generatedById.keys()]);
  const presets = [...ids].map((id) => mergePreset(generatedById.get(id), overlayById.get(id)));
  return presets.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = buildPresets();

export const CUSTOM_PRESET_ID = "custom";

const PRESET_BY_ID: ReadonlyMap<string, ProviderPreset> = new Map(
  PROVIDER_PRESETS.map((preset) => [preset.id, preset]),
);

/** 预设声明的绝对地址主机集合（{origin} 模板不算）；按预设对象缓存。 */
const PRESET_HOSTS_CACHE = new WeakMap<Pick<ProviderPreset, "endpoints">, readonly string[]>();

/** 主机 → 预设（原生渠道优先；同一主机被多个预设声明时先到先得）。 */
const PRESET_BY_HOST: ReadonlyMap<string, ProviderPreset> = (() => {
  const byHost = new Map<string, ProviderPreset>();
  const ordered = [...PROVIDER_PRESETS].sort((a, b) => Number(b.native) - Number(a.native));
  for (const preset of ordered) {
    for (const host of presetHosts(preset)) {
      if (!byHost.has(host)) byHost.set(host, preset);
    }
  }
  return byHost;
})();

export function findProviderPreset(id: string | undefined | null): ProviderPreset | undefined {
  return id ? PRESET_BY_ID.get(id) : undefined;
}

export function listProviderPresets(options?: {
  includeHidden?: boolean;
}): readonly ProviderPreset[] {
  return options?.includeHidden
    ? PROVIDER_PRESETS
    : PROVIDER_PRESETS.filter((preset) => !preset.hidden);
}

/** 旧 ProviderId 分组 → 原生渠道预设。 */
const LEGACY_TYPE_PRESET: Record<string, string> = {
  claude_code: "anthropic",
  codex: "openai",
  gemini: "gemini",
  xai: "xai",
  deepseek: "deepseek",
};

export function presetIdForLegacyType(type: string): string {
  return LEGACY_TYPE_PRESET[type] ?? CUSTOM_PRESET_ID;
}

/** 预设声明的绝对地址主机集合（{origin} 模板不算），键与 endpointHostKey 一致。 */
export function presetHosts(preset: Pick<ProviderPreset, "endpoints">): readonly string[] {
  const cached = PRESET_HOSTS_CACHE.get(preset);
  if (cached) return cached;
  const hosts = new Set<string>();
  for (const endpoint of Object.values(preset.endpoints)) {
    if (!endpoint || endpoint.baseUrl.includes("{origin}")) continue;
    const host = endpointHostKey(endpoint.baseUrl);
    if (host) hosts.add(host);
  }
  const out = Object.freeze([...hosts]);
  PRESET_HOSTS_CACHE.set(preset, out);
  return out;
}

/** 地址主机是否属于该预设声明的官方主机。没有绝对主机的预设（网关模板、自定义）返回 true。 */
export function presetMatchesBaseUrl(
  preset: Pick<ProviderPreset, "endpoints"> | undefined,
  baseUrl: string | undefined,
): boolean {
  if (!preset) return false;
  const hosts = presetHosts(preset);
  if (hosts.length === 0) return true;
  const host = endpointHostKey(baseUrl);
  return host.length > 0 && hosts.includes(host);
}

/** 按地址主机反查预设（原生渠道优先）。 */
export function findPresetForBaseUrl(baseUrl: string | undefined): ProviderPreset | undefined {
  const host = endpointHostKey(baseUrl);
  return host ? PRESET_BY_HOST.get(host) : undefined;
}

/**
 * 旧存档（只有 type 与 baseUrl）应归属的预设：地址命中某预设官方主机 → 该预设；
 * 否则是中转或自建 → 自定义。这样中转实例不会被当成官方渠道去探测官方地址。
 */
export function presetIdForLegacyProvider(type: string, baseUrl: string | undefined): string {
  const byHost = findPresetForBaseUrl(baseUrl);
  if (byHost) return byHost.id;
  const native = findProviderPreset(LEGACY_TYPE_PRESET[type]);
  return native && presetMatchesBaseUrl(native, baseUrl) ? native.id : CUSTOM_PRESET_ID;
}

/**
 * 新实例按默认接口家族回填旧 `type`，保证 P1.5 完成前仍读 `type` 的代码行为不变。
 * 原生 xAI / DeepSeek 渠道保持各自的值。
 */
export function legacyTypeForPreset(
  preset: Pick<ProviderPreset, "id" | "native"> | undefined,
  defaultChatProtocol: ProviderChatProtocol,
): "codex" | "claude_code" | "gemini" | "xai" | "deepseek" {
  if (preset?.native) {
    if (preset.id === "xai") return "xai";
    if (preset.id === "deepseek") return "deepseek";
  }
  switch (PROVIDER_PROTOCOL_FAMILY[defaultChatProtocol]) {
    case "anthropic":
      return "claude_code";
    case "gemini":
      return "gemini";
    default:
      return "codex";
  }
}

/** 展开地址模板。origin 为用户填写的地址取 scheme+host（含端口）。 */
export function expandPresetBaseUrl(template: string, origin: string | undefined): string {
  if (!template.includes("{origin}")) return template;
  const normalized = normalizeOrigin(origin ?? "");
  return normalized ? template.replace("{origin}", normalized) : "";
}

export function normalizeOrigin(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    // 用户可能直接粘贴 …/v1；origin 类模板只要 scheme+host+可选前缀路径（去掉 /v1、/v1beta）。
    const path = url.pathname.replace(/\/(v1beta|v1)\/?$/i, "").replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return "";
  }
}

function ruleMatches(rule: PresetModelRule, modelId: string): boolean {
  const id = modelId.trim();
  const stripped = stripModelVendorPrefix(id);
  if (rule.match.endsWith("*")) {
    const prefix = rule.match.slice(0, -1);
    return id.startsWith(prefix) || stripped.startsWith(prefix);
  }
  return id === rule.match || stripped === rule.match;
}

export function matchPresetModelRule(
  preset: Pick<ProviderPreset, "models"> | undefined,
  modelId: string,
): PresetModelRule | undefined {
  if (!preset) return undefined;
  return preset.models.find((rule) => ruleMatches(rule, modelId));
}

export function findPresetCatalogModel(
  preset: Pick<ProviderPreset, "catalogModels"> | undefined,
  modelId: string,
): GeneratedPresetModel | undefined {
  if (!preset) return undefined;
  const id = modelId.trim();
  const stripped = stripModelVendorPrefix(id);
  return preset.catalogModels.find((model) => model.id === id || model.id === stripped);
}

export type { ModelFamily, PresetCategory, PresetIdentity, PresetInputKind, PresetModelRule };
export { resolveModelFamily };
