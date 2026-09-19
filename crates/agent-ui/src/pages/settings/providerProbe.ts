// 快速接入探测与自动配置（设计文档 5.1 - 5.3、5.6）。
//
// 探测只用各接口的模型列表请求：对每把启用的 Key × 每个候选接口各拉一次，按
// 200 / 404 / 401 / 其他分类。结果是观测值；自动配置把观测变成一份可采纳的草稿
// （端点、默认接口、模型目录、每把 Key 的模型范围），全部标 `auto`。
//
// 按模型列表来源分流（`ProviderPreset.modelListSource`）：
// - catalog（模型厂商自营渠道）：模型列表随应用内置，探测不发任何请求，端点状态
//   记 `catalog`，模型取该渠道的目录分区；
// - api（聚合站、中转、本地服务、自定义）：照旧逐个接口拉 `/models`。

import {
  type CustomProvider,
  endpointUsesOrigin,
  expandProviderOriginUrl,
  getProviderModelDefaults,
  normalizeProviderModelConfig,
  type ProviderChatProtocol,
  type ProviderCredential,
  type ProviderEndpointConfig,
  type ProviderEndpointProbeStatus,
  type ProviderId,
  type ProviderModelConfig,
  type ProviderOrigin,
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
  presetUsesCatalogModels,
  resolveModelFamily,
  resolveModelGroup,
} from "../../lib/providers/registry";
import {
  buildProviderModelsUrl,
  fetchModelsFromApi,
  normalizeProviderModelsBaseUrl,
  ProviderModelsFetchError,
} from "./providerUtils";

export type EndpointCandidate = {
  protocol: ProviderChatProtocol;
  /** 实际探测的地址（`{origin}` 已按 originId 对应的源展开） */
  baseUrl: string;
  modelsUrl?: string;
  isFullUrl?: boolean;
  dialect?: ProviderWireDialect;
  quirks?: ProviderEndpointConfig["quirks"];
  auth?: ProviderEndpointConfig["auth"];
  note?: string;
  /** 来源：preset = 注册表声明；existing = 当前配置；custom = 用户手填 */
  origin: "preset" | "existing" | "custom";
  /** 候选按"源 × 接口"展开时所属的源；绝对地址的端点没有 */
  originId?: string;
  /** 采纳后写入端点的地址：`{origin}` 模板原样保留；只有按源展开的候选才有 */
  template?: { baseUrl: string; modelsUrl?: string };
};

export type EndpointProbeResult = {
  protocol: ProviderChatProtocol;
  baseUrl: string;
  originId?: string;
  status: ProviderEndpointProbeStatus;
  latencyMs?: number;
  error?: string;
  models: ProviderModelConfig[];
};

/** 源地址模式下四类接口的缺省模板（与 customEndpointBaseUrl 的路径形态一致）。 */
export function originEndpointTemplate(protocol: ProviderChatProtocol): string {
  switch (protocol) {
    case "google-generative-ai":
      return "{origin}/v1beta";
    case "anthropic-messages":
      return "{origin}";
    default:
      return "{origin}/v1";
  }
}

type CandidateSpec = Omit<EndpointCandidate, "originId" | "template">;

/**
 * 一条候选规格按源展开：地址含 `{origin}` 且供应商有源时，每个启用的源各一条
 * （带 originId 与模板）；模板但没有源时不可用；绝对地址原样一条。
 */
export function expandCandidateOrigins(
  spec: CandidateSpec,
  origins: readonly ProviderOrigin[] | undefined,
): EndpointCandidate[] {
  const templated = endpointUsesOrigin(spec.baseUrl) || endpointUsesOrigin(spec.modelsUrl);
  if (!templated) return [spec];
  const enabled = (origins ?? []).filter((origin) => origin.enabled !== false);
  return enabled.map((origin) => {
    const modelsUrl = expandProviderOriginUrl(spec.modelsUrl, origin);
    return {
      ...spec,
      baseUrl: expandProviderOriginUrl(spec.baseUrl, origin),
      ...(modelsUrl ? { modelsUrl } : { modelsUrl: undefined }),
      originId: origin.id,
      template: { baseUrl: spec.baseUrl, ...(spec.modelsUrl ? { modelsUrl: spec.modelsUrl } : {}) },
    };
  });
}

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

/** 观测里算"可用"的状态：真的拉到了列表，或模型列表本就内置（catalog）。 */
export function isProbeStatusUsable(status: ProviderEndpointProbeStatus): boolean {
  return status === "ok" || status === "catalog";
}

/**
 * 该候选真正会请求的模型列表地址（与 fetchModelsFromApi 同一口径：去重 /v1、
 * Gemini 用 v1beta）。界面预览与同一次探测里的请求去重都用它。
 */
