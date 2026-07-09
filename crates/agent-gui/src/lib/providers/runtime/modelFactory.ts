import type { Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import {
  type CodexRequestFormat,
  getProviderModelDefaults,
  type ProviderId,
  type ProviderModelConfig,
} from "../../settings";
import {
  applyDeepSeekModelDefaults,
  isDeepSeekCodexTarget,
  resolveDeepSeekOpenAICompletionsOverrides,
} from "../deepSeekProviderAdapter";

const CODEX_RESPONSES_SUFFIX = "/responses";
const CODEX_RESPONSE_SUFFIX = "/response";
const CODEX_CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

type CodexApi = "openai-responses" | "openai-completions";

function resolveKnownModel(
  provider: "openai" | "anthropic" | "google",
  modelId: string,
  baseUrl: string,
): Model<any> | undefined {
  const known = getModel(provider as any, modelId as any) as Model<any> | undefined;
  return known?.api ? ({ ...known, baseUrl } as Model<any>) : undefined;
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

function supportsCodexReasoningModel(modelId: string) {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    normalizedModelId.startsWith("gpt-5") ||
    normalizedModelId.includes("codex") ||
    normalizedModelId.startsWith("o1") ||
    normalizedModelId.startsWith("o3") ||
    normalizedModelId.startsWith("o4")
  );
}

function supportsOpenAICompletionsReasoningModel(modelId: string) {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    supportsCodexReasoningModel(normalizedModelId) ||
    normalizedModelId.includes("deepseek") ||
    normalizedModelId.includes("gpt-oss") ||
    normalizedModelId.includes("qwen") ||
    normalizedModelId.includes("reason") ||
    normalizedModelId.includes("think")
  );
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
  const isDeepSeek =
    compatBaseUrl.includes("deepseek.com") || normalizedModelId.includes("deepseek");
  if (isDeepSeek) {
    return resolveDeepSeekOpenAICompletionsOverrides();
  }
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
  const contextWindow = modelConfig?.contextWindow ?? defaults.contextWindow;
  const maxTokens = modelConfig?.maxOutputToken ?? defaults.maxOutputToken;

  if (providerId === "codex") {
    const { baseUrl: normalizedBaseUrl, preferredApi } = normalizeCodexBaseUrl(baseUrl);
    const isDeepSeekCodex = isDeepSeekCodexTarget({
      providerId,
      baseUrl: normalizedBaseUrl,
      upstreamBaseUrl,
      modelId,
    });
    const api = isDeepSeekCodex ? "openai-completions" : inferCodexApi(requestFormat, preferredApi);
    const known = resolveKnownModel("openai", modelId, normalizedBaseUrl);
    if (known && known.api === api) {
      return applyDeepSeekModelDefaults(
        {
          ...known,
          contextWindow,
          maxTokens,
        },
        {
          providerId,
          baseUrl: normalizedBaseUrl,
          upstreamBaseUrl,
          modelId,
        },
      );
    }

    const custom: Model<any> = {
      id: modelId,
      name: modelId,
      api,
      provider: "openai",
      baseUrl: normalizedBaseUrl,
      reasoning:
        api === "openai-completions"
          ? supportsOpenAICompletionsReasoningModel(modelId)
          : supportsCodexReasoningModel(modelId),
      input: resolveCodexModelInput(api, modelId),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
    if (api === "openai-completions") {
      const overrides = resolveCodexOpenAICompletionsOverrides({
        baseUrl: normalizedBaseUrl,
        upstreamBaseUrl,
        modelId,
      });
      if (overrides) {
        custom.compat = overrides.compat;
        if (overrides.thinkingLevelMap) {
          custom.thinkingLevelMap = overrides.thinkingLevelMap;
        }
      }
    }
    return applyDeepSeekModelDefaults(custom, {
      providerId,
      baseUrl: normalizedBaseUrl,
      upstreamBaseUrl,
      modelId,
    });
  }

  if (providerId === "gemini") {
    const normalizedBaseUrl = maybeAppendGeminiApiVersion(baseUrl);
    const known = resolveKnownModel("google", modelId, normalizedBaseUrl);
    if (known && known.api === "google-generative-ai") {
      return {
        ...known,
        contextWindow,
        maxTokens,
      };
    }

    const custom: Model<"google-generative-ai"> = {
      id: modelId,
      name: modelId,
      api: "google-generative-ai",
      provider: "google",
      baseUrl: normalizedBaseUrl,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
    return custom;
  }

  const known = resolveKnownModel("anthropic", modelId, baseUrl);
  if (known) {
    return applyDeepSeekModelDefaults(
      {
        ...known,
        contextWindow,
        maxTokens,
      },
      {
        providerId,
        baseUrl,
        upstreamBaseUrl,
        modelId,
      },
    );
  }

  const custom: Model<"anthropic-messages"> = {
    id: modelId,
    name: modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  return applyDeepSeekModelDefaults(custom, {
    providerId,
    baseUrl,
    upstreamBaseUrl,
    modelId,
  });
}
