// 模型连通测试（参照 Cherry Studio 的 Health Check 语义）：按模型当前解析出的路由
// 发一次最小生成请求，只关心"通 / 不通、多快、为什么"，不落盘。这里是纯函数层：
// 拼 URL / 请求体 / 请求头，归类响应，聚合多把 Key 的结果；真正发请求的是
// providerUtils.checkProviderModel（桌面走 Tauri 命令，WebUI 走网关桥）。

import type { ResolvedProviderChatRoute } from "../settings/types";
import { mergeCustomHeaders } from "./customHeaders";
import { PROVIDER_PROTOCOL_AUTH_HEADER, type ProviderChatProtocol } from "./registry/protocols";
import { buildBuiltinRequestHeaders } from "./requestHeaders";

const CHECK_PROMPT = "hi";
const ERROR_SUMMARY_LIMIT = 160;
const OUTPUT_SNIPPET_LIMIT = 80;
const OPENAI_ENDPOINT_SUFFIXES = ["/chat/completions", "/responses", "/response"];
const GEMINI_GENERATE_SUFFIXES = [":streamgeneratecontent", ":generatecontent"];

export type ModelCheckRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: unknown;
};

export type ModelCheckErrorKind =
  | "unauthorized"
  | "notFound"
  | "rateLimited"
  | "http"
  | "invalidResponse"
  | "network"
  | "noKey";

export type ModelCheckSummary = {
  ok: boolean;
  /** 失败归类；界面按它取文案，`error` 是原始细节 */
  kind?: ModelCheckErrorKind;
  error?: string;
  outputSnippet?: string;
};

export type ModelCheckResult = ModelCheckSummary & {
  latencyMs: number;
  status?: number;
  credentialId: string;
  credentialLabel: string;
};

export type ModelCheckState = "ok" | "failed" | "partial" | "checking" | "idle";

export type ModelCheckAggregate = {
  state: ModelCheckState;
  /** 通过的 Key 里最快的一把 */
  latencyMs?: number;
  results: ModelCheckResult[];
};

type RouteForUrl = Pick<
  ResolvedProviderChatRoute,
  "protocol" | "baseUrl" | "isFullUrl" | "wireModelId"
>;

function stripTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function stripSuffixes(value: string, suffixes: readonly string[]): string {
  const lower = value.toLowerCase();
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix)) return value.slice(0, -suffix.length);
  }
  return value;
}

/** 末段是否为 API 版本段（v1 / v1beta / v4 ...）；返回小写版本名。 */
function trailingVersionSegment(path: string): string | undefined {
  return path.match(/\/(v\d+(?:beta|alpha)?)$/i)?.[1]?.toLowerCase();
}

/**
 * 与 buildVersionedModelsUrl / 运行时 maybeAppend*ApiVersion 同一口径：地址已带
 * 版本段（含 /api/paas/v4 这类非 v1 版本）时原样保留；没带时补该接口的缺省版本。
 */
function ensureVersionSegment(root: string, defaultVersion: string): string {
  return trailingVersionSegment(root) ? root : `${root}/${defaultVersion}`;
}

/**
 * 最小生成请求的地址：Completions `{base}/chat/completions`、Responses `{base}/responses`、
 * Messages `{base}/v1/messages`、Gemini `{base}/models/{wireModelId}:generateContent`。
 * isFullUrl 时 baseUrl 就是完整端点，原样使用。
 */
