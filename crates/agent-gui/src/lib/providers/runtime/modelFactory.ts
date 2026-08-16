import type { Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  type ModelThinkingCapability,
  resolveModelThinking,
  type ThinkingLevelMap,
  toThinkingLevelMap,
} from "@liveagent/ui/lib/models/modelThinking";
import {
  type CodexRequestFormat,
  getProviderModelDefaults,
  type ProviderId,
  type ProviderModelConfig,
} from "../../settings";
import {
  findBuiltinAnthropicModel,
  isAnthropicAdaptiveModelId,
  resolveAnthropicContextWindow,
  resolveAnthropicWireModelId,
} from "../anthropicModels";
import { DEEPSEEK_CHAT_COMPLETIONS_API, normalizeDeepSeekBaseUrl } from "../deepSeekNative";
import { isXaiProviderTarget } from "./xaiResponsesPayload";

// ---------------------------------------------------------------------------
// 思考档位：可用性一律来自 lib/models/modelThinking（生成目录），此处只保留
// 各家 wire 值改写表；toThinkingLevelMap 保证 wire 表不复活目录裁掉的档，
// UI 列表与请求期 clamp（pi-ai getSupportedThinkingLevels）由此同源。
// ---------------------------------------------------------------------------

/** Grok / xAI wire 值：官方 effort 无 minimal，向上取 low。 */
const XAI_THINKING_WIRE_VALUES: ThinkingLevelMap = {
  minimal: "low",
};

