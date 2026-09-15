// 快速接入探测与自动配置（设计文档 5.1 - 5.3、5.6）。
//
// 探测只用各接口的模型列表请求：对每把启用的 Key × 每个候选接口各拉一次，按
// 200 / 404 / 401 / 其他分类。结果是观测值；自动配置把观测变成一份可采纳的草稿
// （端点、默认接口、模型目录、每把 Key 的模型范围），全部标 `auto`。

import {
  type CustomProvider,
  getProviderModelDefaults,
  normalizeProviderModelConfig,
  type ProviderChatProtocol,
  type ProviderCredential,
  type ProviderEndpointConfig,
  type ProviderEndpointProbeStatus,
  type ProviderId,
  type ProviderModelConfig,
  type ProviderWireDialect,
} from "@liveagent/app/lib/settings";
import type { CustomHeader } from "../../lib/providers/customHeaders";
import {
  expandPresetBaseUrl,
  findPresetCatalogModel,
  matchPresetModelRule,
  normalizeOrigin,
  PROVIDER_CHAT_PROTOCOLS,
  type ProviderPreset,
  presetMatchesBaseUrl,
  resolveModelFamily,
  resolveModelGroup,
} from "../../lib/providers/registry";
import { fetchModelsFromApi, ProviderModelsFetchError } from "./providerUtils";

export type EndpointCandidate = {
  protocol: ProviderChatProtocol;
  baseUrl: string;
  modelsUrl?: string;
  isFullUrl?: boolean;
  dialect?: ProviderWireDialect;
  quirks?: ProviderEndpointConfig["quirks"];
  auth?: ProviderEndpointConfig["auth"];
  note?: string;
  /** 来源：preset = 注册表声明；existing = 当前配置；custom = 用户手填 */
  origin: "preset" | "existing" | "custom";
};

export type EndpointProbeResult = {
  protocol: ProviderChatProtocol;
  baseUrl: string;
  status: ProviderEndpointProbeStatus;
  latencyMs?: number;
  error?: string;
  models: ProviderModelConfig[];
};

export type CredentialProbeResult = {
  credentialId: string;
  endpoints: EndpointProbeResult[];
};

export type ProviderProbeResult = {
  at: number;
  credentials: CredentialProbeResult[];
};

/** 探测与模型拉取仍按旧供应商类型选择鉴权头族；四类接口 → 旧类型。 */
export function legacyTypeForProtocol(protocol: ProviderChatProtocol): ProviderId {
  switch (protocol) {
    case "anthropic-messages":
      return "claude_code";
    case "google-generative-ai":
      return "gemini";
    default:
      return "codex";
  }
}

/**
 * 候选接口：注册表声明的接口（自定义渠道为四类全部）叠加当前已配置的端点。
 * origin 类模板由用户填写的地址展开；base 类（自定义）把同一地址给所有接口，
 * Gemini 与 Anthropic 按惯例改写路径。
 */
export function buildEndpointCandidates(params: {
  preset: ProviderPreset | undefined;
  origin?: string;
  baseUrl?: string;
  existing?: CustomProvider["endpointConfigs"];
}): EndpointCandidate[] {
  const { preset } = params;
  const out: EndpointCandidate[] = [];
  const declared =
    preset && Object.keys(preset.endpoints).length > 0 ? preset.endpoints : undefined;
  const protocols = declared
    ? PROVIDER_CHAT_PROTOCOLS.filter((protocol) => declared[protocol])
    : PROVIDER_CHAT_PROTOCOLS;
  for (const protocol of protocols) {
    const existing = params.existing?.[protocol];
    if (existing) {
      out.push({
        protocol,
        baseUrl: existing.baseUrl,
        modelsUrl: existing.modelsUrl,
        isFullUrl: existing.isFullUrl,
        dialect: existing.dialect,
        quirks: existing.quirks,
        auth: existing.auth,
        origin: "existing",
      });
      continue;
    }
    const presetEndpoint = declared?.[protocol];
    // 预设的绝对地址只在实例地址属于该预设官方主机时使用；中转/自建实例即使挂着
    // 预设，也从自己的地址派生，避免把 Key 发到官方地址。
    const presetApplies =
      presetEndpoint &&
      (presetEndpoint.baseUrl.includes("{origin}") ||
        !(params.baseUrl || params.origin) ||
        presetMatchesBaseUrl(preset, params.baseUrl ?? params.origin));
    if (presetEndpoint && presetApplies) {
      const baseUrl = expandPresetBaseUrl(presetEndpoint.baseUrl, params.origin ?? params.baseUrl);
      if (!baseUrl) continue;
      out.push({
        protocol,
        baseUrl,
        modelsUrl: presetEndpoint.modelsUrl,
        dialect: presetEndpoint.dialect,
        quirks: presetEndpoint.quirks,
        auth: presetEndpoint.auth,
        note: presetEndpoint.note,
        origin: "preset",
      });
      continue;
    }
    const custom = customEndpointBaseUrl(protocol, params.baseUrl ?? params.origin ?? "");
    if (custom) out.push({ protocol, baseUrl: custom, origin: "custom" });
  }
  return out;
}

