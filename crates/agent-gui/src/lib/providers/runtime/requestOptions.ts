import type { CacheRetention, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  type EndpointIdentity,
  mergeCustomHeaders,
} from "@liveagent/ui/lib/providers/customHeaders";
import { type PreparedProxyRequest, prepareProxyRequest } from "@liveagent/ui/lib/providers/proxy";
import { buildProtocolAuthHeaders } from "@liveagent/ui/lib/providers/registry/protocols";
import { buildBuiltinRequestHeaders } from "@liveagent/ui/lib/providers/requestHeaders";
import type {
  CapabilityState,
  CodexRequestFormat,
  ModelParameterOverrides,
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
 * 内置头装配：协议头档 < 方言头档 < 端点身份档（共享层 requestHeaders.ts，与设置页
 * 的"最终请求头"预览同一份实现）。
 */
export function buildProtocolRequestHeaders(params: {
  protocol: ProviderChatProtocol;
  dialect: ProviderWireDialect;
  apiKey: string;
  sessionId?: string;
  auth?: ProviderEndpointAuth;
  identity?: EndpointIdentity;
}): Record<string, string> {
  return buildBuiltinRequestHeaders(params);
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
        identity: runtime.identity,
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
  // --- 设计 §6.1：模型有效能力参与判定 ---
  /**
   * 该模型 promptCaching 的有效状态（resolveModelCapabilities 的结果）。
   * unsupported（用户显式标记，或将来目录/适配器判定不支持）直接返回 "none"，
   * 不给上游下缓存断点；unknown / supported 沿用原有供应商级规则。
   */
  modelCapability?: CapabilityState,
  // --- §6.1 结束 ---
): CacheRetention | undefined {
  // Codex 的 wire 策略由 promptCacheHintMode 处理；这里保留 short 让供应商级
  // none 仍可被单模型覆盖。请求级 none 则始终优先，供标题/压缩等辅助请求禁用。
  if (providerId !== "claude_code" && providerId !== "codex") return undefined;
  // 模型有效能力优先于供应商级偏好：标记不支持就不再下缓存断点。
  if (modelCapability === "unsupported") return "none";
  if (providerId === "codex") return requestOverride ?? "short";
  if (promptCachingEnabled === false) return "none";
  // 请求级 override 优先（压缩/标题等辅助请求强制 none）。
  if (requestOverride) return requestOverride;
  // 用户可选 long：官方 Anthropic API 上由缓存中间件映射为 1h TTL 断点。
  if (providerId === "claude_code" && providerPreference === "long") return "long";
  return "short";
}

// ---------------------------------------------------------------------------
// 设计 §6.3：把模型级参数覆盖落到 pi-ai 的 stream options
// ---------------------------------------------------------------------------
// runtime.parameters 已由 createProviderRuntimeConfig 按接口过滤并钳制过，这里
// 只负责映射：temperature / maxTokens 是 StreamOptions 的具名字段；topP 只能经
// samplingParams 落到 OpenAI 兼容请求体的 top_p（其它适配器会忽略 samplingParams，
// 所以白名单已在 PROTOCOL_PARAMETER_KEYS 里挡掉）。
// maxTokens 与既有 maxOutputToken 的关系：参数覆盖只能更小，作为本模型的请求上限。

export function applyModelParameterOverrides<T extends SimpleStreamOptions>(
  options: T,
  parameters: ModelParameterOverrides | undefined,
  maxOutputToken?: number,
): T {
  if (!parameters) return options;
  const next = { ...options };
  if (parameters.temperature !== undefined && next.temperature === undefined) {
    next.temperature = parameters.temperature;
  }
  if (parameters.maxTokens !== undefined) {
    const ceiling = maxOutputToken ?? next.maxTokens;
    next.maxTokens = ceiling ? Math.min(ceiling, parameters.maxTokens) : parameters.maxTokens;
  }
  if (parameters.topP !== undefined) {
    next.samplingParams = { ...next.samplingParams, top_p: parameters.topP };
  }
  return next;
}
// --- §6.3 结束 ---

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
