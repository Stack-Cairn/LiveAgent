import type { Context } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";

import type { CodexRequestFormat, ExecutionMode, ProviderId, ReasoningLevel } from "../settings";

type DebugLineType = "request" | "result" | "error";

type RuntimeDebugInput = {
  baseUrl: string;
  apiKey: string;
  requestFormat?: CodexRequestFormat;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
  nativeWebSearchEnabled?: boolean;
  useSystemProxy?: boolean;
};

export type StreamDebugLogger = {
  enabled: boolean;
  logRequest: (payload: unknown) => void;
  logResponse: (payload: unknown) => void;
  logResult: (payload: unknown) => void;
  logError: (payload: unknown) => void;
  flush: () => Promise<void>;
};

const writeQueues = new Map<string, Promise<void>>();
const REDACTED_DEBUG_CREDENTIAL = "[redacted credential]";

const SAFE_TOKEN_METADATA_KEYS = new Set([
  "hasapikey",
  "inputtoken",
  "inputtokens",
  "outputtoken",
  "outputtokens",
  "maxtoken",
  "maxtokens",
  "totaltoken",
  "totaltokens",
  "contexttoken",
  "contexttokens",
  "prompttoken",
  "prompttokens",
  "completiontoken",
  "completiontokens",
]);

function isSensitiveDebugKey(key: string) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (SAFE_TOKEN_METADATA_KEYS.has(normalized)) return false;
  return [
    "apikey",
    "apikeys",
    "authorization",
    "cookie",
    "cookies",
    "credential",
    "credentials",
    "password",
    "passwords",
    "passwd",
    "passphrase",
    "privatekey",
    "secret",
    "secrets",
    "token",
    "tokens",
  ].some((suffix) => normalized.endsWith(suffix));
}

function sanitizeDebugString(value: string) {
  const dataUrlMatch = value.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!dataUrlMatch) return value;

  const mimeType = dataUrlMatch[1] || "application/octet-stream";
  const base64Length = dataUrlMatch[2]?.length ?? 0;
  return `[redacted data URL: ${mimeType}, base64 chars=${base64Length}]`;
}

function sanitizeDebugValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;

  const valueType = typeof value;
  if (typeof value === "string") return sanitizeDebugString(value);
  if (valueType === "number" || valueType === "boolean") return value;
  if (valueType === "bigint") return value.toString();
  if (valueType === "undefined") return "[undefined]";
  if (valueType === "function") return `[Function ${(value as Function).name || "anonymous"}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDebugValue(item, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);

    if (value instanceof Uint8Array) {
      return {
        type: "Uint8Array",
        length: value.byteLength,
      };
    }

    const record = value as Record<string, unknown>;
    const sourceData = record.data;
    const sourceMimeType = record.media_type;
    const inlineDataMimeType = record.mimeType;
    const isBase64Source =
      record.type === "base64" &&
      typeof sourceData === "string" &&
      typeof sourceMimeType === "string";
    const isTextDocumentSource =
      record.type === "text" && sourceMimeType === "text/plain" && typeof sourceData === "string";
    const isInlineDataSource =
      typeof sourceData === "string" &&
      typeof inlineDataMimeType === "string" &&
      inlineDataMimeType.trim().length > 0;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      if (isSensitiveDebugKey(key)) {
        out[key] = REDACTED_DEBUG_CREDENTIAL;
      } else if (
        key.toLowerCase() === "headers" &&
        nested &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        out[key] = Object.fromEntries(
          Object.keys(nested).map((name) => [name, REDACTED_DEBUG_CREDENTIAL]),
        );
      } else if (isBase64Source && key === "data") {
        out[key] = `[redacted base64: ${sourceMimeType}, chars=${sourceData.length}]`;
      } else if (isTextDocumentSource && key === "data") {
        out[key] = `[redacted text document: ${sourceMimeType}, chars=${sourceData.length}]`;
      } else if (isInlineDataSource && key === "data") {
        out[key] = `[redacted inlineData: ${inlineDataMimeType}, chars=${sourceData.length}]`;
      } else {
        out[key] = sanitizeDebugValue(nested, seen);
      }
    }
    seen.delete(value as object);
    return out;
  }

  return String(value);
}

function enqueueDebugLog(conversationId: string, entry: Record<string, unknown>) {
  const previous = writeQueues.get(conversationId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() =>
      invoke<void>("system_append_debug_jsonl", {
        conversation_id: conversationId,
        entry: sanitizeDebugValue(entry),
      }),
    )
    .catch((error) => {
      console.warn("写入 Agent dev 调试日志失败", error);
    });
  writeQueues.set(conversationId, next);
  return next;
}

function flushDebugLog(conversationId: string): Promise<void> {
  return writeQueues.get(conversationId) ?? Promise.resolve();
}

function createNoopDebugLogger(): StreamDebugLogger {
  return {
    enabled: false,
    logRequest() {},
    logResponse() {},
    logResult() {},
    logError() {},
    flush: () => Promise.resolve(),
  };
}

export function buildRuntimeDebugInfo(runtime: RuntimeDebugInput) {
  return {
    baseUrl: runtime.baseUrl,
    requestFormat: runtime.requestFormat,
    reasoning: runtime.reasoning,
    promptCachingEnabled: runtime.promptCachingEnabled,
    nativeWebSearchEnabled: runtime.nativeWebSearchEnabled,
    useSystemProxy: runtime.useSystemProxy,
    hasApiKey: runtime.apiKey.trim().length > 0,
  };
}

export function buildStreamRequestDebugPayload(params: {
  runtime: RuntimeDebugInput;
  context: Context;
  options?: unknown;
  round?: number;
}) {
  return {
    round: params.round,
    runtime: buildRuntimeDebugInfo(params.runtime),
    context: sanitizeDebugValue(params.context),
    options: sanitizeDebugValue(params.options ?? {}),
  };
}

export function createStreamDebugLogger(params: {
  enabled: boolean;
  conversationId: string;
  executionMode: ExecutionMode;
  streamKind: string;
  providerId: ProviderId;
  model: string;
}): StreamDebugLogger {
  if (!params.enabled || !params.conversationId.trim()) {
    return createNoopDebugLogger();
  }

  const baseFields = {
    conversationId: params.conversationId,
    executionMode: params.executionMode,
    streamKind: params.streamKind,
    providerId: params.providerId,
    model: params.model,
  };

  function push(lineType: DebugLineType, payload: unknown) {
    void enqueueDebugLog(params.conversationId, {
      timestamp: new Date().toISOString(),
      type: lineType,
      ...baseFields,
      payload: sanitizeDebugValue(payload),
    });
  }

  return {
    enabled: true,
    logRequest: (payload) => push("request", payload),
    logResponse: () => {},
    logResult: (payload) => push("result", payload),
    logError: (payload) => push("error", payload),
    flush: () => flushDebugLog(params.conversationId),
  };
}

export const __agentDebugTest = {
  sanitizeDebugValue,
};
