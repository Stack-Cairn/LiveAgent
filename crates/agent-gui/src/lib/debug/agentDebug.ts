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

const DEBUG_SANITIZER_VERSION = 3;
const MAX_DEBUG_SANITIZE_DEPTH = 64;
const REDACTED_CREDENTIAL = "[redacted credential]";
const REDACTED_CREDENTIAL_JSON = '{"redacted":"credential-bearing JSON"}';
const REDACTED_NESTED_DEBUG_VALUE = "[redacted deeply nested debug value]";
const SENSITIVE_DEBUG_KEYS = new Set([
  "apikey",
  "authorization",
  "proxyauthorization",
  "xapikey",
  "xgoogapikey",
  "xliveagentproxytoken",
  "cookie",
  "cookies",
  "setcookie",
  "token",
  "apikeys",
  "auth",
  "authentication",
  "authorizationheader",
  "cookieheader",
  "apikeyheader",
  "authtoken",
  "bearertoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "securitytoken",
  "personalaccesstoken",
  "secret",
  "secretkey",
  "secretaccesskey",
  "awssecretaccesskey",
  "accesskeyid",
  "awsaccesskeyid",
  "key",
  "access",
  "refresh",
  "credential",
  "credentials",
  "clientsecret",
  "privatekey",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "subscriptionkey",
  "signingkey",
]);
const NON_SECRET_DEBUG_KEYS = new Set([
  "hasapikey",
  "inputtoken",
  "outputtoken",
  "maxtoken",
  "totaltoken",
  "contexttoken",
  "prompttoken",
  "completiontoken",
]);
const SENSITIVE_DEBUG_KEY_SUFFIXES = [
  "apikey",
  "token",
  "secret",
  "secretkey",
  "secretaccesskey",
  "privatekey",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "cookie",
  "cookies",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "accesskeyid",
  "subscriptionkey",
  "signingkey",
] as const;

function isSensitiveDebugKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_DEBUG_KEYS.has(normalized)) return true;
  if (NON_SECRET_DEBUG_KEYS.has(normalized)) return false;
  return SENSITIVE_DEBUG_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function redactCredentialText(value: string) {
  let redacted = value.replace(
    /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
    "[redacted private key]",
  );

  // The leading boundary and bounded key length keep failed matches linear on
  // large prompt strings with no assignment delimiter.
  const assignment = /(^|[^a-z0-9_.-])(["']?)([a-z][a-z0-9_.-]{0,127})\2\s*[:=]\s*/gi;
  let cursor = 0;
  let output = "";
  for (let match = assignment.exec(redacted); match; match = assignment.exec(redacted)) {
    const name = match[3] ?? "";
    if (!isSensitiveDebugKey(name)) {
      // Let the next scan reuse the delimiter consumed by this non-sensitive
      // assignment so adjacent `label: Authorization: ...` text is detected.
      assignment.lastIndex = match.index + Math.max(match[1]?.length ?? 0, 1);
      continue;
    }

    const valueStart = assignment.lastIndex;
    const valueEnd = findCredentialValueEnd(redacted, valueStart, name);
    const assignmentStart = match.index + (match[1]?.length ?? 0);
    output += redacted.slice(cursor, assignmentStart);
    output += redacted.slice(assignmentStart, valueStart);
    output += credentialReplacementForSource(redacted, valueStart);
    cursor = valueEnd;
    assignment.lastIndex = Math.max(valueEnd, valueStart);
  }
  if (output) redacted = output + redacted.slice(cursor);

  const headerPair = /(["'])([a-z][a-z0-9_.-]{0,127})\1\s*,\s*/gi;
  cursor = 0;
  output = "";
  for (let match = headerPair.exec(redacted); match; match = headerPair.exec(redacted)) {
    const name = match[2] ?? "";
    if (!isSensitiveDebugKey(name)) continue;

    const valueStart = headerPair.lastIndex;
    const valueEnd = findCredentialValueEnd(redacted, valueStart, name);
    output += redacted.slice(cursor, match.index);
    output += redacted.slice(match.index, valueStart);
    output += credentialReplacementForSource(redacted, valueStart);
    cursor = valueEnd;
    headerPair.lastIndex = Math.max(valueEnd, valueStart);
  }
  if (output) redacted = output + redacted.slice(cursor);

  return redacted
    .replace(/(^|[\s:,])(bearer\s+)[^\s,;]+/gi, `$1$2${REDACTED_CREDENTIAL}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED_CREDENTIAL}@`);
}

function jsonStringTokensContainSensitiveKeys(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '"') continue;
    const end = scanQuotedValueEnd(value, index, '"');
    if (end > value.length || value[end - 1] !== '"') return false;
    let next = end;
    while (next < value.length && /\s/.test(value[next] ?? "")) next += 1;
    if (value[next] === ":" || value[next] === ",") {
      try {
        const decoded = JSON.parse(value.slice(index, end));
        if (typeof decoded === "string" && isSensitiveDebugKey(decoded)) return true;
      } catch {
        // Malformed JSON falls back to the plain-text fail-closed scanner.
      }
    }
    index = end - 1;
  }
  return false;
}

function isJsonLikeString(value: string) {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  );
}

function parsedJsonContainsCredentials(root: unknown) {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const { value, depth } = current;
    if (typeof value === "string") {
      if (redactCredentialText(value) !== value) return true;
      if (depth < MAX_DEBUG_SANITIZE_DEPTH && isJsonLikeString(value)) {
        if (jsonStringTokensContainSensitiveKeys(value)) return true;
        try {
          pending.push({ value: JSON.parse(value), depth: depth + 1 });
        } catch {
          // The outer JSON was valid; an inner diagnostic string need not be.
        }
      }
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (depth >= MAX_DEBUG_SANITIZE_DEPTH) return true;
    if (Array.isArray(value)) {
      if (typeof value[0] === "string" && isSensitiveDebugKey(value[0])) return true;
      for (const item of value) pending.push({ value: item, depth: depth + 1 });
      continue;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const hasSensitiveName = entries.some(([key, nested]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      return (
        ["name", "header", "headername", "key"].includes(normalized) &&
        typeof nested === "string" &&
        isSensitiveDebugKey(nested)
      );
    });
    if (hasSensitiveName && entries.length > 1) return true;
    for (const [key, nested] of entries) {
      if (isSensitiveDebugKey(key)) return true;
      pending.push({ value: nested, depth: depth + 1 });
    }
  }
  return false;
}

function scanQuotedValueEnd(value: string, start: number, quote: string) {
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
    } else if (value[index] === quote) {
      return index + 1;
    }
  }
  return value.length;
}

function scanContainerValueEnd(value: string, start: number) {
  const stack: string[] = [value[start] === "{" ? "}" : "]"];
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"' || char === "'") {
      index = scanQuotedValueEnd(value, index, char) - 1;
    } else if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return value.length;
}

