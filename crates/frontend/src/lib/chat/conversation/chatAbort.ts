import type {
  AssistantMessage,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";

import type { ExecutionMode } from "../../settings";
import { isSubagentCardToolCall } from "../../subagents/card";
import {
  getRoundToolTrace,
  hasRoundContent,
  type UiRound,
  type UiRoundContentBlock,
} from "../messages/uiMessages";

type UiRoundMeta = UiRound["meta"];

export type LiveRoundSnapshot = {
  round: number;
  blocks: UiRoundContentBlock[];
  meta?: UiRoundMeta;
};

export type SuppressedToolTraceSnapshot = {
  round: number;
  toolCall: ToolCall;
  toolResult?: ToolResultMessage;
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function cloneValue<T>(value: T): T {
  if (value == null) return value;
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneLiveRoundSnapshots(rounds: LiveRoundSnapshot[]): LiveRoundSnapshot[] {
  return rounds.map((round) => ({
    ...round,
    blocks: cloneValue(round.blocks),
    meta: round.meta ? cloneValue(round.meta) : undefined,
  }));
}

function buildAssistantMessage(params: {
  model: Model<any>;
  blocks?: UiRoundContentBlock[];
  suppressedToolCalls?: ToolCall[];
  stopReason: AssistantMessage["stopReason"];
  timestamp: number;
}): AssistantMessage | null {
  const content: AssistantMessage["content"] = [];
  for (const block of params.blocks ?? []) {
    if (block.kind === "tool" && isSubagentCardToolCall(block.item.toolCall)) continue;

    if (block.kind === "thinking") {
      if (!block.text) continue;
      content.push({
        type: "thinking",
        thinking: block.text,
      });
      continue;
    }
    if (block.kind === "text") {
      if (!block.text) continue;
      content.push({
        type: "text",
        text: block.text,
      });
      continue;
    }
    if (block.kind === "hostedSearch") {
      content.push(block.item as unknown as AssistantMessage["content"][number]);
      continue;
    }
    content.push({
      ...block.item.toolCall,
      arguments: cloneValue(block.item.toolCall.arguments ?? {}),
    });
  }

  for (const toolCall of params.suppressedToolCalls ?? []) {
    content.push({
      ...toolCall,
      arguments: cloneValue(toolCall.arguments ?? {}),
    });
  }

  if (content.length === 0) return null;

  return {
    role: "assistant",
    content,
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: cloneValue(ZERO_USAGE),
    stopReason: params.stopReason,
    errorMessage: params.stopReason === "aborted" ? "Request aborted" : undefined,
    timestamp: params.timestamp,
  };
}

export function isAbortedAssistantMessage(
  message: Message | AssistantMessage | null | undefined,
): message is AssistantMessage {
  return Boolean(message && message.role === "assistant" && message.stopReason === "aborted");
}

export function buildAbortedMessagesFromSnapshot(params: {
  executionMode: ExecutionMode;
  model: Model<any>;
  draftAssistantText: string;
  liveRounds: LiveRoundSnapshot[];
  completedThroughRound?: number;
  suppressedToolTrace?: SuppressedToolTraceSnapshot[];
  timestamp?: number;
}): Message[] {
  const timestamp = params.timestamp ?? Date.now();

  if (params.executionMode === "text" && !params.liveRounds.some(hasRoundContent)) {
    const assistant = buildAssistantMessage({
      model: params.model,
      blocks: [{ kind: "text", id: "text-1", text: params.draftAssistantText }],
      stopReason: "aborted",
      timestamp,
    });
    return assistant ? [assistant] : [];
  }

  const messages: Message[] = [];
  const rounds = params.liveRounds.filter((round) => hasRoundContent(round));
  const completedThroughRound = params.completedThroughRound ?? 0;

  rounds.forEach((round, index) => {
    const isLastRound = index === rounds.length - 1;
    const visibleToolTrace = getRoundToolTrace(round).filter(
      (item) => !isSubagentCardToolCall(item.toolCall),
    );
    const visibleToolCallIds = new Set(visibleToolTrace.map((item) => item.toolCall.id));
    const suppressedToolTrace = (params.suppressedToolTrace ?? []).filter(
      (item) =>
        item.round === round.round &&
        !isSubagentCardToolCall(item.toolCall) &&
        !visibleToolCallIds.has(item.toolCall.id),
    );
    const toolTrace = [...visibleToolTrace, ...suppressedToolTrace];
    const hasToolCalls = toolTrace.length > 0;
    const roundCompleted = round.round <= completedThroughRound;
    const assistant = buildAssistantMessage({
      model: params.model,
      blocks: round.blocks,
      suppressedToolCalls: suppressedToolTrace.map((item) => item.toolCall),
      stopReason: roundCompleted
        ? hasToolCalls
          ? "toolUse"
          : "stop"
        : isLastRound
          ? "aborted"
          : hasToolCalls
            ? "toolUse"
            : "stop",
      timestamp: timestamp + index,
    });

    if (!assistant) return;
    messages.push(assistant);

    for (const item of toolTrace) {
      if (!item.toolResult) continue;
      messages.push({
        ...item.toolResult,
        content: cloneValue(item.toolResult.content),
        details: cloneValue(item.toolResult.details),
      });
    }
  });

  return messages;
}

function extractAssistantText(message: AssistantMessage) {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text.trim();
}

function toPersistableAbortedAssistant(message: AssistantMessage): AssistantMessage | null {
  const text = extractAssistantText(message);
  const hostedSearchBlocks = (message.content as unknown[]).filter(
    (block): block is AssistantMessage["content"][number] =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "hostedSearch",
  );
  if (!text && hostedSearchBlocks.length === 0) {
    return null;
  }
  return {
    ...message,
    content: [...(text ? [{ type: "text" as const, text }] : []), ...hostedSearchBlocks],
    errorMessage: undefined,
  };
}

export function sanitizeAbortedHistoryMessages(messages: Message[]): Message[] {
  const sanitized: Message[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.stopReason === "aborted") {
      const persistable = toPersistableAbortedAssistant(message);
      if (persistable) {
        sanitized.push(persistable);
      }
      while (index + 1 < messages.length && messages[index + 1]?.role === "toolResult") {
        index += 1;
      }
      continue;
    }
    sanitized.push(message);
  }

  return sanitized;
}

export function buildPersistableMessagesFromSnapshot(params: {
  executionMode: ExecutionMode;
  model: Model<any>;
  draftAssistantText: string;
  liveRounds: LiveRoundSnapshot[];
  completedThroughRound?: number;
  suppressedToolTrace?: SuppressedToolTraceSnapshot[];
  timestamp?: number;
}) {
  return sanitizeAbortedHistoryMessages(buildAbortedMessagesFromSnapshot(params));
}
