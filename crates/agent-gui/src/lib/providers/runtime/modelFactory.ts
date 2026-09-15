import type { Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type ModelThinkingCapability,
  resolveModelThinking,
  type ThinkingLevelMap,
  toThinkingLevelMap,
} from "@liveagent/ui/lib/models/modelThinking";
import { inferEndpointQuirksFromBaseUrl } from "@liveagent/ui/lib/providers/registry/protocols";
import {
  type CodexRequestFormat,
  getProviderChatProtocolAdapter,
  getProviderModelDefaults,
  normalizeInputModalities,
  type ProviderChatProtocol,
  type ProviderEndpointQuirks,
  type ProviderId,
  type ProviderModelConfig,
  type ProviderWireDialect,
} from "../../settings";
import {
  findBuiltinAnthropicModel,
  isAnthropicAdaptiveModelId,
  resolveAnthropicContextWindow,
  resolveAnthropicWireModelId,
} from "../anthropicModels";
import {
  DEEPSEEK_RESPONSES_API,
  isOfficialDeepSeekBaseUrl,
  normalizeDeepSeekResponsesBaseUrl,
} from "../deepSeekNative";
import type { ProviderRuntimeConfig } from "./types";
import {
  resolveLegacyWireRoute,
  resolveRuntimeLocalModelId,
  resolveRuntimeWireModelId,
  resolveRuntimeWireRoute,
} from "./wireRoute";
import { isXaiDirectBaseUrl } from "./xaiResponsesPayload";

// ---------------------------------------------------------------------------
// 思考档位：可用性一律来自 lib/models/modelThinking（生成目录），此处只保留
// 各家 wire 值改写表；toThinkingLevelMap 保证 wire 表不复活目录裁掉的档，
// UI 列表与请求期 clamp（pi-ai getSupportedThinkingLevels）由此同源。
// ---------------------------------------------------------------------------

/** Grok / xAI wire 值：官方 effort 无 minimal，向上取 low。 */
const XAI_THINKING_WIRE_VALUES: ThinkingLevelMap = {
  minimal: "low",
};

/** DeepSeek Responses accepts none/low/high/max; medium/xhigh map to high. */
const DEEPSEEK_THINKING_WIRE_VALUES: ThinkingLevelMap = {
  off: "none",
  minimal: "low",
  medium: "high",
  xhigh: "high",
};

