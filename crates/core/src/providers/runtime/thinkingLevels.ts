import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { AnthropicEffort } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { GoogleOptions } from "@earendil-works/pi-ai/api/google-generative-ai";
import { resolveMaxTokens } from "./common";
import type { StreamOptionsEx } from "./types";

type ReasoningInput = SimpleStreamOptions["reasoning"] | undefined;

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export type { AnthropicEffort };
export type AnthropicThinkingMode = "disabled" | "adaptive" | "budget";
export type AnthropicThinkingRuntime = {
  thinkingEnabled: boolean;
  mode: AnthropicThinkingMode;
  maxTokens: number;
  effort?: AnthropicEffort;
  thinkingBudgetTokens?: number;
  display?: "summarized";
};

function anthropicCompat(model: Model<any>) {
  return (model as Model<"anthropic-messages">).compat;
}

// 与 pi-ai streamAnthropic 内部判定同源：目录 compat.forceAdaptiveThinking 决定
// adaptive 还是 budget 档；自定义模型没有 compat，一律按 budget 处理。
export function supportsAdaptiveAnthropicThinking(model: Model<any>): boolean {
  return anthropicCompat(model)?.forceAdaptiveThinking ?? false;
}

const ANTHROPIC_THINKING_BUDGETS: Record<NonNullable<ReasoningInput>, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 16_384,
  max: 32_768,
};

export function mapReasoningToAnthropicEffort(
  reasoning: ReasoningInput,
  model: Model<any>,
): AnthropicEffort {
  // 目录 thinkingLevelMap 显式声明的档位优先（如 opus-4-6 的 xhigh→max），
  // 与 pi-ai mapThinkingLevelToEffort 同语义；未声明则按标准档位直通。
  const mapped = reasoning ? model.thinkingLevelMap?.[reasoning] : undefined;
  if (typeof mapped === "string") return mapped as AnthropicEffort;

  switch (reasoning) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return "high";
  }
}

export function resolveAnthropicThinkingRuntime(
  model: Model<any>,
  options: StreamOptionsEx,
): AnthropicThinkingRuntime {
  const maxTokens = resolveMaxTokens(options.maxTokens, model.maxTokens);
  if (!options.reasoning) {
    return { thinkingEnabled: false, mode: "disabled", maxTokens };
  }

  if (supportsAdaptiveAnthropicThinking(model)) {
    return {
      thinkingEnabled: true,
      mode: "adaptive",
      maxTokens,
      effort: mapReasoningToAnthropicEffort(options.reasoning, model),
      display: "summarized",
    };
  }

  let thinkingBudgetTokens = ANTHROPIC_THINKING_BUDGETS[options.reasoning];
  const adjustedMaxTokens = Math.min(maxTokens + thinkingBudgetTokens, model.maxTokens);
  if (adjustedMaxTokens <= thinkingBudgetTokens) {
    thinkingBudgetTokens = Math.max(0, adjustedMaxTokens - 1_024);
  }

  return {
    thinkingEnabled: true,
    mode: "budget",
    maxTokens: adjustedMaxTokens,
    thinkingBudgetTokens,
  };
}

// ---------------------------------------------------------------------------
// OpenAI（codex 供应商的两种请求格式共用）
// ---------------------------------------------------------------------------

// 与 pi-ai streamSimple(OpenAI) 同源：按目录 thinkingLevelMap 裁剪到该模型支持的最近
// 档位；未声明覆盖时，pi-ai 底层 stream() 会把裁剪后的档位字符串原样透传给
// reasoning_effort，此处无需再做一次模型族 id 判定。
export function clampOpenAIReasoningEffort(
  model: Model<any>,
  reasoning: ReasoningInput,
): ReasoningInput {
  if (!reasoning) return undefined;
  const clamped = clampThinkingLevel(model, reasoning);
  return clamped === "off" ? undefined : clamped;
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

export type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
type GeminiEffort = "minimal" | "low" | "medium" | "high";

// pi-ai 未把「档位字段 vs 预算字段」这个派发方式收进目录数据，其自身 streamSimple(Gemini)
// 内部也是靠这三个 id 正则判定——此处逐字镜像，与档位可用性（走目录 thinkingLevelMap /
// clampThinkingLevel）是两回事，不可替代。
function isGemini3ProModel(modelId: string) {
  return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string) {
  const id = modelId.toLowerCase();
  return (
    /gemini-3(?:\.\d+)?-flash/.test(id) ||
    id === "gemini-flash-latest" ||
    id === "gemini-flash-lite-latest"
  );
}

function isGemma4Model(modelId: string) {
  return /gemma-?4/.test(modelId.toLowerCase());
}

function usesGeminiThinkingLevelField(modelId: string) {
  return isGemini3ProModel(modelId) || isGemini3FlashModel(modelId) || isGemma4Model(modelId);
}

// 与 pi-ai getThinkingLevel 同源：Gemini 3 Pro 只有 LOW/HIGH 两档，Gemma 4 只有
// MINIMAL/HIGH 两档，其余（含 Gemini 3 Flash）为完整四档。
function mapGeminiThinkingLevel(modelId: string, effort: GeminiEffort): GeminiThinkingLevel {
  if (isGemini3ProModel(modelId)) {
    return effort === "minimal" || effort === "low" ? "LOW" : "HIGH";
  }
  if (isGemma4Model(modelId)) {
    return effort === "minimal" || effort === "low" ? "MINIMAL" : "HIGH";
  }
  switch (effort) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    default:
      return "HIGH";
  }
}

// 与 pi-ai getGoogleBudget 同源；未匹配到已知系列时返回 -1，交由上游 API 使用模型默认值。
function mapGeminiThinkingBudget(modelId: string, effort: GeminiEffort) {
  const id = modelId.toLowerCase();
  if (id.includes("2.5-pro")) {
    return { minimal: 128, low: 2_048, medium: 8_192, high: 32_768 }[effort];
  }
  if (id.includes("2.5-flash-lite")) {
    return { minimal: 512, low: 2_048, medium: 8_192, high: 24_576 }[effort];
  }
  if (id.includes("2.5-flash")) {
    return { minimal: 128, low: 2_048, medium: 8_192, high: 24_576 }[effort];
  }
  return -1;
}

export function resolveGeminiThinkingRuntime(
  model: Model<any>,
  reasoning: ReasoningInput,
): GoogleOptions["thinking"] {
  if (!reasoning) return { enabled: false };

  // 档位可用性交给目录 thinkingLevelMap（clampThinkingLevel）决定，例如 gemini-3-pro-preview
  // 会被裁剪到只剩 low/high；xhigh/max 目前没有任何 Gemini 目录条目声明支持，一律降到 high。
  const clamped = clampThinkingLevel(model, reasoning);
  const effort: GeminiEffort =
    clamped === "minimal" || clamped === "low" || clamped === "medium" ? clamped : "high";

  if (usesGeminiThinkingLevelField(model.id)) {
    return { enabled: true, level: mapGeminiThinkingLevel(model.id, effort) };
  }
  return { enabled: true, budgetTokens: mapGeminiThinkingBudget(model.id, effort) };
}
