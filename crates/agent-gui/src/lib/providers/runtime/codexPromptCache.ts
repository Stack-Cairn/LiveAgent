import type { PromptCacheHintMode, ProviderId } from "../../settings";
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

export function resolvePromptCacheHintMode(
  configuredMode: PromptCacheHintMode | undefined,
  baseUrl: string,
): Exclude<PromptCacheHintMode, "auto"> {
  if (configuredMode && configuredMode !== "auto") return configuredMode;
  const hostname = parseHostname(baseUrl);
  if (hostname === "api.openai.com" || hostname?.endsWith(".api.openai.com")) {
    return "openai-key";
  }
  if (hostname === "openrouter.ai" || hostname?.endsWith(".openrouter.ai")) {
    return "openrouter-session";
  }
  return "none";
}

function stripOpenAIPromptCacheFields(payload: Record<string, unknown>) {
  // pi-ai 的 completions buildParams 恒显式写 prompt_cache_key: undefined；
  // 按值判断，undefined 序列化时本就会被丢弃，不值得为它每请求拷贝 payload。
  if (!OPENAI_PROMPT_CACHE_PAYLOAD_KEYS.some((key) => payload[key] !== undefined)) return payload;
  const nextPayload = { ...payload };
  for (const key of OPENAI_PROMPT_CACHE_PAYLOAD_KEYS) delete nextPayload[key];
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
  options: StreamOptionsEx,
): StreamOptionsEx {
  if (providerId !== "codex") return options;
  const mode =
    options.cacheRetention === "none"
      ? "none"
      : resolvePromptCacheHintMode(configuredMode, baseUrl);
  const sessionId = normalizeSessionId(options.sessionId);

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    // mode=none 时把 retention 一并压成 none：让 pi-ai 从源头不生成任何缓存
    // 提示（responses 链路会按 retention 注入 prompt_cache_key），而不是依赖
    // 事后剥离已知字段兜底。
    cacheRetention: mode === "none" ? "none" : options.cacheRetention,
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

      return mode === "openai-key" ? nextPayload : stripOpenAIPromptCacheFields(nextPayload);
    },
  };
}