function resolveModelThinkingFields(
  capability: ModelThinkingCapability,
  wireValues?: ThinkingLevelMap,
): Pick<Model<Api>, "reasoning"> & { thinkingLevelMap?: ThinkingLevelMap } {
  const thinkingLevelMap = toThinkingLevelMap(capability, wireValues);
  return {
    reasoning: capability.reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

const CODEX_RESPONSES_SUFFIX = "/responses";
const CODEX_RESPONSE_SUFFIX = "/response";
const CODEX_CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

type CodexApi = "openai-responses" | "openai-completions";

/**
 * 方言 → pi-ai Model.provider。pi-ai 的 detectCompat 按它推导 Completions 兼容开关
 * （deepseek：max_tokens / reasoning_content 回放 / thinkingFormat；xai：不发
 * reasoning_effort），openai 保留官方语义。
 *
 * generic 方言也落到 "openai"，而不是 "custom"：Model.provider 同时是历史消息的
 * 身份键——pi-ai transformMessages 用 `assistantMsg.provider === model.provider`
 * 判定"同一模型"，异模型会剥掉带签名的思考块。既有 OpenAI 兼容实例的历史会话
 * 全部以 "openai" 落盘，改名会让升级后的第一轮被判为换模型。detectCompat 对
 * "custom" 与 "openai" 没有任何分支差异；非官方上游的 store / developer /
 * finish_reason 默认已由 resolveOpenAICompletionsCompat 显式给出，不依赖它。
 */
const DIALECT_PROVIDER_IDS: Record<ProviderWireDialect, string> = {
  generic: "openai",
  openai: "openai",
  xai: "xai",
  deepseek: "deepseek",
};

function resolveKnownModel(
  provider: "openai" | "anthropic" | "google",
  modelId: string,
  baseUrl: string,
): Model<Api> | undefined {
  const known = getBuiltinModels(provider).find((model) => model.id === modelId);
  return known?.api ? { ...known, baseUrl } : undefined;
}

// ---------------------------------------------------------------------------
// Anthropic 目录回查与自定义模型思考能力推断
// ---------------------------------------------------------------------------

// 规范化候选回查目录（见 anthropicModels.ts）；漏检后模型丢失
// compat.forceAdaptiveThinking，思考配置退化成 4.7+/Fable 世代已删除的
// budget_tokens（官方端点 400、中转剥字段后档位彻底失效）。命中则继承完整
// 目录元数据；默认保留用户配置的原始 id，官方/Vertex 等端点的 [1m] 后缀则在
// wire 层剥离，避免把目录装饰符发送给只接受 canonical id 的服务。
function resolveKnownAnthropicModel(
  modelId: string,
  wireModelId: string,
  baseUrl: string,
  upstreamBaseUrl?: string,
): Model<Api> | undefined {
  const known = findBuiltinAnthropicModel(modelId);
  if (!known?.api) return undefined;
  const endpointBaseUrl = upstreamBaseUrl?.trim() || baseUrl;
  return {
    ...known,
    baseUrl,
    id: resolveAnthropicWireModelId(wireModelId, endpointBaseUrl),
    name: modelId,
  } as Model<Api>;
}

// 目录彻底未命中的三方改名 id（如 claude-4.6-sonnet）退回 id 启发式：能识别为
// adaptive 家族的补上 compat.forceAdaptiveThinking（wire 语义——thinking.type
// adaptive + output_config.effort），pi-ai stream() 与本地 thinkingLevels.ts 都以
// 该字段为准。档位声明不在这里——那由 resolveModelThinking 的同一启发式兜底。
function deriveAnthropicCompatForCustomModel(
  modelId: string,
): Model<"anthropic-messages">["compat"] | undefined {
  return isAnthropicAdaptiveModelId(modelId) ? { forceAdaptiveThinking: true } : undefined;
}

function maybeAppendGeminiApiVersion(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    let pathname = url.pathname.replace(/\/+$/, "");
    const lowerPathname = pathname.toLowerCase();
    for (const suffix of [":streamgeneratecontent", ":generatecontent"]) {
      if (lowerPathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length);
        break;
      }
    }
    const modelsIndex = pathname.toLowerCase().lastIndexOf("/models");
    if (
      modelsIndex >= 0 &&
      (pathname.length === modelsIndex + "/models".length ||
        pathname.charAt(modelsIndex + "/models".length) === "/")
    ) {
      pathname = pathname.slice(0, modelsIndex);
    }
    if (!pathname || pathname === "/") {
      url.pathname = "/v1beta";
      return url.toString().replace(/\/+$/, "");
    }
    if (/\/v\d+(?:beta)?$/i.test(pathname)) {
      url.pathname = pathname;
      return url.toString().replace(/\/+$/, "");
    }
    url.pathname = `${pathname}/v1beta`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

function maybeAppendCodexApiVersion(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!/\/v1$/i.test(pathname)) {
      url.pathname = `${pathname}/v1`;
    } else {
      url.pathname = pathname;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}

function supportsOpenAICompletionsImageInputModel(modelId: string) {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (normalizedModelId.includes("search-preview")) return false;
  return (
    normalizedModelId.startsWith("gpt-5") ||
    normalizedModelId.startsWith("chat-latest") ||
    normalizedModelId.startsWith("gpt-4o") ||
    normalizedModelId.startsWith("chatgpt-4o") ||
    normalizedModelId.startsWith("gpt-4.1") ||
    normalizedModelId.startsWith("gpt-4.5") ||
    normalizedModelId.startsWith("gpt-4-turbo") ||
    normalizedModelId.startsWith("o3") ||
    normalizedModelId.startsWith("o4") ||
    normalizedModelId.includes("vision") ||
    normalizedModelId.includes("qwen-vl") ||
    normalizedModelId.includes("qwen2-vl") ||
    normalizedModelId.includes("qwen2.5-vl") ||
    normalizedModelId.includes("qwen3-vl") ||
    normalizedModelId.includes("llava") ||
    normalizedModelId.includes("pixtral")
  );
}

function resolveCodexModelInput(api: CodexApi, modelId: string): Model<Api>["input"] {
  if (api === "openai-responses" || supportsOpenAICompletionsImageInputModel(modelId)) {
    return ["text", "image"];
  }
  return ["text"];
}

/**
 * DeepSeek 只有 Flash 家族吃图片：官方《图像理解》指南明确 deepseek-flash 支持
 * image_url / input_image / Files API file_id 三种传法，并注明旧模型名
 * deepseek-v4-flash-vision-exp 已下线、其请求同样由最新 Flash 承接。Pro 与更早
 * 的模型不跟着一起放开，避免产生虚假能力声明。
 *
 * 中转端点若实际不吃图，用设置里的 inputModalities 覆盖成 ["text"]：用户覆盖
 * 优先于本推断（见 createModelFromConfig 的 inputOverride）。
 */
function resolveDeepSeekModelInput(modelId: string): Model<Api>["input"] {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedModelId) return ["text"];
  return normalizedModelId.includes("flash") ? ["text", "image"] : ["text"];
}

function isOfficialOpenAIBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl?.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function normalizeCompatBaseUrl(baseUrl: string | undefined) {
  return baseUrl?.trim().replace(/\/+$/, "").toLowerCase() ?? "";
}

/** 端点 quirks → pi-ai compat 同名键；只带用户声明过的键。 */
function quirksToCompat(
  quirks: ProviderEndpointQuirks | undefined,
): Partial<OpenAICompletionsCompat> {
  const compat: Partial<OpenAICompletionsCompat> = {};
  if (!quirks) return compat;
  if (quirks.supportsUsageInStreaming !== undefined) {
    compat.supportsUsageInStreaming = quirks.supportsUsageInStreaming;
  }
  if (quirks.supportsDeveloperRole !== undefined) {
    compat.supportsDeveloperRole = quirks.supportsDeveloperRole;
  }
  if (quirks.supportsReasoningEffort !== undefined) {
    compat.supportsReasoningEffort = quirks.supportsReasoningEffort;
  }
  if (quirks.supportsStore !== undefined) compat.supportsStore = quirks.supportsStore;
  if (quirks.thinkingFormat !== undefined) compat.thinkingFormat = quirks.thinkingFormat;
  if (quirks.maxTokensField !== undefined) compat.maxTokensField = quirks.maxTokensField;
  return compat;
}

function mergeCompat<T extends object>(
  base: T | undefined,
  overlay: Partial<OpenAICompletionsCompat>,
): T | undefined {
  const merged = { ...(base ?? {}), ...overlay } as T;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Responses 兼容：pi-ai 看到的是本地反代地址，无法感知上游是否官方 OpenAI，
 * 所以"非官方端点不发 developer 角色"这条仍由这里显式给出。
 */
function resolveOpenAIResponsesCompat(params: {
  baseUrl: string;
  upstreamBaseUrl?: string;
}): Model<"openai-responses">["compat"] | undefined {
  const compatBaseUrl = normalizeCompatBaseUrl(params.upstreamBaseUrl ?? params.baseUrl);
  if (isOfficialOpenAIBaseUrl(compatBaseUrl)) return undefined;

  return {
    supportsDeveloperRole: false,
  };
}

/**
 * Completions 兼容：厂商差异（xai / deepseek）由 Model.provider 交给 pi-ai 的
 * detectCompat；这里只保留 pi-ai 隔着反代看不到的"上游不是官方 OpenAI"默认
 * （不发 store / developer 角色，且不依赖 finish_reason）。
 */
function resolveOpenAICompletionsCompat(params: {
  dialect: ProviderWireDialect;
  baseUrl: string;
  upstreamBaseUrl?: string;
}): OpenAICompletionsCompat | undefined {
  if (params.dialect !== "openai" && params.dialect !== "generic") return undefined;
  const compatBaseUrl = normalizeCompatBaseUrl(params.upstreamBaseUrl ?? params.baseUrl);
  if (isOfficialOpenAIBaseUrl(compatBaseUrl)) return undefined;
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsFinishReason: false,
  };
}

function normalizeCodexBaseUrl(baseUrl: string): {
  baseUrl: string;
  preferredApi?: CodexApi;
} {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  const lower = normalized.toLowerCase();
  let preferredApi: CodexApi | undefined;

  if (lower.endsWith(CODEX_CHAT_COMPLETIONS_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_CHAT_COMPLETIONS_SUFFIX.length);
    preferredApi = "openai-completions";
  } else if (lower.endsWith(CODEX_RESPONSES_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_RESPONSES_SUFFIX.length);
    preferredApi = "openai-responses";
  } else if (lower.endsWith(CODEX_RESPONSE_SUFFIX)) {
    normalized = normalized.slice(0, -CODEX_RESPONSE_SUFFIX.length);
    preferredApi = "openai-responses";
  }

  return {
    baseUrl: maybeAppendCodexApiVersion(normalized),
    preferredApi,
  };
}

// ---------------------------------------------------------------------------
// 按 (protocol, dialect) 构造 pi-ai Model
// ---------------------------------------------------------------------------

export type ModelFactoryRoute = {
  protocol: ProviderChatProtocol;
  dialect: ProviderWireDialect;
  /** 本地模型 ID：目录、思考档位与限额查询都用它。 */
  modelId: string;
  /** 发给远端的模型名（pi-ai Model.id 就是发送的名字）；缺省等于 modelId。 */
  wireModelId?: string;
  /** Model.baseUrl：经本地反代后的地址。 */
  baseUrl: string;
  /** 上游真实地址：官方域名判定（目录限额、Anthropic [1m] 后缀、OpenAI 官方兼容）。 */
  upstreamBaseUrl?: string;
  modelConfig?: ProviderModelConfig;
  quirks?: ProviderEndpointQuirks;
  /** 旧适配器家族（目录与限额表按它分组）；缺省由 (protocol, dialect) 推导。 */
  adapterProviderId?: ProviderId;
};

function buildDeepSeekResponsesModel(
  route: ModelFactoryRoute,
  wireModelId: string,
  fields: {
    contextWindow: number;
    maxTokens: number;
    thinking: ModelThinkingCapability;
    inputOverride: ReturnType<typeof normalizeInputModalities>;
  },
): Model<Api> {
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    id: wireModelId,
    name: route.modelId,
    api: DEEPSEEK_RESPONSES_API,
    provider: "deepseek",
    baseUrl: normalizeDeepSeekResponsesBaseUrl(route.baseUrl, {
      officialHost: isOfficialDeepSeekBaseUrl(route.upstreamBaseUrl?.trim() || route.baseUrl),
    }),
    ...resolveModelThinkingFields(fields.thinking, DEEPSEEK_THINKING_WIRE_VALUES),
    input: fields.inputOverride ?? resolveDeepSeekModelInput(route.modelId),
    cost: zeroCost,
    contextWindow: fields.contextWindow,
    maxTokens: fields.maxTokens,
    compat: {
      supportsDeveloperRole: true,
      supportsLongCacheRetention: false,
      supportsStrictMode: false,
    },
  } as Model<Api>;
}