/**
 * 自定义渠道：从一个根地址推出四类接口的常见地址形态。根地址与注册表的
 * `normalizeOrigin` 同一口径（补 scheme、去 query 与尾部 v1 / v1beta）。
 */
export function customEndpointBaseUrl(protocol: ProviderChatProtocol, input: string): string {
  const root = normalizeOrigin(input);
  if (!root) return "";
  switch (protocol) {
    case "google-generative-ai":
      return `${root}/v1beta`;
    case "anthropic-messages":
      return root;
    default:
      return `${root}/v1`;
  }
}

export function classifyProbeError(error: unknown): {
  status: ProviderEndpointProbeStatus;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ProviderModelsFetchError ? error.status : null;
  if (status === 404 || status === 405) return { status: "missing", message };
  if (status === 401 || status === 403) return { status: "unauthorized", message };
  return { status: "unknown", message };
}

export async function probeEndpoint(params: {
  candidate: EndpointCandidate;
  apiKey: string;
  /** WebUI 下 Key 已脱敏（apiKey 为空）：按 providerId + credentialId 用已落库的 Key */
  credentialId?: string;
  useSystemProxy?: boolean;
  customHeaders?: readonly CustomHeader[];
  providerId?: string;
}): Promise<EndpointProbeResult> {
  const { candidate } = params;
  const type = legacyTypeForProtocol(candidate.protocol);
  const startedAt = Date.now();
  try {
    const models = await fetchModelsFromApi(type, candidate.baseUrl, params.apiKey, {
      useSystemProxy: params.useSystemProxy,
      isFullUrl: candidate.isFullUrl,
      modelsUrl: candidate.modelsUrl,
      providerId: params.providerId,
      credentialId: params.credentialId,
      customHeaders: params.customHeaders,
      // 严格模式：200 但没有模型数组（例如 {"code":401}）归"未知"而不是"可用"。
      strict: true,
    });
    return {
      protocol: candidate.protocol,
      baseUrl: candidate.baseUrl,
      status: "ok",
      latencyMs: Date.now() - startedAt,
      models,
    };
  } catch (error) {
    const classified = classifyProbeError(error);
    return {
      protocol: candidate.protocol,
      baseUrl: candidate.baseUrl,
      status: classified.status,
      latencyMs: Date.now() - startedAt,
      error: classified.message,
      models: [],
    };
  }
}

/**
 * 对每把启用的 Key 探测每个候选接口。接口之间并行，Key 之间串行（避免对同一
 * 网关瞬时打太多请求）。
 */
export async function probeProvider(params: {
  candidates: readonly EndpointCandidate[];
  credentials: readonly Pick<ProviderCredential, "id" | "apiKey" | "enabled">[];
  useSystemProxy?: boolean;
  customHeaders?: readonly CustomHeader[];
  providerId?: string;
  onProgress?: (partial: ProviderProbeResult) => void;
}): Promise<ProviderProbeResult> {
  const result: ProviderProbeResult = { at: Date.now(), credentials: [] };
  for (const credential of params.credentials) {
    if (!credential.enabled) continue;
    const endpoints = await Promise.all(
      params.candidates.map((candidate) =>
        probeEndpoint({
          candidate,
          apiKey: credential.apiKey,
          credentialId: credential.id,
          useSystemProxy: params.useSystemProxy,
          customHeaders: params.customHeaders,
          providerId: params.providerId,
        }),
      ),
    );
    result.credentials.push({ credentialId: credential.id, endpoints });
    params.onProgress?.({ ...result, credentials: [...result.credentials] });
  }
  return result;
}

