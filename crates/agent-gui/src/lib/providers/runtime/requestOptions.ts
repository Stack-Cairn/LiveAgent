import type { CacheRetention, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type {
  CodexRequestFormat,
  CustomProvider,
  ProviderId,
  ReasoningLevel,
} from "../../settings";
import { createUuid } from "../../shared/id";
import {
  ANTHROPIC_DEFAULT_REQUEST_HEADERS,
  CODEX_CONVERSATION_ID_HEADER,
  CODEX_DEFAULT_USER_AGENT,
  CODEX_SESSION_ID_HEADER,
  isAnthropicOAuthApiKey,
  mergeCustomHeaders as mergeCustomHeadersBase,
} from "../customHeaders";
import { normalizeSessionId } from "./common";

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
    // codex_cli_rs UA 与 session_id/conversation_id 是 Responses（Codex CLI）
    // 链路专属身份头，不得泄漏进 completions 格式的请求。
    if (requestFormat === "openai-completions") return authHeaders;
    const requestSessionId = normalizeSessionId(sessionId) ?? createUuid();
    return {
      ...authHeaders,
      "User-Agent": CODEX_DEFAULT_USER_AGENT,
      [CODEX_SESSION_ID_HEADER]: requestSessionId,
      [CODEX_CONVERSATION_ID_HEADER]: requestSessionId,
    };
  }
  return authHeaders;
}

export function mergeCustomHeaders(
  base: Record<string, string>,
  customHeaders?: CustomProvider["customHeaders"],
): Record<string, string> {
  return mergeCustomHeadersBase(base, customHeaders);
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