function buildOpenAIFamilyModel(
  route: ModelFactoryRoute,
  api: CodexApi,
  wireModelId: string,
  fields: {
    contextWindow: number;
    maxTokens: number;
    thinking: ModelThinkingCapability;
    inputOverride: ReturnType<typeof normalizeInputModalities>;
  },
): Model<Api> {
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const { baseUrl: normalizedBaseUrl } = normalizeCodexBaseUrl(route.baseUrl);
  const provider = DIALECT_PROVIDER_IDS[route.dialect];
  const quirkCompat = quirksToCompat(route.quirks);
  const baseCompat =
    api === "openai-responses"
      ? resolveOpenAIResponsesCompat({
          baseUrl: normalizedBaseUrl,
          upstreamBaseUrl: route.upstreamBaseUrl,
        })
      : resolveOpenAICompletionsCompat({
          dialect: route.dialect,
          baseUrl: normalizedBaseUrl,
          upstreamBaseUrl: route.upstreamBaseUrl,
        });
  const isXai = route.dialect === "xai";
  const known = resolveKnownModel("openai", route.modelId, normalizedBaseUrl);
  if (known && known.api === api) {
    const compat = mergeCompat(known.compat, { ...(baseCompat ?? {}), ...quirkCompat });
    return {
      ...known,
      id: wireModelId,
      provider,
      contextWindow: fields.contextWindow,
      maxTokens: fields.maxTokens,
      cost: zeroCost,
      ...(fields.inputOverride ? { input: fields.inputOverride } : {}),
      ...resolveModelThinkingFields(
        fields.thinking,
        isXai ? XAI_THINKING_WIRE_VALUES : known.thinkingLevelMap,
      ),
      ...(compat ? { compat } : {}),
    } as Model<Api>;
  }

  const compat = mergeCompat(baseCompat, quirkCompat);
  const custom: Model<Api> = {
    id: wireModelId,
    name: route.modelId,
    api,
    provider,
    baseUrl: normalizedBaseUrl,
    ...resolveModelThinkingFields(fields.thinking, isXai ? XAI_THINKING_WIRE_VALUES : undefined),
    input: fields.inputOverride ?? resolveCodexModelInput(api, route.modelId),
    cost: zeroCost,
    contextWindow: fields.contextWindow,
    maxTokens: fields.maxTokens,
  };
  if (compat) custom.compat = compat as Model<Api>["compat"];
  return custom;
}