/** 某接口在所有 Key 下的汇总状态：任一 Key 可用即可用；否则取最"具体"的失败。 */
export function summarizeEndpointStatus(
  probe: ProviderProbeResult,
  protocol: ProviderChatProtocol,
): { status: ProviderEndpointProbeStatus; latencyMs?: number; error?: string } {
  const results = probe.credentials
    .map((credential) => credential.endpoints.find((endpoint) => endpoint.protocol === protocol))
    .filter((item): item is EndpointProbeResult => Boolean(item));
  if (results.length === 0) return { status: "unknown" };
  const ok = results.find((item) => item.status === "ok");
  if (ok) return { status: "ok", latencyMs: ok.latencyMs };
  const order: ProviderEndpointProbeStatus[] = ["unauthorized", "missing", "unknown"];
  const worst = [...results].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0];
  return { status: worst.status, latencyMs: worst.latencyMs, error: worst.error };
}

export type ProbeModelGroup = {
  key: string;
  models: ProviderModelConfig[];
  /** 该分组按家族推荐并与可用接口取交集后的接口；空表示退到供应商默认 */
  protocol?: ProviderChatProtocol;
  dialect: ProviderWireDialect;
};

/** 摘要页分组：按模型家族，附推荐接口。 */
export function groupProbeModels(
  models: readonly ProviderModelConfig[],
  availableProtocols: readonly ProviderChatProtocol[],
  preset: ProviderPreset | undefined,
): ProbeModelGroup[] {
  const groups = new Map<string, ProbeModelGroup>();
  for (const model of models) {
    const family = resolveModelFamily(model.id);
    const rule = matchPresetModelRule(preset, model.id);
    const protocol =
      rule?.chatProtocols?.find((item) => availableProtocols.includes(item)) ??
      family.prefer.find((item) => availableProtocols.includes(item));
    // 家族方言只在官方渠道生效；中转/自建按路由实际解析（一般为 generic 或供应商默认）。
    const dialect: ProviderWireDialect =
      rule?.dialect ?? (preset?.native ? family.dialect : "generic");
    const group = groups.get(family.key) ?? { key: family.key, models: [], protocol, dialect };
    group.models.push(model);
    groups.set(family.key, group);
  }
  return [...groups.values()];
}

export type AutoConfiguration = {
  endpointConfigs: NonNullable<CustomProvider["endpointConfigs"]>;
  defaultChatProtocol: ProviderChatProtocol;
  dialect?: ProviderWireDialect;
  models: ProviderModelConfig[];
  activeModels: string[];
  credentials: ProviderCredential[];
  /** 有可用接口 */
  usable: boolean;
};

/**
 * 把探测结果变成可采纳的草稿。规则见设计文档 5.3：
 * 1. 每个可用接口一条端点（enabled），不可用的新接口不创建；已配置的端点保留，
 *    只写入本次观测；
 * 2. 默认接口：预设声明的若可用则用，否则取可用接口里家族表最常见的一个；
 * 3. 模型：各 Key 各接口列表按 id 合并去重，group 按家族，限额取供应商声明 /
 *    预设目录 / 兜底；
 * 4. 每把 Key 记录 lastModels 作为模型范围观测。
 */
