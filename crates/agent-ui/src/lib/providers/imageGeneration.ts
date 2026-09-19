// 图像生成的请求装配（设计文档 §6.7）。生图不走四类聊天接口——pi-ai 的
// AssistantMessage.content 只有 text / thinking / toolCall，聊天流拿不到图片
// 输出——所以内置 generate_image 工具按本模块拼好请求，交给桌面端
// provider_generate_image / 网关桥发出去。
//
// 两条 API：
//  - openai-images：POST {openai 家族端点 base}/images/generations
//    体 { model, prompt, n, size?, quality?, response_format? }
//    响应 { data: [{ b64_json | url, revised_prompt? }] }
//  - gemini：POST {gemini 端点 base}/models/{model}:generateContent
//    体 { contents:[{parts:[{text}]}], generationConfig:{ responseModalities } }
//    响应 candidates[0].content.parts[] 里的 inlineData { mimeType, data } 与 text
//
// 这里是纯函数层：地址、请求体、请求头与响应归类；真正发请求的是
// imageGenerationTools.ts（桌面走 Tauri 命令，WebUI 走网关桥）。

import { resolveProviderChatRoute } from "../settings";
import {
  type CustomProvider,
  getProviderImplicitChatProtocol,
  isProviderChatProtocolEnabled,
  type ProviderChatProtocol,
  type ProviderEndpointAuth,
  type ResolvedProviderChatRoute,
} from "../settings/types";
import { mergeCustomHeaders } from "./customHeaders";
import type { ModelCheckErrorKind } from "./modelCheck";
import { resolveModelFamily } from "./registry";
import { buildBuiltinRequestHeaders } from "./requestHeaders";

/** 走哪条生图 API。 */
export type ImageGenerationKind = "openai-images" | "gemini";

export type ImageGenerationRoute = {
  kind: ImageGenerationKind;
  /** 已展开 `{origin}`、已按接口补齐版本段的请求根地址。 */
  baseUrl: string;
  /** 最终要 POST 的完整地址。 */
  requestUrl: string;
  headers: Record<string, string>;
  credentialId: string;
  wireModelId: string;
  dialect: ResolvedProviderChatRoute["dialect"];
  /** 借道的聊天接口（鉴权头与地址规则都跟它走），供网关桥补 Key 用。 */
  protocol: ProviderChatProtocol;
  auth?: ProviderEndpointAuth;
};

export type ImageGenerationRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: unknown;
};

export type ImageGenerationParams = {
  prompt: string;
  /** 张数；OpenAI 走 n，Gemini 不支持（只会返回 1 张）。 */
  count?: number;
  /** 如 1024x1024 / 1536x1024 / 1024x1536；Gemini 忽略。 */
  size?: string;
  /** low / medium / high；仅 OpenAI。 */
  quality?: string;
};

export type GeneratedImage = {
  mimeType: string;
  /** 内联图片数据（不带 data: 前缀）。与 remoteUrl 二选一。 */
  base64?: string;
  /** dall-e 等只回 URL 的结果：交给调用方用 provider_download_image 下载。 */
  remoteUrl?: string;
};

export type ImageGenerationResult = {
  ok: boolean;
  images: GeneratedImage[];
  /** Gemini 会在 parts 里夹带说明文本；OpenAI 没有。 */
  texts: string[];
  revisedPrompt?: string;
  /** 失败归类，与模型连通测试同一套口径。 */
  kind?: ModelCheckErrorKind;
  error?: string;
};

const ERROR_SUMMARY_LIMIT = 160;
const OPENAI_ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/responses",
  "/response",
  "/images/generations",
];
const GEMINI_GENERATE_SUFFIXES = [":streamgeneratecontent", ":generatecontent"];
/** OpenAI 家族接口里，谁在就能借它的 base 打 /images/generations。 */
const OPENAI_IMAGE_PROTOCOLS: readonly ProviderChatProtocol[] = [
  "openai-completions",
  "openai-responses",
];
/** 默认张数与上限（OpenAI Images 的 n 上限是 10，这里按工具语义压到 4）。 */
export const IMAGE_GENERATION_MAX_COUNT = 4;

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

/** 与 modelCheck.ensureVersionSegment 同一口径：已带版本段就不再补。 */
function ensureVersionSegment(root: string, defaultVersion: string): string {
  return trailingVersionSegment(root) ? root : `${root}/${defaultVersion}`;
}

/**
 * OpenAI Images 的地址：把端点 base 退回接口根（去掉 /chat/completions、
 * /responses 这类动作段），补版本段，再接 /images/generations。
 * isFullUrl 的端点同样走这条路——完整地址指的是聊天端点，生图要换动作段。
 */
export function buildOpenAIImagesUrl(baseUrl: string): string {
  const base = stripTrailingSlashes(baseUrl);
  if (!base) return "";
  return `${ensureVersionSegment(stripSuffixes(base, OPENAI_ENDPOINT_SUFFIXES), "v1")}/images/generations`;
}