export function createModelFromRoute(route: ModelFactoryRoute): Model<Api> {
  const modelId = route.modelId;
  const wireModelId = route.wireModelId?.trim() || modelId;
  const providerId =
    route.adapterProviderId ?? getProviderChatProtocolAdapter(route.protocol, route.dialect);
  const defaults = getProviderModelDefaults(providerId, modelId);
  const configuredContextWindow = route.modelConfig?.contextWindow ?? defaults.contextWindow;
  const upstream = route.upstreamBaseUrl?.trim() || route.baseUrl;
  const contextWindow =
    route.protocol === "anthropic-messages"
      ? resolveAnthropicContextWindow(modelId, configuredContextWindow, upstream)
      : configuredContextWindow;
  const maxTokens = route.modelConfig?.maxOutputToken ?? defaults.maxOutputToken;
  // 计费功能已整体移除：pi-ai 的 Model.cost 是结构必填字段，统一喂零价，
  // 流式侧算出的 usage.cost 恒为 0（known 分支同样覆盖，防止目录单价复活计费）。
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // 思考能力（reasoning + 档位）唯一来源：生成目录（未命中走其兜底推断）。
  // pi-ai 目录命中时只取其 thinkingLevelMap 的 wire 改写值，可用性不听它的。
  const thinking = resolveModelThinking(providerId, modelId);
  // 输入模态的用户显式覆盖（如给未被内置白名单识别的多模态模型开启图片
  // 输入）；缺省走各 provider 的内置推断/已知模型目录。校验逻辑与设置加载
  // 共用同一个 normalizer，不信任调用方的静态类型。
  // 只在附件发送确实受 model.input 门控的分支生效（OpenAI 家族 / gemini /
  // DeepSeek Responses）；anthropic 附件路径暂不读 model.input，那里不适用用户
  // 覆盖，避免产生虚假能力声明。
  const inputOverride = normalizeInputModalities(route.modelConfig?.inputModalities);

  if (route.protocol === "openai-responses" && route.dialect === "deepseek") {
    return buildDeepSeekResponsesModel(route, wireModelId, {
      contextWindow,
      maxTokens,
      thinking,
      inputOverride,
    });
  }

  if (route.protocol === "openai-responses" || route.protocol === "openai-completions") {
    return buildOpenAIFamilyModel(route, route.protocol, wireModelId, {
      contextWindow,
      maxTokens,
      thinking,
      inputOverride,
    });
  }

  if (route.protocol === "google-generative-ai") {
    const normalizedBaseUrl = maybeAppendGeminiApiVersion(route.baseUrl);
    const known = resolveKnownModel("google", modelId, normalizedBaseUrl);
    if (known && known.api === "google-generative-ai") {
      return {
        ...known,
        id: wireModelId,
        contextWindow,
        maxTokens,
        cost: zeroCost,
        ...(inputOverride ? { input: inputOverride } : {}),
        ...resolveModelThinkingFields(thinking, known.thinkingLevelMap),
      };
    }

    const custom: Model<"google-generative-ai"> = {
      id: wireModelId,
      name: modelId,
      api: "google-generative-ai",
      provider: "google",
      baseUrl: normalizedBaseUrl,
      ...resolveModelThinkingFields(thinking),
      input: inputOverride ?? ["text", "image"],
      cost: zeroCost,
      contextWindow,
      maxTokens,
    };
    return custom;
  }

  const known = resolveKnownAnthropicModel(
    modelId,
    wireModelId,
    route.baseUrl,
    route.upstreamBaseUrl,
  );
  if (known) {
    return {
      ...known,
      contextWindow,
      maxTokens,
      cost: zeroCost,
      ...resolveModelThinkingFields(thinking, known.thinkingLevelMap),
    };
  }

  const customCompat = deriveAnthropicCompatForCustomModel(modelId);
  const custom: Model<"anthropic-messages"> = {
    id: resolveAnthropicWireModelId(wireModelId, upstream),
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: route.baseUrl,
    ...resolveModelThinkingFields(thinking),
    input: ["text"],
    cost: zeroCost,
    contextWindow,
    maxTokens,
    ...(customCompat ? { compat: customCompat } : {}),
  };
  return custom;
}

