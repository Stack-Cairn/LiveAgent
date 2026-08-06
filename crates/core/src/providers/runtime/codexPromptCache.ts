import type { ProviderId } from "../../settings";
import { isRecord, normalizeSessionId } from "./common";
import type { StreamOptionsEx } from "./types";

// OpenAI 对 prompt_cache_key 的长度上限（与 pi-ai 的 clamp 规则一致）。
const OPENAI_PROMPT_CACHE_KEY_MAX_CHARS = 64;

function clampPromptCacheKey(value: string): string {
  return value.length > OPENAI_PROMPT_CACHE_KEY_MAX_CHARS
    ? value.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_CHARS)
    : value;
}

/**
 * 为 Codex 请求兜底注入稳定的 prompt_cache_key（按会话 id 路由缓存）。
 * pi-ai 仅在 openai-responses、或 openai-completions 命中官方 host 时下发该
 * 字段；经中转（自定义 base URL）的 completions 请求拿不到稳定 key，长
 * agent 循环的前缀缓存命中率随之丢失。该中间件在 pi-ai 未设置时补齐，
 * 已有值时不覆盖；缓存开关关闭（retention=none）或无会话 id 时不注入。
 */
export function attachCodexPromptCacheKey(
  providerId: ProviderId,
  options: StreamOptionsEx,
): StreamOptionsEx {
  // xai 不使用 OpenAI prompt_cache_key 路由；仅 Codex 需要。
  if (providerId !== "codex") return options;
  if (options.cacheRetention === "none") return options;
  const sessionId = normalizeSessionId(options.sessionId);
  if (!sessionId) return options;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (
        (model.api === "openai-responses" || model.api === "openai-completions") &&
        isRecord(nextPayload) &&
        typeof nextPayload.prompt_cache_key !== "string"
      ) {
        return {
          ...nextPayload,
          prompt_cache_key: clampPromptCacheKey(sessionId),
        };
      }

      return nextPayload;
    },
  };
}
