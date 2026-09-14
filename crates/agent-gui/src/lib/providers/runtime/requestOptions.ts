import type { CacheRetention, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  ANTHROPIC_DEFAULT_REQUEST_HEADERS,
  CLAUDE_SESSION_ID_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  CODEX_CONVERSATION_ID_HEADER,
  CODEX_OFFICIAL_SESSION_ID_HEADER,
  CODEX_SESSION_ID_HEADER,
  CODEX_THREAD_ID_HEADER,
  isAnthropicOAuthApiKey,
  mergeCustomHeaders,
} from "@liveagent/ui/lib/providers/customHeaders";
import { type PreparedProxyRequest, prepareProxyRequest } from "@liveagent/ui/lib/providers/proxy";
import { buildProtocolAuthHeaders } from "@liveagent/ui/lib/providers/registry/protocols";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import type {
  CodexRequestFormat,
  ProviderChatProtocol,
  ProviderEndpointAuth,
  ProviderId,
  ProviderWireDialect,
  ReasoningLevel,
} from "../../settings";
import {
  normalizeDeepSeekResponsesBaseUrl,
  normalizeDeepSeekResponsesEndpoint,
} from "../deepSeekNative";
import { normalizeSessionId } from "./common";
import type { ProviderRuntimeConfig } from "./types";
import { resolveLegacyWireRoute, resolveRuntimeWireRoute } from "./wireRoute";

export { isValidCustomHeaderKey } from "@liveagent/ui/lib/providers/customHeaders";

// 每个供应商只带自家标准的 API Key 请求头，绝不双头齐发。
export function buildAnthropicAuthHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
  };
}

export function buildOpenAIAuthHeaders(apiKey: string): Record<string, string> {
  return buildProtocolAuthHeaders("openai-completions", apiKey);
}

export function buildGeminiAuthHeaders(apiKey: string): Record<string, string> {
  return buildProtocolAuthHeaders("google-generative-ai", apiKey);
}

/**
 * 后一层覆盖前一层，键按大小写不敏感去重，并以后一层的写法与位置为准——
 * 这样协议头档里的 anthropic-version 会落到 SDK 指纹头档中它原本的位置，
 * 最终头集与分层前的字面顺序一致。
 */
function overlayHeaderLayers(
  ...layers: (Record<string, string> | undefined)[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      const lower = key.toLowerCase();
      for (const existing of Object.keys(out)) {
        if (existing.toLowerCase() === lower) delete out[existing];
      }
      out[key] = value;
    }
  }
  return out;
}

/**
 * 方言头档（设计文档 4.3）：按 (protocol, dialect) 查表。
 * - anthropic-messages：官方 SDK 指纹头 + 每会话 X-Claude-Code-Session-Id。
 * - openai-responses + openai：Codex CLI 会话身份头（session-id / thread-id /
 *   x-client-request-id，下划线旧名留给既有中转）。
 * - Chat Completions 是无状态协议，任何方言都不附会话头；其余组合只带协议头档。
 */
function buildDialectRequestHeaders(
  protocol: ProviderChatProtocol,
  dialect: ProviderWireDialect,
  sessionId?: string,
): Record<string, string> | undefined {
  if (protocol === "anthropic-messages") {
    const requestSessionId = normalizeSessionId(sessionId);
    return {
      ...ANTHROPIC_DEFAULT_REQUEST_HEADERS,
      // 官方 CLI 每请求都带 X-Claude-Code-Session-Id（client.ts:108）。
      ...(requestSessionId ? { [CLAUDE_SESSION_ID_HEADER]: requestSessionId } : {}),
    };
  }
  if (protocol === "openai-responses" && dialect === "openai") {
    const requestSessionId = normalizeSessionId(sessionId) ?? createUuid();
    return {
      // 现行 Codex CLI（codex-api responses.rs）：session-id / thread-id /
      // x-client-request-id。下划线旧名留给既有中转与 LiveAgent 存量链路。
      [CODEX_OFFICIAL_SESSION_ID_HEADER]: requestSessionId,
      [CODEX_THREAD_ID_HEADER]: requestSessionId,
      [CLIENT_REQUEST_ID_HEADER]: requestSessionId,
      [CODEX_SESSION_ID_HEADER]: requestSessionId,
      [CODEX_CONVERSATION_ID_HEADER]: requestSessionId,
    };
  }
  return undefined;
}

/**
 * 内置头装配：协议头档（鉴权头，可被端点 auth 覆盖）< 方言头档。
 * Anthropic OAuth Key 由本地反代自行注入 Bearer，这里保持不带任何头。
 */
export function buildProtocolRequestHeaders(params: {
  protocol: ProviderChatProtocol;
  dialect: ProviderWireDialect;
  apiKey: string;
  sessionId?: string;
  auth?: ProviderEndpointAuth;
}): Record<string, string> {
  if (params.protocol === "anthropic-messages" && isAnthropicOAuthApiKey(params.apiKey)) {
    return {};
  }
  return overlayHeaderLayers(
    buildProtocolAuthHeaders(params.protocol, params.apiKey, params.auth),
    buildDialectRequestHeaders(params.protocol, params.dialect, params.sessionId),
  );
}

/** 旧签名：按 ProviderId + requestFormat 推导 (protocol, dialect) 后查表。 */
export function buildProviderRequestHeaders(
  providerId: ProviderId,
  apiKey: string,
  sessionId?: string,
  requestFormat?: CodexRequestFormat,
): Record<string, string> {
  const wire = resolveLegacyWireRoute(providerId, requestFormat);
  return buildProtocolRequestHeaders({
    protocol: wire.protocol,
    dialect: wire.dialect,
    apiKey,
    sessionId,
  });
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
  const wire = resolveRuntimeWireRoute(providerId, runtime);
  const transportProviderId = wire.adapterProviderId;
  // DeepSeek Responses 方言：官方域名去 /v1、中转补 /v1，完整 URL 改写到 /responses。
  const upstreamBaseUrl =
    wire.dialect === "deepseek" && wire.protocol === "openai-responses"
      ? runtime.isFullUrl
        ? normalizeDeepSeekResponsesEndpoint(runtime.baseUrl)
        : normalizeDeepSeekResponsesBaseUrl(runtime.baseUrl)
      : runtime.baseUrl;
  return prepareProxyRequest(
    transportProviderId,
    upstreamBaseUrl.trim(),
    mergeCustomHeaders(
      buildProtocolRequestHeaders({
        protocol: wire.protocol,
        dialect: wire.dialect,
        apiKey: runtime.apiKey,
        sessionId: options?.sessionId,
        auth: runtime.authOverride,
      }),
      runtime.customHeaders,
    ),
    {
      useSystemProxy: runtime.useSystemProxy === true,
      isFullUrl: runtime.isFullUrl === true,
    },
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
  // Codex 的 wire 策略由 promptCacheHintMode 处理；这里保留 short 让供应商级
  // none 仍可被单模型覆盖。请求级 none 则始终优先，供标题/压缩等辅助请求禁用。
  if (providerId !== "claude_code" && providerId !== "codex") return undefined;
  if (providerId === "codex") return requestOverride ?? "short";
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