/**
 * 从运行时配置构造模型：协议、方言、远端模型名、quirks 全部取路由结果；
 * 手写的旧 runtime 缺这些字段时按 adapterProviderId / requestFormat 旧推导补齐。
 */
export function createModelFromRuntime(
  providerId: ProviderId,
  runtime: ProviderRuntimeConfig,
  modelId: string,
  baseUrl: string,
): Model<Api> {
  const wire = resolveRuntimeWireRoute(providerId, runtime);
  const localModelId = resolveRuntimeLocalModelId(runtime, modelId);
  if (
    runtime.protocol === undefined &&
    runtime.chatProtocol === undefined &&
    runtime.dialect === undefined
  ) {
    // 旧 runtime：沿用按 ProviderId 的推导（含 Base URL 后缀与 xAI 直连识别）。
    return createModelFromConfig(
      wire.adapterProviderId,
      localModelId,
      baseUrl,
      runtime.requestFormat,
      runtime.modelConfig,
      runtime.baseUrl.trim(),
      runtime.quirks,
    );
  }
  return createModelFromRoute({
    protocol: wire.protocol,
    dialect: wire.dialect,
    modelId: localModelId,
    wireModelId: resolveRuntimeWireModelId(runtime, localModelId),
    baseUrl,
    upstreamBaseUrl: runtime.baseUrl.trim(),
    modelConfig: runtime.modelConfig,
    quirks: runtime.quirks,
    adapterProviderId: wire.adapterProviderId,
  });
}

