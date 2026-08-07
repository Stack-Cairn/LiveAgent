import type { CacheRetention, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CodexRequestFormat, ProviderId, ReasoningLevel } from "../../settings";
import { createUuid } from "../../shared/id";
import {
  ANTHROPIC_DEFAULT_REQUEST_HEADERS,
  CODEX_CONVERSATION_ID_HEADER,
  CODEX_SESSION_ID_HEADER,
  isAnthropicOAuthApiKey,
  mergeCustomHeaders,
} from "../customHeaders";
import { type PreparedProxyRequest, prepareProxyRequest } from "../proxy";
import { normalizeSessionId } from "./common";
import type { ProviderRuntimeConfig } from "./types";

export { isValidCustomHeaderKey } from "../customHeaders";

// 每个供应商只带自家标准的 API Key 请求头，绝不双头齐发。
export function buildAnthropicAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
  };
}

export function buildOpenAIAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

export function buildGeminiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "x-goog-api-key": apiKey,
  };
}

function buildProviderAuthHeaders(providerId: ProviderId, apiKey: string): Record<string, string> {
  if (providerId === "gemini") return buildGeminiAuthHeaders(apiKey);
  if (providerId === "claude_code") return buildAnthropicAuthHeaders(apiKey);
  return buildOpenAIAuthHeaders(apiKey);
}

export { buildProviderAuthHeaders };

/**
 * 多 API Key 故障转移：构造当次尝试凭据的 mutable holder + streamRetry.apiKeyFailover
 * 的 rotate 回调。主 Key（apiKeys[0]）优先；请求失败（429/限额/鉴权等可重试错误）
 * 时 withStreamRetry 调用 rotate(attemptIndex) 切到下一个 Key，streamByApi 的 factory
 * 在下次 factory() 调用重新读取 holder.apiKey/headers，重试落到新 Key 上。
 *
 * attemptAuth.headers 只含鉴权头（authorization/x-api-key/x-goog-api-key），streamByApi
 * 的 resolveAttemptHeaders 会把它替换进 options.headers、保留代理路由/会话/自定义头。
 * 单 Key（或仅 apiKey 旧快照）时不启用故障转移，返回 undefined。
 */
export type ProviderApiKeyFailover = {
  keys: string[];
  rotate: (attemptIndex: number) => void;
};

export type ProviderAttemptAuth = {
  apiKey: string;
  headers: Record<string, string>;
};

export function createProviderApiKeyFailover(params: {
  providerId: ProviderId;
  apiKeys?: string[];
  requestFormat?: CodexRequestFormat;
  sessionId?: string;
}): { attemptAuth: ProviderAttemptAuth | undefined; failover: ProviderApiKeyFailover | undefined } {
  const keys = (Array.isArray(params.apiKeys) ? params.apiKeys : [])
    .map((key) => (typeof key === "string" ? key.trim() : ""))
    .filter(Boolean);
  if (keys.length === 0) {
    // 无候选 Key（旧快照/测试 fixture 仅 apiKey）：不启用故障转移，也不设 attemptAuth，
    // 让 streamByApi 的 factory 回退到 options.apiKey/options.headers，零回归。
    return { attemptAuth: undefined, failover: undefined };
  }
  if (keys.length === 1) {
    // 单 Key：不启用故障转移，attemptAuth 持主 Key 供 factory 一致读取。
    const apiKey = keys[0];
    return {
      attemptAuth: {
        apiKey,
        headers: buildProviderRequestHeaders(params.providerId, apiKey, params.sessionId, params.requestFormat),
      },
      failover: undefined,
    };
  }
  const attemptAuth: ProviderAttemptAuth = {
    apiKey: keys[0],
    headers: buildProviderRequestHeaders(params.providerId, keys[0], params.sessionId, params.requestFormat),
  };
  const failover: ProviderApiKeyFailover = {
    keys,
    rotate: (attemptIndex: number) => {
      // 主 Key=attemptIndex 0；重试逐一切到下一个，越界回主 Key（继续重试同一 Key）。
      const key = keys[attemptIndex] ?? keys[0];
      attemptAuth.apiKey = key;
      attemptAuth.headers = buildProviderRequestHeaders(
        params.providerId,
        key,
        params.sessionId,
        params.requestFormat,
      );
    },
  };
  return { attemptAuth, failover };
}

export function buildProviderRequestHeaders(
  providerId: ProviderId,
  apiKey: string,
  sessionId?: string,
  requestFormat?: CodexRequestFormat,
): Record<string, string> {
  const authHeaders = buildProviderAuthHeaders(providerId, apiKey);
  if (providerId === "claude_code") {
    if (isAnthropicOAuthApiKey(apiKey)) return {};
    return {
      ...authHeaders,
      ...ANTHROPIC_DEFAULT_REQUEST_HEADERS,
    };
  }
  if (providerId === "codex") {
    // 标准 Chat Completions 是无状态协议，只需 Authorization——
    // session_id/conversation_id 是 Responses（Codex CLI）链路专属头，
    // 不得泄漏进 completions 格式的请求。
    if (requestFormat === "openai-completions") return authHeaders;
    const requestSessionId = normalizeSessionId(sessionId) ?? createUuid();
    return {
      ...authHeaders,
      [CODEX_SESSION_ID_HEADER]: requestSessionId,
      [CODEX_CONVERSATION_ID_HEADER]: requestSessionId,
    };
  }
  // 其它 OpenAI 兼容端：仅 Bearer。
  return authHeaders;
}

/**
 * 供应商上游请求的唯一装配入口：内置头 → 合并用户自定义头 → 过本地反代。
 * 聊天 / 文本 / 摘要三条链路都走这里，杜绝各自重复装配时漏掉 customHeaders。
 */
export async function prepareProviderRequest(
  providerId: ProviderId,
  runtime: ProviderRuntimeConfig,
  options?: { sessionId?: string },
): Promise<PreparedProxyRequest> {
  return prepareProxyRequest(
    providerId,
    runtime.baseUrl.trim(),
    mergeCustomHeaders(
      buildProviderRequestHeaders(
        providerId,
        runtime.apiKey,
        options?.sessionId,
        runtime.requestFormat,
      ),
      runtime.customHeaders,
    ),
    { useSystemProxy: runtime.useSystemProxy === true },
  );
}

export function toSimpleStreamReasoning(
  reasoning: ReasoningLevel | undefined,
): SimpleStreamOptions["reasoning"] | undefined {
  return reasoning && reasoning !== "off" ? reasoning : undefined;
}

export function resolveProviderCacheRetention(
  providerId: ProviderId,
  promptCachingEnabled?: boolean,
  requestOverride?: CacheRetention,
  providerPreference?: CacheRetention,
): CacheRetention | undefined {
  // OpenAI 侧的"缓存"体现为稳定的 prompt_cache_key 路由提示；开关关闭时
  // 显式返回 none，阻止 pi-ai 按 sessionId 默认下发。
  if (providerId !== "claude_code" && providerId !== "codex") return undefined;
  if (promptCachingEnabled === false) return "none";
  // 请求级 override 优先（压缩/标题等辅助请求强制 none）。
  if (requestOverride) return requestOverride;
  // 用户可选 long：官方 Anthropic API 上由缓存中间件映射为 1h TTL 断点。
  if (providerId === "claude_code" && providerPreference === "long") return "long";
  return "short";
}

export function buildProviderRequestMetadata(
  providerId: ProviderId,
  sessionId?: string,
): Record<string, unknown> | undefined {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (providerId !== "claude_code" || !normalizedSessionId) return undefined;
  return {
    user_id: normalizedSessionId,
  };
}