/**
 * Gemini generateContent 的地址：与 buildModelCheckUrl 的 gemini 分支同规则
 * （端点已指到某个模型时退回 /models 之前，再按当前模型重拼）。
 */
export function buildGeminiGenerateContentUrl(baseUrl: string, wireModelId: string): string {
  const base = stripTrailingSlashes(baseUrl);
  if (!base) return "";
  let root = stripSuffixes(base, GEMINI_GENERATE_SUFFIXES);
  const modelsIndex = root.toLowerCase().lastIndexOf("/models");
  if (modelsIndex >= 0) {
    const after = root.slice(modelsIndex + "/models".length);
    if (!after || after.startsWith("/")) root = root.slice(0, modelsIndex);
  }
  const model = wireModelId.trim().replace(/^models\//, "");
  return `${ensureVersionSegment(root, "v1beta")}/models/${encodeURIComponent(model)}:generateContent`;
}

/** Gemini 系列（含 imagen）：这些模型只有 generateContent / predict 能出图。 */
export function prefersGeminiImageApi(modelId: string): boolean {
  const id = modelId.trim();
  return resolveModelFamily(id).key === "gemini" || /imagen/i.test(id);
}

/** 与 resolveProviderChatRoute 同一口径的供应商切片。 */
export type ImageRouteProvider = Parameters<typeof resolveProviderChatRoute>[0] &
  Pick<CustomProvider, "type">;

/**
 * 选出该生图模型要走哪条 API：
 * 1. Gemini 系列模型 + 供应商有已启用的 google-generative-ai 端点 → gemini；
 * 2. 否则供应商有已启用的 OpenAI 家族端点（Completions 或 Responses 任一）
 *    → openai-images，借那条端点的 base 与鉴权；
 * 3. 都没有 → undefined（不可用，由调用方给出指导文案）。
 *
 * 地址、Key、头、`{origin}` 展开与版本段规则全部复用 resolveProviderChatRoute，
 * 保证与聊天链路"所见即所发"一致。
 */
export function resolveImageGenerationRoute(
  provider: ImageRouteProvider,
  modelId: string,
  options?: { apiKey?: string; sessionId?: string; credentialId?: string },
): ImageGenerationRoute | undefined {
  const implicit = getProviderImplicitChatProtocol(provider);
  const geminiEnabled = isProviderChatProtocolEnabled(provider, "google-generative-ai", implicit);

  const protocol: ProviderChatProtocol | undefined =
    prefersGeminiImageApi(modelId) && geminiEnabled
      ? "google-generative-ai"
      : OPENAI_IMAGE_PROTOCOLS.find((candidate) =>
          isProviderChatProtocolEnabled(provider, candidate, implicit),
        );
  if (!protocol) return undefined;

  const route = resolveProviderChatRoute(provider, modelId, {
    protocol,
    ...(options?.credentialId ? { credentialId: options.credentialId } : {}),
  });
  const kind: ImageGenerationKind =
    protocol === "google-generative-ai" ? "gemini" : "openai-images";
  const requestUrl =
    kind === "gemini"
      ? buildGeminiGenerateContentUrl(route.baseUrl, route.wireModelId)
      : buildOpenAIImagesUrl(route.baseUrl);

  return {
    kind,
    baseUrl: route.baseUrl,
    requestUrl,
    headers: buildImageGenerationHeaders(route, options?.apiKey ?? "", options?.sessionId),
    credentialId: route.credentialId,
    wireModelId: route.wireModelId,
    dialect: route.dialect,
    protocol,
    ...(route.auth ? { auth: route.auth } : {}),
  };
}

/**
 * 请求头：内置头（协议 < 方言 < 身份）+ 用户头 + Content-Type，与
 * buildModelCheckRequest 同一装配。apiKey 为空（WebUI 脱敏态）时不带鉴权头，
 * 由桌面端按 credentialId 补上。
 */
function buildImageGenerationHeaders(
  route: ResolvedProviderChatRoute,
  apiKey: string,
  sessionId?: string,
): Record<string, string> {
  const key = apiKey.trim();
  const builtin = buildBuiltinRequestHeaders({
    protocol: route.protocol,
    dialect: route.dialect,
    apiKey: key,
    auth: route.auth,
    identity: route.identity,
    sessionId,
  });
  if (!key) {
    const authName = (
      route.auth?.headerName?.trim() || defaultAuthHeaderName(route.protocol)
    ).toLowerCase();
    for (const name of Object.keys(builtin)) {
      if (name.toLowerCase() === authName) delete builtin[name];
    }
  }
  return mergeCustomHeaders({ "Content-Type": "application/json", ...builtin }, route.headers);
}

function defaultAuthHeaderName(protocol: ProviderChatProtocol): string {
  if (protocol === "anthropic-messages") return "x-api-key";
  if (protocol === "google-generative-ai") return "x-goog-api-key";
  return "Authorization";
}

/**
 * gpt-image-* 系列不接受 response_format（官方会回 400 Unknown parameter），
 * 且恒返回 b64_json；dall-e 与多数中转反过来需要显式要求 b64。
 */
function needsResponseFormat(wireModelId: string): boolean {
  return !/gpt-image/i.test(wireModelId);
}

export function clampImageCount(count: number | undefined): number {
  if (!Number.isFinite(count ?? Number.NaN)) return 1;
  return Math.min(IMAGE_GENERATION_MAX_COUNT, Math.max(1, Math.floor(count as number)));
}

/** 装配最终请求。Gemini 忽略 count / size / quality（接口没有对应字段）。 */
export function buildImageGenerationRequest(
  route: ImageGenerationRoute,
  params: ImageGenerationParams,
): ImageGenerationRequest {
  const prompt = params.prompt;
  const body =
    route.kind === "gemini"
      ? {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }
      : {
          model: route.wireModelId,
          prompt,
          n: clampImageCount(params.count),
          ...(params.size ? { size: params.size } : {}),
          ...(params.quality ? { quality: params.quality } : {}),
          ...(needsResponseFormat(route.wireModelId) ? { response_format: "b64_json" } : {}),
        };
  return { url: route.requestUrl, method: "POST", headers: route.headers, body };
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
export function extractImageGenerationErrorMessage(bodyText: string): string | undefined {
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

function failure(kind: ModelCheckErrorKind, error?: string): ImageGenerationResult {
  return { ok: false, images: [], texts: [], kind, ...(error ? { error } : {}) };
}

function parseOpenAIImages(payload: unknown): ImageGenerationResult {
  const root = asRecord(payload);
  const data = root?.data;
  if (!Array.isArray(data)) {
    return failure("invalidResponse", "响应缺少 data 数组");
  }
  const images: GeneratedImage[] = [];
  let revisedPrompt: string | undefined;
  for (const item of data) {
    const entry = asRecord(item);
    if (!entry) continue;
    revisedPrompt ??= firstString(entry.revised_prompt);
    const b64 = firstString(entry.b64_json);
    if (b64) {
      images.push({ mimeType: "image/png", base64: b64 });
      continue;
    }
    const url = firstString(entry.url);
    if (url) images.push({ mimeType: "image/png", remoteUrl: url });
  }
  if (images.length === 0) return failure("invalidResponse", "响应里没有图片数据");
  return { ok: true, images, texts: [], ...(revisedPrompt ? { revisedPrompt } : {}) };
}

function parseGeminiImages(payload: unknown): ImageGenerationResult {
  const root = asRecord(payload);
  const candidate = asRecord((root?.candidates as unknown[] | undefined)?.[0]);
  const parts = asRecord(candidate?.content)?.parts as unknown[] | undefined;
  if (!Array.isArray(parts)) {
    return failure("invalidResponse", "响应缺少 candidates[0].content.parts");
  }
  const images: GeneratedImage[] = [];
  const texts: string[] = [];
  for (const part of parts) {
    const entry = asRecord(part);
    if (!entry) continue;
    // 官方 REST 是 inlineData；部分中转按 proto 命名回 inline_data。
    const inline = asRecord(entry.inlineData) ?? asRecord(entry.inline_data);
    const base64 = firstString(inline?.data);
    if (base64) {
      images.push({
        mimeType: firstString(inline?.mimeType, inline?.mime_type) ?? "image/png",
        base64,
      });
      continue;
    }
    const text = firstString(entry.text);
    if (text) texts.push(text);
  }
  if (images.length === 0) {
    return failure("invalidResponse", texts.join("\n") || "响应里没有图片数据");
  }
  return { ok: true, images, texts };
}

/**
 * 响应归类：401/403 鉴权失败、404 模型不存在或路径错误、429 限流，其它非 2xx
 * 取响应体里的错误文案；2xx 再按接口形状抽图片（抽不到算 invalidResponse，
 * 包括 200 里包着错误对象的中转写法）。
 */
export function parseImageGenerationResponse(
  kind: ImageGenerationKind,
  status: number,
  bodyText: string,
): ImageGenerationResult {
  if (status === 401 || status === 403) {
    return failure("unauthorized", extractImageGenerationErrorMessage(bodyText));
  }
  if (status === 404) {
    return failure("notFound", extractImageGenerationErrorMessage(bodyText));
  }
  if (status === 429) {
    return failure("rateLimited", extractImageGenerationErrorMessage(bodyText));
  }
  if (status < 200 || status >= 300) {
    return failure("http", extractImageGenerationErrorMessage(bodyText) ?? `HTTP ${status}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return failure("invalidResponse", truncate(bodyText, ERROR_SUMMARY_LIMIT));
  }
  const error = asRecord(payload)?.error;
  if (error && (typeof error === "string" || asRecord(error))) {
    return failure("http", extractImageGenerationErrorMessage(bodyText));
  }
  return kind === "gemini" ? parseGeminiImages(payload) : parseOpenAIImages(payload);
}
