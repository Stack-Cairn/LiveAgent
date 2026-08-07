import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { AnthropicEffort } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { GoogleOptions } from "@earendil-works/pi-ai/api/google-generative-ai";
import { resolveMaxTokens } from "./common";
import type { StreamOptionsEx } from "./types";

type ReasoningInput = SimpleStreamOptions["reasoning"] | undefined;

// ---------------------------------------------------------------------------
// 为什么这里要重算思维档位，而不是直接用 pi-ai 的 streamSimple()
//
// streamSimple() 会把选项过一遍 api/simple-options.ts 的 buildBaseOptions()，
// 而该函数的返回字段里没有 toolChoice；anthropic-messages 与 google-generative-ai
// 两个 api 的 streamSimple() 自身也从不读 options.toolChoice。也就是说走
// streamSimple() 时 toolChoice 会被静默丢弃——而本仓库真的依赖它：
// agentRunner.ts 按有无工具传 "auto"（无工具的一次性请求同样走它）。
// 因此这两个 api 必须由 streamByApi.ts 直接调用底层 stream() 并显式下发
// toolChoice；一旦绕开 streamSimple()，它内部的思维档位映射也就拿不到了，只能
// 在本文件复算。（openai-completions 的 streamSimple() 确实透传 toolChoice，
// 但它无条件下发，会踩中 streamByApi.ts 里「无 tools 时不发 tool_choice」的
// 400 兼容修补，故一并保持直调。）
//
// pi-ai 未导出 mapThinkingLevelToEffort / getThinkingLevel / getGoogleBudget
// （均为各 api 模块私有），所以下面的映射无法改成调用库函数。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export type { AnthropicEffort };
export type AnthropicThinkingRuntime = {
  thinkingEnabled: boolean;
  maxTokens: number;
  effort?: AnthropicEffort;
  thinkingBudgetTokens?: number;
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

// 与 pi-ai mapThinkingLevelToEffort 同语义，但有意不同：库版的 default 分支把
// xhigh/max 一并压成 "high"，本地则原样透传，以便 Opus 4.6+ 的 xhigh/max 档真的
// 下发到 API。改用库版会静默降级这两档。
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
    return { thinkingEnabled: false, maxTokens };
  }

  if (supportsAdaptiveAnthropicThinking(model)) {
    return {
      thinkingEnabled: true,
      maxTokens,
      effort: mapReasoningToAnthropicEffort(options.reasoning, model),
    };
  }

  // 预算档的 maxTokens/budget 夹取公式与 pi-ai adjustMaxTokensForThinking 一致，
  // 但档位表不同：库版先经 clampReasoning 把 xhigh/max 折成 high(16K)，本地保留
  // max=32K。自定义中转模型没有 compat、必走本分支，改用库版会砍半其思维预算。
  let thinkingBudgetTokens = ANTHROPIC_THINKING_BUDGETS[options.reasoning];
  const adjustedMaxTokens = Math.min(maxTokens + thinkingBudgetTokens, model.maxTokens);
  if (adjustedMaxTokens <= thinkingBudgetTokens) {
    thinkingBudgetTokens = Math.max(0, adjustedMaxTokens - 1_024);
  }

  return {
    thinkingEnabled: true,
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

// 「档位字段 vs 预算字段」的派发方式没有收进 pi-ai 的目录数据，库内部同样靠这三个
// id 正则判定（api/google-generative-ai.ts 的 streamSimple），且未导出，只能在此复算。
// 这与档位可用性（走目录 thinkingLevelMap / clampThinkingLevel）是两回事。
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
