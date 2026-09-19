// ---------------------------------------------------------------------------
// 模型级请求参数覆盖（设计文档 §6.3）——归一化与按接口的白名单
// ---------------------------------------------------------------------------
// 只收录"运行时真的会透传"的字段，依据 pi-ai 0.84.2：
//   - temperature：StreamOptions.temperature，四类接口都读
//     （anthropic-messages 额外要求未开思考且 compat.supportsTemperature）。
//   - maxTokens：StreamOptions.maxTokens，四类接口都读（Responses 落
//     max_output_tokens、Completions 落 max_tokens/max_completion_tokens、
//     Gemini 落 generationConfig.maxOutputTokens、Anthropic 落 max_tokens）。
//   - topP：pi-ai 没有具名字段，只能经 StreamOptions.samplingParams 合并进请求体，
//     而 samplingParams 只被 OpenAI 兼容适配器读取（openai-completions /
//     openai-responses / azure-openai-responses），因此白名单里只给这两类接口。
// 不收录 stopSequences：pi-ai 0.84.2 在这四类接口上没有任何 stop 序列通路。

import type {
  ModelParameterOverrides,
  ProviderChatProtocol,
} from "@liveagent/ui/lib/settings/types";

export type ModelParameterKey = keyof ModelParameterOverrides;

export const MODEL_PARAMETER_KEYS: readonly ModelParameterKey[] = [
  "temperature",
  "maxTokens",
  "topP",
];

/** 各接口实际会透传的参数键。运行时按它过滤，界面按它禁用不适用的输入。 */
export const PROTOCOL_PARAMETER_KEYS: Record<ProviderChatProtocol, readonly ModelParameterKey[]> = {
  "anthropic-messages": ["temperature", "maxTokens"],
  "openai-completions": ["temperature", "maxTokens", "topP"],
  "openai-responses": ["temperature", "maxTokens", "topP"],
  "google-generative-ai": ["temperature", "maxTokens"],
};

/**
 * temperature 的取值范围按各家官方文档：Anthropic Messages 是 0–1，OpenAI 两类
 * 接口与 Gemini generateContent 是 0–2。落库时按最宽的 0–2 校验，请求期再按接口钳制。
 */
export const PROTOCOL_TEMPERATURE_RANGE: Record<
  ProviderChatProtocol,
  { min: number; max: number }
> = {
  "anthropic-messages": { min: 0, max: 1 },
  "openai-completions": { min: 0, max: 2 },
  "openai-responses": { min: 0, max: 2 },
  "google-generative-ai": { min: 0, max: 2 },
};

export const MODEL_TEMPERATURE_STORE_RANGE = { min: 0, max: 2 } as const;
export const MODEL_TOP_P_RANGE = { min: 0, max: 1 } as const;

/**
 * dev 构建探测：Vite 下 import.meta.env.DEV 为真，生产构建静态替换为 false；
 * Node 测试加载器里 import.meta 是空壳，可选链安全落到 false。
 */
function isDevBuild(): boolean {
  try {
    return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

function warnDropped(key: string, reason: string): void {
  if (isDevBuild()) {
    console.warn(`[model-parameters] 丢弃 ${key}：${reason}`);
  }
}

function normalizeFraction(
  value: unknown,
  key: ModelParameterKey,
  range: { min: number; max: number },
): number | undefined {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) {
    warnDropped(key, "不是有限数字");
    return undefined;
  }
  if (numeric < range.min || numeric > range.max) {
    warnDropped(key, `超出 ${range.min}–${range.max}`);
    return undefined;
  }
  // 三位小数足够覆盖所有厂商的精度，同时避免同义配置产生持久化差异。
  return Math.round(numeric * 1000) / 1000;
}

function normalizeMaxTokens(value: unknown, maxOutputToken?: number): number | undefined {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric < 1) {
    warnDropped("maxTokens", "不是正整数");
    return undefined;
  }
  const floored = Math.floor(numeric);
  if (maxOutputToken && floored > maxOutputToken) {
    warnDropped("maxTokens", `大于模型输出上限 ${maxOutputToken}`);
    return undefined;
  }
  return floored;
}

/**
 * 归一化模型级参数覆盖：未知键丢弃（dev 下 console.warn）、逐项范围校验，
 * 全部无效时返回 undefined（等价于"未设置"）。
 * `maxOutputToken` 给出时，`maxTokens` 只能更小或相等——它是本模型的请求上限。
 */
export function normalizeModelParameters(
  input: unknown,
  options?: { maxOutputToken?: number },
): ModelParameterOverrides | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const out: ModelParameterOverrides = {};

  for (const key of Object.keys(source)) {
    if (!(MODEL_PARAMETER_KEYS as readonly string[]).includes(key)) {
      warnDropped(key, "不是适配器 schema 之内的参数");
    }
  }

  if (source.temperature !== undefined) {
    const value = normalizeFraction(
      source.temperature,
      "temperature",
      MODEL_TEMPERATURE_STORE_RANGE,
    );
    if (value !== undefined) out.temperature = value;
  }
  if (source.topP !== undefined) {
    const value = normalizeFraction(source.topP, "topP", MODEL_TOP_P_RANGE);
    if (value !== undefined) out.topP = value;
  }
  if (source.maxTokens !== undefined) {
    const value = normalizeMaxTokens(source.maxTokens, options?.maxOutputToken);
    if (value !== undefined) out.maxTokens = value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 请求期解析：按接口白名单过滤，temperature 按接口范围钳制，maxTokens 与模型
 * 输出上限取小。返回 undefined 表示这次请求不带任何模型级参数。
 */
export function resolveModelParametersForProtocol(
  protocol: ProviderChatProtocol,
  parameters: ModelParameterOverrides | undefined,
  maxOutputToken?: number,
): ModelParameterOverrides | undefined {
  if (!parameters) return undefined;
  const allowed = PROTOCOL_PARAMETER_KEYS[protocol];
  const out: ModelParameterOverrides = {};

  if (parameters.temperature !== undefined && allowed.includes("temperature")) {
    const range = PROTOCOL_TEMPERATURE_RANGE[protocol];
    out.temperature = Math.min(range.max, Math.max(range.min, parameters.temperature));
  }
  if (parameters.topP !== undefined && allowed.includes("topP")) {
    out.topP = Math.min(MODEL_TOP_P_RANGE.max, Math.max(MODEL_TOP_P_RANGE.min, parameters.topP));
  }
  if (parameters.maxTokens !== undefined && allowed.includes("maxTokens")) {
    // 只能更小：模型级参数是本模型的请求上限，不能突破 maxOutputToken。
    out.maxTokens = maxOutputToken
      ? Math.min(maxOutputToken, parameters.maxTokens)
      : parameters.maxTokens;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