/**
 * 旧签名：按 ProviderId + requestFormat 推导 (protocol, dialect)。保留 Base URL 后缀
 * 与 xAI 直连（api.x.ai）识别——那是旧存档没有显式接口时的路由来源，不是兼容开关。
 *
 * 端点 quirks 与路由路径同源：按上游地址推导已知网关的 Completions 实现偏差
 * （z.ai 的 thinkingFormat、chutes 的 max_tokens 等），显式传入的 quirks 覆盖推导值，
 * 与 resolveProviderChatRoute 的合并顺序一致。pi-ai 隔着本地反代看不到真实域名，
 * 不在这里补齐就只有新签名的调用方能拿到这些偏差。
 */
export function createModelFromConfig(
  providerId: ProviderId,
  modelId: string,
  baseUrl: string,
  requestFormat?: CodexRequestFormat,
  modelConfig?: ProviderModelConfig,
  upstreamBaseUrl?: string,
  quirks?: ProviderEndpointQuirks,
): Model<Api> {
  let wire = resolveLegacyWireRoute(providerId, requestFormat);
  if (providerId === "codex" || providerId === "xai") {
    const { preferredApi } = normalizeCodexBaseUrl(baseUrl);
    // 正式 xai 供应商，或 Codex 直连 api.x.ai：固定 Responses（agentic 搜索等）。
    const isXaiTarget =
      providerId === "xai" || isXaiDirectBaseUrl(upstreamBaseUrl?.trim() || baseUrl);
    const protocol: CodexApi = isXaiTarget
      ? "openai-responses"
      : (requestFormat ?? preferredApi ?? "openai-responses");
    wire = resolveRuntimeWireRoute(providerId, {
      protocol,
      dialect: isXaiTarget ? "xai" : "openai",
    });
  }
  const mergedQuirks: ProviderEndpointQuirks = {
    ...inferEndpointQuirksFromBaseUrl(wire.protocol, upstreamBaseUrl?.trim() || baseUrl),
    ...quirks,
  };
  return createModelFromRoute({
    protocol: wire.protocol,
    dialect: wire.dialect,
    modelId,
    wireModelId: modelConfig?.wireModelId,
    baseUrl,
    upstreamBaseUrl,
    modelConfig,
    ...(Object.keys(mergedQuirks).length > 0 ? { quirks: mergedQuirks } : {}),
    // 目录与限额表继续按旧供应商分组查询（codex 直连 api.x.ai 仍按 codex 查）。
    adapterProviderId: providerId,
  });
}
