// 内置请求头装配（设计文档 4.3）：协议头档 < 方言头档 < 端点身份档。
// 界面的"最终请求头"预览与运行时 prepareProviderRequest 共用这一份，所见即所发。

import { createUuid } from "../shared/id";
import {
  ANTHROPIC_DEFAULT_REQUEST_HEADERS,
  buildIdentityRequestHeaders,
  CLAUDE_SESSION_ID_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  CODEX_CONVERSATION_ID_HEADER,
  CODEX_OFFICIAL_SESSION_ID_HEADER,
  CODEX_SESSION_ID_HEADER,
  CODEX_THREAD_ID_HEADER,
  type EndpointIdentity,
  isAnthropicOAuthApiKey,
} from "./customHeaders";
import {
  buildProtocolAuthHeaders,
  type ProviderAuthHeaderSpec,
  type ProviderChatProtocol,
  type ProviderWireDialect,
} from "./registry/protocols";

/**
 * 后一层覆盖前一层，键按大小写不敏感去重，并以后一层的写法与位置为准——
 * 这样协议头档里的 anthropic-version 会落到 SDK 指纹头档中它原本的位置。
 */
export function overlayHeaderLayers(
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

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  const value = sessionId?.trim();
  return value ? value : undefined;
}

/**
 * 方言头档：按 (protocol, dialect) 查表。
 * - anthropic-messages：官方 SDK 指纹头 + 每会话 X-Claude-Code-Session-Id。
 * - openai-responses + openai：Codex CLI 会话身份头（session-id / thread-id /
 *   x-client-request-id，下划线旧名留给既有中转）。
 * - Chat Completions 是无状态协议，任何方言都不附会话头；其余组合只带协议头档。
 */
export function buildDialectRequestHeaders(
  protocol: ProviderChatProtocol,
  dialect: ProviderWireDialect,
  sessionId?: string,
): Record<string, string> | undefined {
  if (protocol === "anthropic-messages") {
    const requestSessionId = normalizeSessionId(sessionId);
    return {
      ...ANTHROPIC_DEFAULT_REQUEST_HEADERS,
      ...(requestSessionId ? { [CLAUDE_SESSION_ID_HEADER]: requestSessionId } : {}),
    };
  }
  if (protocol === "openai-responses" && dialect === "openai") {
    const requestSessionId = normalizeSessionId(sessionId) ?? createUuid();
    return {
      [CODEX_OFFICIAL_SESSION_ID_HEADER]: requestSessionId,
      [CODEX_THREAD_ID_HEADER]: requestSessionId,
      [CLIENT_REQUEST_ID_HEADER]: requestSessionId,
      [CODEX_SESSION_ID_HEADER]: requestSessionId,
      [CODEX_CONVERSATION_ID_HEADER]: requestSessionId,
    };
  }
  return undefined;
}

export type BuiltinRequestHeaderParams = {
  protocol: ProviderChatProtocol;
  dialect: ProviderWireDialect;
  apiKey: string;
  sessionId?: string;
  auth?: Partial<ProviderAuthHeaderSpec>;
  /**
   * 端点身份模拟：某家 CLI = 在方言头档之上叠 UA、静态身份头与该 CLI 的会话头；
   * "none" = 只带协议头档（连方言头也不带）；缺省 = 只有协议头档 + 方言头档。
   */
  identity?: EndpointIdentity;
};

/**
 * 内置头装配：协议头档（鉴权头，可被端点 auth 覆盖）< 方言头档 < 端点身份档。
 * Anthropic OAuth Key 由本地反代自行注入 Bearer，这里保持不带任何头。
 */
export function buildBuiltinRequestHeaders(
  params: BuiltinRequestHeaderParams,
): Record<string, string> {
  if (params.protocol === "anthropic-messages" && isAnthropicOAuthApiKey(params.apiKey)) {
    return {};
  }
  const auth = buildProtocolAuthHeaders(params.protocol, params.apiKey, params.auth);
  if (params.identity === "none") return auth;
  return overlayHeaderLayers(
    auth,
    buildDialectRequestHeaders(params.protocol, params.dialect, params.sessionId),
    params.identity ? buildIdentityRequestHeaders(params.identity, params.sessionId) : undefined,
  );
}
