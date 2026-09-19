// 模型家族表（设计文档 3.4）。同一张表服务三处：模型列表分组、默认接口推断、
// 原生搜索资格。新增家族只加一行，不加代码分支。

import type { ProviderChatProtocol, ProviderWireDialect } from "./protocols";

export type ModelFamily = {
  /** 分组键与展示名（小写） */
  key: string;
  /** 模型 ID 匹配模式；网关前缀（vendor/）在匹配前剥掉 */
  pattern: RegExp;
  /** 接口偏好顺序；与供应商已启用渠道求交集后取第一个 */
  prefer: readonly ProviderChatProtocol[];
  /** 家族默认方言。openai 只在官方域名下生效，网关上退回 generic */
  dialect: ProviderWireDialect;
};

export const MODEL_FAMILIES: readonly ModelFamily[] = [
  {
    key: "claude",
    pattern: /^claude/i,
    prefer: ["anthropic-messages", "openai-completions"],
    dialect: "generic",
  },
  {
    key: "gemini",
    pattern: /^(gemini|gemma|palm|learnlm)/i,
    prefer: ["google-generative-ai", "openai-completions"],
    dialect: "generic",
  },
  {
    key: "gpt",
    pattern: /^(gpt|o[134](?:[-.]|$)|codex|chatgpt|text-embedding|davinci)/i,
    prefer: ["openai-responses", "openai-completions"],
    dialect: "openai",
  },
  {
    key: "grok",
    pattern: /^grok/i,
    prefer: ["openai-responses", "openai-completions"],
    dialect: "xai",
  },
  {
    key: "deepseek",
    pattern: /^deepseek/i,
    prefer: ["openai-completions", "openai-responses", "anthropic-messages"],
    dialect: "deepseek",
  },
  {
    key: "glm",
    pattern: /^(glm|chatglm|codegeex)/i,
    prefer: ["openai-completions"],
    dialect: "generic",
  },
  { key: "kimi", pattern: /^(kimi|moonshot)/i, prefer: ["openai-completions"], dialect: "generic" },
  {
    key: "qwen",
    pattern: /^(qwen|qwq|qvq|tongyi)/i,
    prefer: ["openai-completions"],
    dialect: "generic",
  },
  {
    key: "minimax",
    pattern: /^(minimax|abab)/i,
    prefer: ["openai-completions"],
    dialect: "generic",
  },
  {
    key: "doubao",
    pattern: /^(doubao|seed|skylark|ep-)/i,
    prefer: ["openai-completions"],
    dialect: "generic",
  },
  {
    key: "hunyuan",
    pattern: /^(hunyuan|hy-|hy\d)/i,
    prefer: ["openai-completions"],
    dialect: "generic",
  },
  {
    key: "mistral",
    pattern: /^(mistral|mixtral|codestral|ministral|magistral|devstral|pixtral)/i,
    prefer: ["openai-completions"],
    dialect: "generic",
  },
  {
    key: "llama",
    pattern: /^(llama|meta-llama)/i,
    prefer: ["openai-completions"],
    dialect: "generic",
  },
  { key: "step", pattern: /^step-/i, prefer: ["openai-completions"], dialect: "generic" },
  { key: "ling", pattern: /^(ling|ring)-/i, prefer: ["openai-completions"], dialect: "generic" },
  { key: "mimo", pattern: /^mimo/i, prefer: ["openai-completions"], dialect: "generic" },
];

export const UNKNOWN_MODEL_FAMILY: ModelFamily = {
  key: "other",
  pattern: /(?:)/,
  prefer: ["openai-completions"],
  dialect: "generic",
};

/** 去掉网关风格的 vendor 前缀（"anthropic/claude-sonnet-4" → "claude-sonnet-4"）。 */
export function stripModelVendorPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return trimmed;
  const head = trimmed.slice(0, slash);
  // 只剥"像厂商名"的短前缀，避免把带路径语义的 ID 剥坏。
  return /^[a-z0-9_.-]{2,32}$/i.test(head) ? trimmed.slice(slash + 1) : trimmed;
}

export function resolveModelFamily(modelId: string): ModelFamily {
  const id = stripModelVendorPrefix(modelId);
  return MODEL_FAMILIES.find((family) => family.pattern.test(id)) ?? UNKNOWN_MODEL_FAMILY;
}

/** 模型列表分组键（缺省 group）。 */
export function resolveModelGroup(modelId: string): string {
  return resolveModelFamily(modelId).key;
}