function resolveModelThinkingFields(
  capability: ModelThinkingCapability,
  wireValues?: ThinkingLevelMap,
): Pick<Model<any>, "reasoning"> & { thinkingLevelMap?: ThinkingLevelMap } {
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

function resolveKnownModel(
  provider: "openai" | "anthropic" | "google",
  modelId: string,
  baseUrl: string,
): Model<any> | undefined {
  const known = getBuiltinModel(provider as any, modelId as any) as Model<any> | undefined;
  return known?.api ? ({ ...known, baseUrl } as Model<any>) : undefined;
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
  baseUrl: string,
  upstreamBaseUrl?: string,
): Model<any> | undefined {
  const known = findBuiltinAnthropicModel(modelId);
  if (!known?.api) return undefined;
  const endpointBaseUrl = upstreamBaseUrl?.trim() || baseUrl;
  return {
    ...known,
    baseUrl,
    id: resolveAnthropicWireModelId(modelId, endpointBaseUrl),
    name: modelId,
  } as Model<any>;
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

function resolveCodexModelInput(api: CodexApi, modelId: string): Model<any>["input"] {
  if (api === "openai-responses" || supportsOpenAICompletionsImageInputModel(modelId)) {
    return ["text", "image"];
  }
  return ["text"];
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

function resolveCodexOpenAIResponsesCompat(params: {
  baseUrl: string;
  upstreamBaseUrl?: string;
}): Model<"openai-responses">["compat"] | undefined {
  const compatBaseUrl = normalizeCompatBaseUrl(params.upstreamBaseUrl ?? params.baseUrl);
  if (isOfficialOpenAIBaseUrl(compatBaseUrl)) return undefined;

  return {
    supportsDeveloperRole: false,
  };
}

function resolveCodexOpenAICompletionsOverrides(params: {
  baseUrl: string;
  upstreamBaseUrl?: string;
  modelId: string;
}):
  | {
      compat: OpenAICompletionsCompat;
      thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
    }
  | undefined {
  const compatBaseUrl = normalizeCompatBaseUrl(params.upstreamBaseUrl ?? params.baseUrl);
  if (isOfficialOpenAIBaseUrl(compatBaseUrl)) return undefined;

  const normalizedModelId = params.modelId.trim().toLowerCase();
  const isZai = compatBaseUrl.includes("api.z.ai");
  const isXai = compatBaseUrl.includes("api.x.ai");
  const isOpenRouter = compatBaseUrl.includes("openrouter.ai");
  const isGroq = compatBaseUrl.includes("groq.com");
  const isChutes = compatBaseUrl.includes("chutes.ai");
  const isKnownNonOpenAIModel =
    normalizedModelId.includes("qwen") ||
    normalizedModelId.includes("gpt-oss") ||
    normalizedModelId.includes("glm") ||
    normalizedModelId.includes("kimi") ||
    normalizedModelId.includes("minimax");
  const shouldUseCompatibleDefaults =
    isKnownNonOpenAIModel ||
    isZai ||
    isXai ||
    isOpenRouter ||
    isGroq ||
    isChutes ||
    compatBaseUrl.includes("cerebras.ai") ||
    compatBaseUrl.includes("opencode.ai") ||
    !isOfficialOpenAIBaseUrl(compatBaseUrl);

  if (!shouldUseCompatibleDefaults) return undefined;

  const compat: OpenAICompletionsCompat = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsFinishReason: false,
  };

  if (isXai || isZai) {
    compat.supportsReasoningEffort = false;
  }
  if (isChutes) {
    compat.maxTokensField = "max_tokens";
  }
  if (isZai) {
    compat.thinkingFormat = "zai";
  } else if (isOpenRouter) {
    compat.thinkingFormat = "openrouter";
  }
  return {
    compat,
    ...(isGroq && normalizedModelId === "qwen/qwen3-32b"
      ? {
          thinkingLevelMap: {
            minimal: "default",
            low: "default",
            medium: "default",
            high: "default",
            xhigh: "default",
          },
        }
      : {}),
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

function inferCodexApi(requestFormat?: CodexRequestFormat, preferredApi?: CodexApi): CodexApi {
  return requestFormat ?? preferredApi ?? "openai-responses";
}

export function createModelFromConfig(
  providerId: ProviderId,
  modelId: string,
  baseUrl: string,
  requestFormat?: CodexRequestFormat,
  modelConfig?: ProviderModelConfig,
  upstreamBaseUrl?: string,
): Model<any> {
  const defaults = getProviderModelDefaults(providerId, modelId);
  const configuredContextWindow = modelConfig?.contextWindow ?? defaults.contextWindow;
  const contextWindow =
    providerId === "claude_code"
      ? resolveAnthropicContextWindow(
          modelId,
          configuredContextWindow,
          upstreamBaseUrl?.trim() || baseUrl,
        )
      : configuredContextWindow;
  const maxTokens = modelConfig?.maxOutputToken ?? defaults.maxOutputToken;
  // 计费功能已整体移除：pi-ai 的 Model.cost 是结构必填字段，统一喂零价，
  // 流式侧算出的 usage.cost 恒为 0（known 分支同样覆盖，防止目录单价复活计费）。
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // 思考能力（reasoning + 档位）唯一来源：生成目录（未命中走其兜底推断）。
  // pi-ai 目录命中时只取其 thinkingLevelMap 的 wire 改写值，可用性不听它的。
  const thinking = resolveModelThinking(providerId, modelId);

  if (providerId === "deepseek") {
    return {
      id: modelId,
      name: modelId,
      api: DEEPSEEK_CHAT_COMPLETIONS_API,
      provider: "deepseek",
      baseUrl: normalizeDeepSeekBaseUrl(baseUrl),
      ...resolveModelThinkingFields(thinking),
      input: ["text"],
      cost: zeroCost,
      contextWindow,
      maxTokens,
      deepSeekThinkingAlwaysOn: thinking.alwaysOn,
    } as Model<any>;
  }

  if (providerId === "codex" || providerId === "xai") {
    const { baseUrl: normalizedBaseUrl, preferredApi } = normalizeCodexBaseUrl(baseUrl);
    // 正式 xai 供应商，或 Codex 直连 api.x.ai：固定 Responses（agentic 搜索等）。
    const isXaiTarget = isXaiProviderTarget({
      providerId,
      baseUrl: upstreamBaseUrl?.trim() || baseUrl,
    });
    const api = isXaiTarget ? "openai-responses" : inferCodexApi(requestFormat, preferredApi);
    const responsesCompat =
      api === "openai-responses"
        ? resolveCodexOpenAIResponsesCompat({
            baseUrl: normalizedBaseUrl,
            upstreamBaseUrl,
          })
        : undefined;
    const known = resolveKnownModel("openai", modelId, normalizedBaseUrl);
    if (known && known.api === api) {
      return {
        ...known,
        contextWindow,
        maxTokens,
        cost: zeroCost,
        ...resolveModelThinkingFields(
          thinking,
          isXaiTarget ? XAI_THINKING_WIRE_VALUES : known.thinkingLevelMap,
        ),
        ...(responsesCompat
          ? {
              compat: {
                ...(known.compat ?? {}),
                ...responsesCompat,
              },
            }
          : {}),
      };
    }

    const completionsOverrides =
      api === "openai-completions"
        ? resolveCodexOpenAICompletionsOverrides({
            baseUrl: normalizedBaseUrl,
            upstreamBaseUrl,
            modelId,
          })
        : undefined;
    const custom: Model<any> = {
      id: modelId,
      name: modelId,
      api,
      provider: "openai",
      baseUrl: normalizedBaseUrl,
      ...resolveModelThinkingFields(
        thinking,
        isXaiTarget ? XAI_THINKING_WIRE_VALUES : completionsOverrides?.thinkingLevelMap,
      ),
      input: resolveCodexModelInput(api, modelId),
      cost: zeroCost,
      contextWindow,
      maxTokens,
    };
    if (api === "openai-responses" && responsesCompat) {
      custom.compat = responsesCompat;
    } else if (completionsOverrides) {
      custom.compat = completionsOverrides.compat;
    }
    return custom;
  }

  if (providerId === "gemini") {
    const normalizedBaseUrl = maybeAppendGeminiApiVersion(baseUrl);
    const known = resolveKnownModel("google", modelId, normalizedBaseUrl);
    if (known && known.api === "google-generative-ai") {
      return {
        ...known,
        contextWindow,
        maxTokens,
        cost: zeroCost,
        ...resolveModelThinkingFields(thinking, known.thinkingLevelMap),
      };
    }

    const custom: Model<"google-generative-ai"> = {
      id: modelId,
      name: modelId,
      api: "google-generative-ai",
      provider: "google",
      baseUrl: normalizedBaseUrl,
      ...resolveModelThinkingFields(thinking),
      input: ["text", "image"],
      cost: zeroCost,
      contextWindow,
      maxTokens,
    };
    return custom;
  }

  const known = resolveKnownAnthropicModel(modelId, baseUrl, upstreamBaseUrl);
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
    id: resolveAnthropicWireModelId(modelId, upstreamBaseUrl?.trim() || baseUrl),
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    ...resolveModelThinkingFields(thinking),
    input: ["text"],
    cost: zeroCost,
    contextWindow,
    maxTokens,
    ...(customCompat ? { compat: customCompat } : {}),
  };
  return custom;
}
