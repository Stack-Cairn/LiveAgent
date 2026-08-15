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

export function resolvePromptCacheHintMode(
  configuredMode: PromptCacheHintMode | undefined,
  baseUrl: string,
  modelApi?: CodexRequestFormat,
): Exclude<PromptCacheHintMode, "auto"> {
  if (configuredMode && configuredMode !== "auto") return configuredMode;
  if (modelApi === "openai-responses") return "openai-key";
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

/**
 * 查找请求头里已有的 x-session-id(大小写不敏感)。attach 与 describe 共用这一个
 * 判定:头已存在时 attach 跳过注入 —— 生效的路由键是既有头的值,不是 clamp 后的
 * sessionId。describe 若不走同一判定,就会在这种场景下描述一个不存在的请求。
 * 返回 undefined 表示头不存在;存在但值非字符串(如 null 占位)时返回空串,
 * 与「本应有键但没有值」的空串语义保持一致。
 */
function findExistingSessionHeader(
  headers: StreamOptionsEx["headers"],
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "x-session-id") {
      return typeof value === "string" ? value : "";
    }
  }
  return undefined;
}

/**
 * 把「本轮实际会应用的缓存参数」描述出来,供前缀归因入账。与 anthropicCache 的
 * describeAnthropicCacheShape 同一契约:刻意复用本模块自己的判定函数
 * (resolvePromptCacheHintMode / normalizeSessionId / clamp),诊断侧不另抄条件。
 *
 * codex 的缓存是隐式前缀匹配,没有断点,可变的旋钮只有两个:
 *   - prompt_cache_key(缓存分片路由):sessionId 变 → 换分片 → 全量 miss。
 *     sessionId 缺失时 attachCodexPromptCacheHint 会**静默**不注入 —— 服务端
 *     退回按机器/组织路由,命中率看起来只是变差,不报任何错。把 cacheKey 记进
 *     归因,这种静默降级才第一次变得可见(cacheKey 从有值变空串)。
 *   - cacheRetention:long 由 pi-ai 映射成 prompt_cache_retention: "24h"。
 *
 * headers 为可选:openrouter 路径上请求若已带自定义 x-session-id,
 * attachCodexPromptCacheHint 会跳过注入 —— 生效的路由键是既有头的值。describe
 * 此时必须报既有头的值而不是 clamp(sessionId),否则描述的是一个不存在的请求。
 */
export function describeCodexCacheShape(
  providerId: ProviderId,
  baseUrl: string,
  configuredMode: PromptCacheHintMode | undefined,
  modelApi: CodexRequestFormat | undefined,
  sessionId: string | undefined,
  cacheRetention?: string,
  headers?: StreamOptionsEx["headers"],
): { cacheRetention?: string; ttl?: string; breakpointStrategy?: string; cacheKey?: string } {
  if (providerId !== "codex") {
    return { cacheRetention: cacheRetention ?? "", breakpointStrategy: "none" };
  }
  const mode =
    cacheRetention === "none"
      ? "none"
      : resolvePromptCacheHintMode(configuredMode, baseUrl, modelApi);
  const normalizedSessionId = normalizeSessionId(sessionId);
  // 与 attach 同源:头存在(哪怕值为空)即不注入,以头值为准。
  const existingSessionHeader =
    mode === "openrouter-session" ? findExistingSessionHeader(headers) : undefined;

  return {
    cacheRetention: cacheRetention ?? "",
    breakpointStrategy: mode === "none" ? "none" : `codex-${mode}`,
    cacheKey:
      mode === "openai-key" && normalizedSessionId
        ? clampPromptCacheKey(normalizedSessionId)
        : mode === "openrouter-session"
          ? (existingSessionHeader ??
            (normalizedSessionId ? clampOpenRouterSessionId(normalizedSessionId) : ""))
          : "",
  };
}

export function attachCodexPromptCacheHint(
  providerId: ProviderId,
  baseUrl: string,
  configuredMode: PromptCacheHintMode | undefined,
  modelApi: CodexRequestFormat | undefined,
  options: StreamOptionsEx,
): StreamOptionsEx {
  if (providerId !== "codex") return options;
  const mode =
    options.cacheRetention === "none"
      ? "none"
      : resolvePromptCacheHintMode(configuredMode, baseUrl, modelApi);
  const sessionId = normalizeSessionId(options.sessionId);

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    // mode=none 时把 retention 一并压成 none：让 pi-ai 从源头不生成任何缓存
    // 提示（responses 链路会按 retention 注入 prompt_cache_key），而不是依赖
    // 事后剥离已知字段兜底。
    cacheRetention: mode === "none" ? "none" : options.cacheRetention,
    headers:
      mode === "openrouter-session" &&
      sessionId &&
      findExistingSessionHeader(options.headers) === undefined
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
