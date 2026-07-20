export type ContextUsageLevel = "ok" | "warn" | "critical" | "unknown";

export type ContextUsageSnapshot = {
  usedTokens: number;
  contextWindow: number;
  ratio: number | null;
  level: ContextUsageLevel;
  /** Compact display label, e.g. "12.4k" or "—" */
  usedLabel: string;
  /** Percent label when window known, e.g. "6%" */
  percentLabel: string | null;
};

export const CONTEXT_USAGE_WARN_RATIO = 0.7;
export const CONTEXT_USAGE_CRITICAL_RATIO = 0.9;

const CHARS_PER_TOKEN = 4;
const MESSAGE_ENVELOPE_TOKENS = 8;

export function formatTokenCount(tokens: number): string {
  const value = Math.max(0, Math.floor(tokens));
  if (value < 1_000) return String(value);
  if (value < 10_000) {
    const scaled = value / 1_000;
    return `${scaled.toFixed(scaled >= 10 ? 0 : 1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  const millions = value / 1_000_000;
  return `${millions.toFixed(millions >= 10 ? 0 : 1).replace(/\.0$/, "")}M`;
}

export function resolveContextUsageLevel(ratio: number | null): ContextUsageLevel {
  if (ratio == null || !Number.isFinite(ratio)) return "unknown";
  if (ratio >= CONTEXT_USAGE_CRITICAL_RATIO) return "critical";
  if (ratio >= CONTEXT_USAGE_WARN_RATIO) return "warn";
  return "ok";
}

function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.ceil(normalized.length / CHARS_PER_TOKEN);
}

function stringifiedLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value == null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function readFiniteNumber(...candidates: unknown[]): number | null {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
  }
  return null;
}

/** Read observed total-token usage from a message when available. */
export function extractObservedTotalTokens(message: unknown): number | null {
  if (!message || typeof message !== "object") return null;
  const record = message as {
    usage?: unknown;
    usageTotalTokens?: unknown;
  };
  // Prefer already-normalized total when history parsers stash it separately.
  const normalizedTotal = readFiniteNumber(record.usageTotalTokens);
  if (normalizedTotal != null) return normalizedTotal;

  const usage = record.usage;
  if (!usage || typeof usage !== "object") return null;
  const usageRecord = usage as {
    totalTokens?: unknown;
    total_tokens?: unknown;
    input?: unknown;
    output?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  const total = readFiniteNumber(usageRecord.totalTokens, usageRecord.total_tokens);
  if (total != null) return total;
  const input = readFiniteNumber(
    usageRecord.input,
    usageRecord.inputTokens,
    usageRecord.input_tokens,
  );
  const output = readFiniteNumber(
    usageRecord.output,
    usageRecord.outputTokens,
    usageRecord.output_tokens,
  );
  if (input != null && output != null) {
    return input + output;
  }
  if (input != null) return input;
  return null;
}

/** Lightweight token estimate for context meter (independent of compaction ledger). */
export function estimateMessageTokensForUsage(message: unknown): number {
  if (!message || typeof message !== "object") return MESSAGE_ENVELOPE_TOKENS;
  const record = message as { role?: unknown; content?: unknown; details?: unknown };
  let chars = 0;
  const content = record.content;
  if (typeof content === "string") {
    chars = content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        chars += stringifiedLength(block);
        continue;
      }
      const typed = block as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (typed.type === "text" && typeof typed.text === "string") {
        chars += typed.text.length;
        continue;
      }
      if (typed.type === "thinking" && typeof typed.thinking === "string") {
        chars += typed.thinking.length;
        continue;
      }
      if (typed.type === "toolCall") {
        chars +=
          (typeof typed.name === "string" ? typed.name.length : 0) +
          stringifiedLength(typed.arguments);
        continue;
      }
      chars += stringifiedLength(block);
    }
  } else {
    chars = stringifiedLength(content);
  }
  if (record.details != null) chars += stringifiedLength(record.details);
  return Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_ENVELOPE_TOKENS;
}

/**
 * Estimate active context size for the toolbar meter.
 *
 * Prefer the latest observed `usage.totalTokens` as an anchor (includes system
 * prompt, tools, and prior history as reported by the model). Messages after
 * that anchor are estimated and added. When no observation exists, fall back
 * to a pure char-based estimate of messages + system + optional tools.
 */
export function estimateContextUsage(params: {
  messages?: readonly unknown[] | null;
  systemPrompt?: string | null;
  contextWindow?: number | null;
  /** Optional tool schemas (JSON-serializable) counted only when no usage anchor exists. */
  tools?: unknown;
}): ContextUsageSnapshot {
  const messages = Array.isArray(params.messages) ? params.messages : [];

  let anchorIndex = -1;
  let anchorTokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const observed = extractObservedTotalTokens(messages[i]);
    if (observed != null && observed > 0) {
      anchorIndex = i;
      anchorTokens = observed;
      break;
    }
  }

  let usedTokens = 0;
  if (anchorIndex >= 0) {
    // Observed usage already includes system / tools / history up to that turn.
    usedTokens = anchorTokens;
    for (let i = anchorIndex + 1; i < messages.length; i += 1) {
      usedTokens += estimateMessageTokensForUsage(messages[i]);
    }
  } else {
    for (const message of messages) {
      usedTokens += estimateMessageTokensForUsage(message);
    }
    if (typeof params.systemPrompt === "string" && params.systemPrompt.trim()) {
      usedTokens += estimateTextTokens(params.systemPrompt);
    }
    if (params.tools != null) {
      usedTokens += Math.ceil(stringifiedLength(params.tools) / CHARS_PER_TOKEN);
    }
  }

  const contextWindow = Math.max(0, Math.floor(params.contextWindow ?? 0));
  const ratio = contextWindow > 0 ? Math.min(1, Math.max(0, usedTokens / contextWindow)) : null;
  const level = resolveContextUsageLevel(ratio);
  const percentLabel = ratio == null ? null : `${Math.round(ratio * 100)}%`;

  return {
    usedTokens,
    contextWindow,
    ratio,
    level,
    usedLabel: formatTokenCount(usedTokens),
    percentLabel,
  };
}