export function buildAutoConfiguration(params: {
  preset: ProviderPreset | undefined;
  candidates: readonly EndpointCandidate[];
  probe: ProviderProbeResult;
  credentials: readonly ProviderCredential[];
  /** 用户在摘要页取消的接口 */
  rejectedProtocols?: ReadonlySet<ProviderChatProtocol>;
  /** 用户在摘要页取消的模型分组 */
  rejectedGroups?: ReadonlySet<string>;
  /** 探测失败但用户强制启用的接口 */
  forcedProtocols?: ReadonlySet<ProviderChatProtocol>;
}): AutoConfiguration {
  const { preset, probe } = params;
  const endpointConfigs: NonNullable<CustomProvider["endpointConfigs"]> = {};
  const available: ProviderChatProtocol[] = [];
  for (const candidate of params.candidates) {
    const summary = summarizeEndpointStatus(probe, candidate.protocol);
    const forced = params.forcedProtocols?.has(candidate.protocol) === true;
    const rejected = params.rejectedProtocols?.has(candidate.protocol) === true;
    const existing = candidate.origin === "existing";
    // 已配置的端点是用户的配置，不因一次探测失败而丢弃或停用，只更新观测；
    // 新发现的接口只有探测通过（或用户强制启用）才创建。
    if (!existing && summary.status !== "ok" && !forced) continue;
    const usable = summary.status === "ok" || forced;
    endpointConfigs[candidate.protocol] = {
      ...(rejected ? { enabled: false } : {}),
      baseUrl: candidate.baseUrl,
      ...(candidate.isFullUrl ? { isFullUrl: true } : {}),
      ...(candidate.modelsUrl ? { modelsUrl: candidate.modelsUrl } : {}),
      ...(candidate.dialect ? { dialect: candidate.dialect } : {}),
      ...(candidate.quirks ? { quirks: candidate.quirks } : {}),
      ...(candidate.auth ? { auth: candidate.auth } : {}),
      lastProbe: {
        at: probe.at,
        status: summary.status,
        ...(summary.latencyMs !== undefined ? { latencyMs: summary.latencyMs } : {}),
        ...(summary.error ? { error: summary.error } : {}),
      },
      source: existing ? "user" : "auto",
    };
    if (usable && !rejected) available.push(candidate.protocol);
  }

  const presetDefault = preset?.defaultChatProtocol;
  const defaultChatProtocol =
    presetDefault && available.includes(presetDefault)
      ? presetDefault
      : (pickMostCommonProtocol(available) ??
        presetDefault ??
        params.candidates[0]?.protocol ??
        "openai-completions");

  // 合并模型：各 Key 各接口 → 按 id 去重；同时记录每把 Key 看到的模型集合。
  const merged = new Map<string, ProviderModelConfig>();
  const seenByCredential = new Map<string, Set<string>>();
  for (const credentialResult of probe.credentials) {
    const seen = seenByCredential.get(credentialResult.credentialId) ?? new Set<string>();
    for (const endpoint of credentialResult.endpoints) {
      if (endpoint.status !== "ok" || !available.includes(endpoint.protocol)) continue;
      for (const fetched of endpoint.models) {
        seen.add(fetched.id);
        if (!merged.has(fetched.id)) merged.set(fetched.id, fetched);
      }
    }
    seenByCredential.set(credentialResult.credentialId, seen);
  }

  const models: ProviderModelConfig[] = [];
  for (const fetched of merged.values()) {
    const group = resolveModelGroup(fetched.id);
    if (params.rejectedGroups?.has(group)) continue;
    models.push(decorateAutoModel(fetched, preset, defaultChatProtocol));
  }
  models.sort((a, b) => a.id.localeCompare(b.id));

  const credentials = params.credentials.map((credential) => {
    const seen = seenByCredential.get(credential.id);
    return seen
      ? {
          ...credential,
          modelScope: credential.modelScope ?? { mode: "auto" as const },
          lastModels: { at: probe.at, models: [...seen].sort() },
        }
      : credential;
  });

  return {
    endpointConfigs,
    defaultChatProtocol,
    dialect: preset?.dialect,
    models,
    activeModels: models.map((model) => model.id),
    credentials,
    usable: available.length > 0,
  };
}

function pickMostCommonProtocol(
  available: readonly ProviderChatProtocol[],
): ProviderChatProtocol | undefined {
  if (available.length === 0) return undefined;
  // 网关通常以 Completions 兼容面最广；其次 Responses；再 Messages；最后 Gemini。
  const order: ProviderChatProtocol[] = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ];
  return order.find((protocol) => available.includes(protocol)) ?? available[0];
}

/** 给发现的模型补分组、限额初值与预设规则，全部标 auto。 */
function decorateAutoModel(
  fetched: ProviderModelConfig,
  preset: ProviderPreset | undefined,
  defaultChatProtocol: ProviderChatProtocol,
): ProviderModelConfig {
  const rule = matchPresetModelRule(preset, fetched.id);
  const catalog = findPresetCatalogModel(preset, fetched.id);
  const type = legacyTypeForProtocol(defaultChatProtocol);
  const defaults = getProviderModelDefaults(type, fetched.id);
  const base = normalizeProviderModelConfig(
    {
      ...fetched,
      ...(fetched.limitsSource === "provider"
        ? {}
        : catalog
          ? {
              contextWindow: catalog.contextWindow,
              maxOutputToken: catalog.maxOutputToken ?? defaults.maxOutputToken,
              limitsSource: "catalog",
            }
          : {}),
    },
    type,
  );
  return {
    ...(base ?? fetched),
    group: resolveModelGroup(fetched.id),
    ...(catalog?.name ? { displayName: catalog.name } : {}),
    ...(rule?.chatProtocols
      ? { chatProtocols: [...rule.chatProtocols], chatProtocol: rule.chatProtocols[0] }
      : {}),
    ...(rule?.wireModelId ? { wireModelId: rule.wireModelId } : {}),
    ...(rule?.dialect ? { dialect: rule.dialect } : {}),
    source: "auto",
  };
}
