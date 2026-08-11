import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

export const LIVEAGENT_CONTEXT_USAGE_FIELD = "liveAgentContextUsage";

export type MessageContextUsage = {
  totalTokens: number;
  fixedTokens: number;
};

type MessageWithContextUsage = Message & {
  [LIVEAGENT_CONTEXT_USAGE_FIELD]?: unknown;
};

function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function readMessageContextUsage(message: Message): MessageContextUsage | undefined {
  const raw = (message as MessageWithContextUsage)[LIVEAGENT_CONTEXT_USAGE_FIELD];
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const totalTokens = positiveTokenCount(record.totalTokens);
  const fixedTokens = positiveTokenCount(record.fixedTokens) ?? 0;
  return totalTokens === undefined ? undefined : { totalTokens, fixedTokens };
}

export function writeAssistantContextUsage(
  message: AssistantMessage,
  usage: MessageContextUsage,
): void {
  (message as MessageWithContextUsage)[LIVEAGENT_CONTEXT_USAGE_FIELD] = {
    totalTokens: Math.max(1, Math.floor(usage.totalTokens)),
    fixedTokens: Math.max(0, Math.floor(usage.fixedTokens)),
  };
}