function findCredentialValueEnd(value: string, start: number, key: string) {
  const first = value[start];
  if (first === '"' || first === "'") return scanQuotedValueEnd(value, start, first);
  if (first === "{" || first === "[") return scanContainerValueEnd(value, start);

  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const redactToLineEnd = [
    "authorization",
    "proxyauthorization",
    "auth",
    "cookie",
    "setcookie",
    "credential",
    "credentials",
  ].includes(normalizedKey);
  const stopPattern = redactToLineEnd ? /[\r\n]/ : /[\s,;&#}\]]/;
  let index = start;
  while (index < value.length && !stopPattern.test(value[index] ?? "")) index += 1;
  return index;
}

function credentialReplacementForSource(value: string, start: number) {
  const first = value[start];
  if (first === '"' || first === "'") return `${first}${REDACTED_CREDENTIAL}${first}`;
  if (first === "{" || first === "[") return JSON.stringify(REDACTED_CREDENTIAL);
  return REDACTED_CREDENTIAL;
}

function sanitizeDebugString(value: string): string {
  const dataUrlMatch = value.match(/^data:([^;,]+);base64,(.*)$/s);
  if (dataUrlMatch) {
    const mimeType = dataUrlMatch[1] || "application/octet-stream";
    const base64Length = dataUrlMatch[2]?.length ?? 0;
    return `[redacted data URL: ${mimeType}, base64 chars=${base64Length}]`;
  }

  const redacted = redactCredentialText(value);
  const trimmed = value.trim();
  const isJsonLike = isJsonLikeString(trimmed);
  if (isJsonLike && redacted !== value) return REDACTED_CREDENTIAL_JSON;
  if (isJsonLike && jsonStringTokensContainSensitiveKeys(trimmed)) {
    return REDACTED_CREDENTIAL_JSON;
  }
  if (isJsonLike) {
    try {
      if (parsedJsonContainsCredentials(JSON.parse(trimmed))) {
        return REDACTED_CREDENTIAL_JSON;
      }
    } catch {
      // Preserve the existing plain-text behavior for malformed JSON-like strings.
    }
  }
  return redacted;
}

function sanitizeDebugValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value == null) return value;

  const valueType = typeof value;
  if (typeof value === "string") return sanitizeDebugString(value);
  if (valueType === "number" || valueType === "boolean") return value;
  if (valueType === "bigint") return value.toString();
  if (valueType === "undefined") return "[undefined]";
  if (valueType === "function") {
    const name = (value as { name?: unknown }).name;
    return `[Function ${typeof name === "string" ? sanitizeDebugString(name) : "anonymous"}]`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (depth >= MAX_DEBUG_SANITIZE_DEPTH) return REDACTED_NESTED_DEBUG_VALUE;
  if (value instanceof Error) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const sanitizedError: Record<string, unknown> = {
      name: value.name,
      message: sanitizeDebugString(value.message),
      stack: typeof value.stack === "string" ? sanitizeDebugString(value.stack) : value.stack,
    };
    if (value.cause !== undefined) {
      sanitizedError.cause = sanitizeDebugValue(value.cause, seen, depth + 1);
    }
    seen.delete(value);
    return sanitizedError;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const sanitized = value.map((item) => sanitizeDebugValue(item, seen, depth + 1));
    seen.delete(value);
    return sanitized;
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);

    if (value instanceof Uint8Array) {
      const sanitized = {
        type: "Uint8Array",
        length: value.byteLength,
      };
      seen.delete(value);
      return sanitized;
    }

    const record = value as Record<string, unknown>;
    const hasSensitiveName = Object.entries(record).some(([key, nested]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      return (
        ["name", "header", "headername", "key"].includes(normalized) &&
        typeof nested === "string" &&
        isSensitiveDebugKey(nested)
      );
    });
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
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const isNamedCredentialValue =
        hasSensitiveName && !["name", "header", "headername", "key"].includes(normalizedKey);
      if (isSensitiveDebugKey(key) || isNamedCredentialValue) {
        out[key] = REDACTED_CREDENTIAL;
      } else if (isBase64Source && key === "data") {
        out[key] = `[redacted base64: ${sourceMimeType}, chars=${sourceData.length}]`;
      } else if (isTextDocumentSource && key === "data") {
        out[key] = `[redacted text document: ${sourceMimeType}, chars=${sourceData.length}]`;
      } else if (isInlineDataSource && key === "data") {
        out[key] = `[redacted inlineData: ${inlineDataMimeType}, chars=${sourceData.length}]`;
      } else {
        out[key] = sanitizeDebugValue(nested, seen, depth + 1);
      }
    }
    seen.delete(value as object);
    return out;
  }

  return sanitizeDebugString(String(value));
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
      sanitizerVersion: DEBUG_SANITIZER_VERSION,
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