export function buildModelCheckUrl(route: RouteForUrl): string {
  const base = stripTrailingSlashes(route.baseUrl);
  if (!base) return "";
  if (route.isFullUrl) return base;
  switch (route.protocol) {
    case "openai-completions":
      return `${ensureVersionSegment(stripSuffixes(base, OPENAI_ENDPOINT_SUFFIXES), "v1")}/chat/completions`;
    case "openai-responses":
      return `${ensureVersionSegment(stripSuffixes(base, OPENAI_ENDPOINT_SUFFIXES), "v1")}/responses`;
    case "anthropic-messages": {
      const root = stripSuffixes(base, ["/messages"]);
      return `${ensureVersionSegment(root, "v1")}/messages`;
    }
    case "google-generative-ai": {
      let root = stripSuffixes(base, GEMINI_GENERATE_SUFFIXES);
      // 已经指到某个模型（.../models/x:generateContent 去掉动作后剩 .../models/x）：
      // 退回 /models 之前，再按当前模型重拼。
      const modelsIndex = root.toLowerCase().lastIndexOf("/models");
      if (modelsIndex >= 0) {
        const after = root.slice(modelsIndex + "/models".length);
        if (!after || after.startsWith("/")) root = root.slice(0, modelsIndex);
      }
      const model = route.wireModelId.trim().replace(/^models\//, "");
      return `${ensureVersionSegment(root, "v1beta")}/models/${encodeURIComponent(model)}:generateContent`;
    }
  }
}

/** 最小请求体：一句 "hi"，输出上限压到个位数 token，非流式。 */
export function buildModelCheckBody(
  route: Pick<ResolvedProviderChatRoute, "protocol" | "wireModelId" | "quirks">,
): unknown {
  const model = route.wireModelId;
  switch (route.protocol) {
    case "openai-completions": {
      const maxTokensField = route.quirks.maxTokensField ?? "max_tokens";
      return {
        model,
        messages: [{ role: "user", content: CHECK_PROMPT }],
        stream: false,
        [maxTokensField]: 8,
      };
    }
    case "openai-responses":
      return {
        model,
        input: CHECK_PROMPT,
        max_output_tokens: 16,
        ...(route.quirks.supportsStore === false ? {} : { store: false }),
      };
    case "anthropic-messages":
      return {
        model,
        max_tokens: 8,
        messages: [{ role: "user", content: CHECK_PROMPT }],
      };
    case "google-generative-ai":
      return {
        contents: [{ parts: [{ text: CHECK_PROMPT }] }],
        generationConfig: { maxOutputTokens: 8 },
      };
  }
}

/** 该路由实际使用的鉴权头名（端点覆盖优先于协议缺省）。 */
export function modelCheckAuthHeaderName(
  route: Pick<ResolvedProviderChatRoute, "protocol" | "auth">,
): string {
  return route.auth?.headerName?.trim() || PROVIDER_PROTOCOL_AUTH_HEADER[route.protocol].headerName;
}

/**
 * 装配最小生成请求：内置头（协议 < 方言 < 身份）+ 用户头 + Content-Type。
 * apiKey 为空（WebUI 脱敏态）时不带鉴权头，由桌面端按 credentialId 补上。
 */
export function buildModelCheckRequest(
  route: ResolvedProviderChatRoute,
  apiKey: string,
  options?: { sessionId?: string },
): ModelCheckRequest {
  const key = apiKey.trim();
  const builtin = buildBuiltinRequestHeaders({
    protocol: route.protocol,
    dialect: route.dialect,
    apiKey: key,
    auth: route.auth,
    identity: route.identity,
    sessionId: options?.sessionId,
  });
  if (!key) {
    const authName = modelCheckAuthHeaderName(route).toLowerCase();
    for (const name of Object.keys(builtin)) {
      if (name.toLowerCase() === authName) delete builtin[name];
    }
  }
  const headers = mergeCustomHeaders(
    { "Content-Type": "application/json", ...builtin },
    route.headers,
  );
  return {
    url: buildModelCheckUrl(route),
    method: "POST",
    headers,
    body: buildModelCheckBody(route),
  };
}

function truncate(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** 响应体里的错误文案：error.message > error（字符串）> message > 原文。 */
export function extractModelCheckErrorMessage(bodyText: string): string | undefined {
  const raw = bodyText.trim();
  if (!raw) return undefined;
  try {
    const payload = asRecord(JSON.parse(raw));
    const error = payload?.error;
    const nested = asRecord(error);
    const message = firstString(
      nested?.message,
      typeof error === "string" ? error : undefined,
      payload?.message,
      payload?.msg,
    );
    return message ? truncate(message, ERROR_SUMMARY_LIMIT) : truncate(raw, ERROR_SUMMARY_LIMIT);
  } catch {
    return truncate(raw, ERROR_SUMMARY_LIMIT);
  }
}

function extractOutputText(protocol: ProviderChatProtocol, payload: unknown): string | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  switch (protocol) {
    case "openai-completions": {
      const choice = asRecord((root.choices as unknown[] | undefined)?.[0]);
      const message = asRecord(choice?.message);
      return firstString(message?.content, message?.reasoning_content, choice?.text);
    }
    case "openai-responses": {
      if (typeof root.output_text === "string") return root.output_text;
      for (const item of (root.output as unknown[] | undefined) ?? []) {
        for (const part of (asRecord(item)?.content as unknown[] | undefined) ?? []) {
          const text = asRecord(part)?.text;
          if (typeof text === "string" && text.trim()) return text;
        }
      }
      return undefined;
    }
    case "anthropic-messages": {
      for (const block of (root.content as unknown[] | undefined) ?? []) {
        const text = asRecord(block)?.text;
        if (typeof text === "string" && text.trim()) return text;
      }
      return undefined;
    }
    case "google-generative-ai": {
      const candidate = asRecord((root.candidates as unknown[] | undefined)?.[0]);
      for (const part of (asRecord(candidate?.content)?.parts as unknown[] | undefined) ?? []) {
        const text = asRecord(part)?.text;
        if (typeof text === "string" && text.trim()) return text;
      }
      return undefined;
    }
  }
}

/**
 * 响应归类：2xx 且是合法 JSON（能解析出文本更好）算通；401/403 鉴权失败、
 * 404 模型不存在或路径错误、429 限流，其它取响应体里的错误文案。
 */
export function summarizeModelCheckResponse(
  protocol: ProviderChatProtocol,
  status: number,
  bodyText: string,
): ModelCheckSummary {
  if (status === 401 || status === 403) {
    return { ok: false, kind: "unauthorized", error: extractModelCheckErrorMessage(bodyText) };
  }
  if (status === 404) {
    return { ok: false, kind: "notFound", error: extractModelCheckErrorMessage(bodyText) };
  }
  if (status === 429) {
    return { ok: false, kind: "rateLimited", error: extractModelCheckErrorMessage(bodyText) };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      kind: "http",
      error: extractModelCheckErrorMessage(bodyText) ?? `HTTP ${status}`,
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return { ok: false, kind: "invalidResponse", error: truncate(bodyText, ERROR_SUMMARY_LIMIT) };
  }
  const text = extractOutputText(protocol, payload);
  if (text) return { ok: true, outputSnippet: truncate(text, OUTPUT_SNIPPET_LIMIT) };
  // 200 里包着错误对象（部分中转的写法）：按错误处理，不能当"可用"。
  const error = asRecord(payload)?.error;
  if (error && (typeof error === "string" || asRecord(error))) {
    return { ok: false, kind: "http", error: extractModelCheckErrorMessage(bodyText) };
  }
  return { ok: asRecord(payload) !== undefined };
}

/** 多把 Key 的聚合：任一通过即可用；有通过也有失败为 partial。 */
export function aggregateModelCheck(results: readonly ModelCheckResult[]): ModelCheckAggregate {
  if (results.length === 0) return { state: "idle", results: [] };
  const passed = results.filter((result) => result.ok);
  const latencyMs =
    passed.length > 0 ? Math.min(...passed.map((result) => result.latencyMs)) : undefined;
  const state =
    passed.length === 0 ? "failed" : passed.length === results.length ? "ok" : "partial";
  return { state, ...(latencyMs !== undefined ? { latencyMs } : {}), results: [...results] };
}