export function probeModelsUrl(candidate: EndpointCandidate): string {
  if (candidate.modelsUrl) return candidate.modelsUrl;
  const type = legacyTypeForProtocol(candidate.protocol);
  try {
    return buildProviderModelsUrl(
      type,
      normalizeProviderModelsBaseUrl(type, candidate.baseUrl, candidate.isFullUrl === true),
      "official",
    );
  } catch {
    return candidate.baseUrl;
  }
}

/** 目录模型 → 探测结果里的模型条目；限额与显示名由 decorateAutoModel 再补齐。 */
export function catalogProbeModels(
  preset: Pick<ProviderPreset, "catalogModels">,
): ProviderModelConfig[] {
  return preset.catalogModels.map((entry) => ({
    id: entry.id,
    ...(entry.name ? { displayName: entry.name } : {}),
    contextWindow: entry.contextWindow,
    maxOutputToken: entry.maxOutputToken,
    limitsSource: "catalog" as const,
  }));
}

/**
 * 候选接口：注册表声明的接口（自定义渠道为四类全部）叠加当前已配置的端点。
 * origin 类模板由用户填写的地址展开；base 类（自定义）把同一地址给所有接口，
 * Gemini 与 Anthropic 按惯例改写路径。供应商有源地址列表时，候选按"源 × 接口"
 * 展开：既有 `{origin}` 端点与预设模板都按每个启用的源各探测一次，新接口的缺省
 * 地址也写成模板（采纳后仍相对源地址）。
 */
export function buildEndpointCandidates(params: {
  preset: ProviderPreset | undefined;
  origin?: string;
  baseUrl?: string;
  existing?: CustomProvider["endpointConfigs"];
  /** 供应商的源地址列表（含停用的；这里只展开启用的） */
  origins?: readonly ProviderOrigin[];
}): EndpointCandidate[] {
  const { preset } = params;
  const out: EndpointCandidate[] = [];
  const declared =
    preset && Object.keys(preset.endpoints).length > 0 ? preset.endpoints : undefined;
  const protocols = declared
    ? PROVIDER_CHAT_PROTOCOLS.filter((protocol) => declared[protocol])
    : PROVIDER_CHAT_PROTOCOLS;
  const originMode = (params.origins ?? []).some((origin) => origin.enabled !== false);
  for (const protocol of protocols) {
    const existing = params.existing?.[protocol];
    if (existing) {
      out.push(
        ...expandCandidateOrigins(
          {
            protocol,
            baseUrl: existing.baseUrl,
            modelsUrl: existing.modelsUrl,
            isFullUrl: existing.isFullUrl,
            dialect: existing.dialect,
            quirks: existing.quirks,
            auth: existing.auth,
            origin: "existing",
          },
          params.origins,
        ),
      );
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
      const spec = {
        protocol,
        modelsUrl: presetEndpoint.modelsUrl,
        dialect: presetEndpoint.dialect,
        quirks: presetEndpoint.quirks,
        auth: presetEndpoint.auth,
        note: presetEndpoint.note,
        origin: "preset" as const,
      };
      if (originMode && presetEndpoint.baseUrl.includes("{origin}")) {
        out.push(
          ...expandCandidateOrigins({ ...spec, baseUrl: presetEndpoint.baseUrl }, params.origins),
        );
        continue;
      }
      const baseUrl = expandPresetBaseUrl(presetEndpoint.baseUrl, params.origin ?? params.baseUrl);
      if (!baseUrl) continue;
      out.push({ ...spec, baseUrl });
      continue;
    }
    if (originMode) {
      out.push(
        ...expandCandidateOrigins(
          { protocol, baseUrl: originEndpointTemplate(protocol), origin: "custom" },
          params.origins,
        ),
      );
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
      ...(candidate.originId ? { originId: candidate.originId } : {}),
      status: "ok",
      latencyMs: Date.now() - startedAt,
      models,
    };
  } catch (error) {
    const classified = classifyProbeError(error);
    return {
      protocol: candidate.protocol,
      baseUrl: candidate.baseUrl,
      ...(candidate.originId ? { originId: candidate.originId } : {}),
      status: classified.status,
      latencyMs: Date.now() - startedAt,
      error: classified.message,
      models: [],
    };
  }
}

/** 该候选的模型列表请求签名：签名相同 = 发出去的请求逐字节相同。 */
function probeRequestKey(candidate: EndpointCandidate): string {
  // 鉴权头档随旧类型变（Messages 会回退 x-api-key，Completions 只发 Bearer），
  // 所以地址相同还不够，必须连头档一起相同才算同一个请求。
  return [
    candidate.originId ?? "",
    legacyTypeForProtocol(candidate.protocol),
    candidate.isFullUrl === true ? "full" : "base",
    probeModelsUrl(candidate),
  ].join("|");
}

