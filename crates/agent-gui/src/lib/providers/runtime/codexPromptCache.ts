import type { Api, Model, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import type { CodexRequestFormat, PromptCacheHintMode, ProviderId } from "../../settings";
import { isRecord, normalizeSessionId } from "./common";
import type { StreamOptionsEx } from "./types";

// OpenAI 对 prompt_cache_key 的长度上限（与 pi-ai 的 clamp 规则一致）。
const OPENAI_PROMPT_CACHE_KEY_MAX_CHARS = 64;
const OPENROUTER_SESSION_ID_MAX_CHARS = 256;

function clampPromptCacheKey(value: string): string {
  return value.length > OPENAI_PROMPT_CACHE_KEY_MAX_CHARS
    ? value.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_CHARS)
    : value;
}

function clampOpenRouterSessionId(value: string): string {
  return value.length > OPENROUTER_SESSION_ID_MAX_CHARS
    ? value.slice(0, OPENROUTER_SESSION_ID_MAX_CHARS)
    : value;
}

const OPENAI_PROMPT_CACHE_PAYLOAD_KEYS = [
  "prompt_cache_key",
  "prompt_cache_retention",
  "prompt_cache_options",
] as const;

function parseHostname(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isOfficialOpenAIHostname(hostname: string | undefined): boolean {
  return hostname === "api.openai.com" || Boolean(hostname?.endsWith(".api.openai.com"));
}

export function resolvePromptCacheHintMode(
  configuredMode: PromptCacheHintMode | undefined,
  baseUrl: string,
  modelApi?: CodexRequestFormat,
): Exclude<PromptCacheHintMode, "auto"> {
  if (configuredMode && configuredMode !== "auto") return configuredMode;
  // Responses 链路对齐 Codex CLI：CLI 对所有端点都发会话级 prompt_cache_key，
  // 服务 Codex 流量的中转站必然兼容。严格校验的第三方 Responses 端点若报 400,
  // 逃生通道是供应商级/模型级设 none，而不是把这里翻回保守值（PR#436）。
  if (modelApi === "openai-responses") return "openai-key";
  const hostname = parseHostname(baseUrl);
  if (isOfficialOpenAIHostname(hostname)) {
    return "openai-key";
  }
  if (hostname === "openrouter.ai" || hostname?.endsWith(".openrouter.ai")) {
    return "openrouter-session";
  }
  return "none";
}

function isExplicitNoCacheOptions(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).mode === "explicit"
  );
}

/**
 * `prompt_cache_options: { mode: "explicit" }` 是 GPT-5.6+ 显式关闭隐式前缀缓存
 * 的**唯一**手段（pi-ai 仅在 cacheRetention=none 且模型声明该能力时生成）。剥掉
 * 它等于"用户要求不缓存，wire 上却仍在隐式缓存"，所以 none 模式下要放行。
 *
 * 仅限官方 host：该字段和 prompt_cache_key 一样是 OpenAI 私有扩展，严格校验的
 * 中转端点会直接 400（#307 那一类）。中转站上宁可退回隐式缓存，也不能为了关缓存
 * 把整个请求打死——那是本文件存在的理由。
 */
function supportsExplicitNoCache(baseUrl: string, model: Model<Api> | undefined): boolean {
  if (!model || model.api !== "openai-responses") return false;
  if (!isOfficialOpenAIHostname(parseHostname(baseUrl))) return false;
  const compat = model.compat as OpenAIResponsesCompat | undefined;
  return compat?.supportsExplicitPromptCacheMode === true;
}

function stripOpenAIPromptCacheFields(
  payload: Record<string, unknown>,
  preserveExplicitNoCache: boolean,
) {
  // pi-ai 的 completions buildParams 恒显式写 prompt_cache_key: undefined；
  // 按值判断，undefined 序列化时本就会被丢弃，不值得为它每请求拷贝 payload。
  const keysToStrip = OPENAI_PROMPT_CACHE_PAYLOAD_KEYS.filter((key) => {
    if (payload[key] === undefined) return false;
    return !(
      key === "prompt_cache_options" &&
      preserveExplicitNoCache &&
      isExplicitNoCacheOptions(payload[key])
    );
  });
  if (keysToStrip.length === 0) return payload;
  const nextPayload = { ...payload };
  for (const key of keysToStrip) delete nextPayload[key];
  return nextPayload;
}

function hasHeader(headers: StreamOptionsEx["headers"], name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === expected);
}

export function attachCodexPromptCacheHint(
  providerId: ProviderId,
  baseUrl: string,
  configuredMode: PromptCacheHintMode | undefined,
  model: Model<Api> | undefined,
  options: StreamOptionsEx,
): StreamOptionsEx {
  if (providerId !== "codex") return options;
  const mode =
    options.cacheRetention === "none"
      ? "none"
      : resolvePromptCacheHintMode(configuredMode, baseUrl, model?.api as CodexRequestFormat);
  const sessionId = normalizeSessionId(options.sessionId);
  const effectiveCacheRetention = mode === "none" ? "none" : options.cacheRetention;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    // mode=none 时把 retention 一并压成 none：让 pi-ai 从源头不生成任何缓存
    // 提示（responses 链路会按 retention 注入 prompt_cache_key），而不是依赖
    // 事后剥离已知字段兜底。
    cacheRetention: effectiveCacheRetention,
    headers:
      mode === "openrouter-session" && sessionId && !hasHeader(options.headers, "x-session-id")
        ? { ...options.headers, "x-session-id": clampOpenRouterSessionId(sessionId) }
        : options.headers,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (!isRecord(nextPayload)) return nextPayload;

      if (
        mode === "openai-key" &&
        sessionId &&
        (model.api === "openai-responses" || model.api === "openai-completions") &&
        typeof nextPayload.prompt_cache_key !== "string"
      ) {
        return {
          ...nextPayload,
          prompt_cache_key: clampPromptCacheKey(sessionId),
        };
      }

      return mode === "openai-key"
        ? nextPayload
        : stripOpenAIPromptCacheFields(
            nextPayload,
            effectiveCacheRetention === "none" && supportsExplicitNoCache(baseUrl, model),
          );
    },
  };
}