/** catalog 渠道：不发请求，每个候选接口都记 `catalog` 并带上该渠道的目录模型。 */
function catalogEndpointResults(
  candidates: readonly EndpointCandidate[],
  preset: Pick<ProviderPreset, "catalogModels">,
): EndpointProbeResult[] {
  const models = catalogProbeModels(preset);
  return candidates.map((candidate) => ({
    protocol: candidate.protocol,
    baseUrl: candidate.baseUrl,
    ...(candidate.originId ? { originId: candidate.originId } : {}),
    status: "catalog" as const,
    models,
  }));
}

/**
 * 对每把启用的 Key 探测每个候选接口。接口之间并行，Key 之间串行（避免对同一
 * 网关瞬时打太多请求）。
 *
 * 传入 catalog 渠道的预设时整个过程不发请求（模型列表随应用内置）。api 渠道下，
 * 同一把 Key、同一个源上请求签名相同的候选**只发一次**请求，结果复用给共享它的
 * 每个接口——这是去重不是跳过：摘要仍按接口逐行给状态，只是不再为同一个
 * `…/v1/models` 重复打三次。
 */
export async function probeProvider(params: {
  candidates: readonly EndpointCandidate[];
  credentials: readonly Pick<ProviderCredential, "id" | "apiKey" | "enabled">[];
  useSystemProxy?: boolean;
  customHeaders?: readonly CustomHeader[];
  providerId?: string;
  /** 渠道预设；`modelListSource: "catalog"` 时不请求 `/models` */
  preset?: ProviderPreset;
  onProgress?: (partial: ProviderProbeResult) => void;
}): Promise<ProviderProbeResult> {
  const result: ProviderProbeResult = { at: Date.now(), credentials: [] };
  const catalog = presetUsesCatalogModels(params.preset) ? params.preset : undefined;
  for (const credential of params.credentials) {
    if (!credential.enabled) continue;
    let endpoints: EndpointProbeResult[];
    if (catalog) {
      endpoints = catalogEndpointResults(params.candidates, catalog);
    } else {
      const inFlight = new Map<string, Promise<EndpointProbeResult>>();
      endpoints = await Promise.all(
        params.candidates.map(async (candidate) => {
          const key = probeRequestKey(candidate);
          let pending = inFlight.get(key);
          if (!pending) {
            pending = probeEndpoint({
              candidate,
              apiKey: credential.apiKey,
              credentialId: credential.id,
              useSystemProxy: params.useSystemProxy,
              customHeaders: params.customHeaders,
              providerId: params.providerId,
            });
            inFlight.set(key, pending);
          }
          const shared = await pending;
          // 复用的观测挂回本接口自己的身份（源已在签名里，只需换协议与地址）。
          return { ...shared, protocol: candidate.protocol, baseUrl: candidate.baseUrl };
        }),
      );
    }
    result.credentials.push({ credentialId: credential.id, endpoints });
    params.onProgress?.({ ...result, credentials: [...result.credentials] });
  }
  return result;
}

export type ProbeStatusSummary = {
  status: ProviderEndpointProbeStatus;
  latencyMs?: number;
  error?: string;
};

/**
 * 某接口在所有 Key（与所有源）下的汇总状态：任一可用即可用；否则取最"具体"的失败。
 * 传 originId 时只看该源上的结果。
 */
export function summarizeEndpointStatus(
  probe: ProviderProbeResult,
  protocol: ProviderChatProtocol,
  originId?: string,
): ProbeStatusSummary {
  const results = probe.credentials.flatMap((credential) =>
    credential.endpoints.filter(
      (endpoint) =>
        endpoint.protocol === protocol &&
        (originId === undefined || endpoint.originId === originId),
    ),
  );
  if (results.length === 0) return { status: "unknown" };
  // catalog（模型列表内置、没发请求）与 ok 同样算可用，但没有延迟可报。
  const usable = results.find((item) => isProbeStatusUsable(item.status));
  if (usable) {
    return usable.status === "catalog"
      ? { status: "catalog" }
      : { status: "ok", latencyMs: usable.latencyMs };
  }
  const order: ProviderEndpointProbeStatus[] = ["unauthorized", "missing", "unknown"];
  const worst = [...results].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0];
  return { status: worst.status, latencyMs: worst.latencyMs, error: worst.error };
}

/**
 * 某个源的汇总状态：该源下各接口先按 Key 汇总，再取最差（连接失败 > 鉴权 > 404），
 * 全部可用才算可用。没有该源的结果时为 unknown。
 */
export function summarizeOriginStatus(
  probe: ProviderProbeResult,
  candidates: readonly EndpointCandidate[],
  originId: string,
): ProbeStatusSummary {
  const protocols = [
    ...new Set(
      candidates
        .filter((candidate) => candidate.originId === originId)
        .map((candidate) => candidate.protocol),
    ),
  ];
  const summaries = protocols.map((protocol) => summarizeEndpointStatus(probe, protocol, originId));
  if (summaries.length === 0) return { status: "unknown" };
  const order: ProviderEndpointProbeStatus[] = [
    "unknown",
    "unauthorized",
    "missing",
    "ok",
    "catalog",
  ];
  return [...summaries].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0];
}

export type ProbeModelGroup = {
  key: string;
  models: ProviderModelConfig[];
  /** 该分组按系列偏好与采纳后可路由的接口取交集后的接口；空表示退到供应商默认 */
  protocol?: ProviderChatProtocol;
  /** 推荐接口本次探测是否通过（false = 端点仍启用、路由会选它，但模型列表探测未通过） */
  verified: boolean;
  dialect: ProviderWireDialect;
};

/**
 * 摘要页分组：按模型系列，附推荐接口。推荐接口与运行时路由同一规则——系列偏好 ∩
 * 采纳后**已启用**的接口（`routableProtocols`：本次探测通过的 + 既有已启用端点），
 * 而不只是探测通过的接口；否则中转的 Messages 端点没实现 /v1/models 时，摘要会
 * 把 Claude 标成 Completions，采纳后实际却走 Messages。
 */
export function groupProbeModels(
  models: readonly ProviderModelConfig[],
  availableProtocols: readonly ProviderChatProtocol[],
  preset: ProviderPreset | undefined,
  routableProtocols: readonly ProviderChatProtocol[] = availableProtocols,
): ProbeModelGroup[] {
  const groups = new Map<string, ProbeModelGroup>();
  for (const model of models) {
    const family = resolveModelFamily(model.id);
    const rule = matchPresetModelRule(preset, model.id);
    const protocol =
      rule?.chatProtocols?.find((item) => routableProtocols.includes(item)) ??
      family.prefer.find((item) => routableProtocols.includes(item));
    const verified = protocol !== undefined && availableProtocols.includes(protocol);
    // 家族方言只在官方渠道生效；中转/自建按路由实际解析（一般为 generic 或供应商默认）。
    const dialect: ProviderWireDialect =
      rule?.dialect ?? (preset?.native ? family.dialect : "generic");
    const group = groups.get(family.key) ?? {
      key: family.key,
      models: [],
      protocol,
      verified,
      dialect,
    };
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
  /**
   * 采纳后默认启用的模型。探测发现的模型一律**不**自动启用（恒为空数组）：
   * 一个中转动辄几百个模型，开哪些由人决定，模型本身照常写入列表。
   */
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
 * 3. 模型：各 Key 各接口列表按 id 合并去重（catalog 渠道则来自内置目录），group
 *    按家族，限额取供应商声明 / 预设目录 / 兜底；一律不自动启用；
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
  const seenProtocols = new Set<ProviderChatProtocol>();
  for (const candidate of params.candidates) {
    // 按源展开的候选每个接口只写一条端点（模板相同）；状态按接口跨源、跨 Key 汇总。
    if (seenProtocols.has(candidate.protocol)) continue;
    seenProtocols.add(candidate.protocol);
    const summary = summarizeEndpointStatus(probe, candidate.protocol);
    const forced = params.forcedProtocols?.has(candidate.protocol) === true;
    const rejected = params.rejectedProtocols?.has(candidate.protocol) === true;
    const existing = candidate.origin === "existing";
    // 已配置的端点是用户的配置，不因一次探测失败而丢弃或停用，只更新观测；
    // 新发现的接口只有探测通过（或用户强制启用）才创建。
    if (!existing && !isProbeStatusUsable(summary.status) && !forced) continue;
    const usable = isProbeStatusUsable(summary.status) || forced;
    // 端点落模板：按源展开的候选采纳后仍相对源地址书写。
    const modelsUrl = candidate.template ? candidate.template.modelsUrl : candidate.modelsUrl;
    endpointConfigs[candidate.protocol] = {
      ...(rejected ? { enabled: false } : {}),
      baseUrl: candidate.template?.baseUrl ?? candidate.baseUrl,
      ...(candidate.isFullUrl ? { isFullUrl: true } : {}),
      ...(modelsUrl ? { modelsUrl } : {}),
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
      if (!isProbeStatusUsable(endpoint.status) || !available.includes(endpoint.protocol)) continue;
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
    // 模型默认全部关闭：采纳后在列表里逐个启用（见 AutoConfiguration.activeModels）。
    activeModels: [],
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
    ...(rule?.chatProtocols ? { chatProtocol: rule.chatProtocols[0] } : {}),
    ...(rule?.wireModelId ? { wireModelId: rule.wireModelId } : {}),
    ...(rule?.dialect ? { dialect: rule.dialect } : {}),
    source: "auto",
  };
}
