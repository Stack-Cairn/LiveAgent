import type { Message, ToolCall, ToolResultMessage, Usage } from "@earendil-works/pi-ai";

import type { LiveTranscriptState } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { HostedSearchBlock } from "../../../lib/chat/messages/hostedSearch";
import {
  safeStringify,
  summarizeToolCall,
  toolResultMessageToText,
  type UiRound,
} from "../../../lib/chat/messages/uiMessages";
import {
  getUserMessageAttachments,
  getUserMessageDisplayText,
  type PendingUploadedFile,
} from "../../../lib/chat/messages/uploadedFiles";
import { buildGatewayToolCallPreviewArguments } from "../turns/gatewayToolPreview";

export type GatewayRuntimeSnapshotState = "running" | "completed" | "failed" | "cancelled";

type GatewayAssistantMeta = {
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  usage?: Usage;
  usageTotalTokens?: number;
};

export type GatewayRuntimeSnapshotEntry =
  | {
      id: string;
      kind: "user";
      text: string;
      attachments: PendingUploadedFile[];
      messageId: string;
    }
  | { id: string; kind: "assistant"; text: string; round?: number; meta?: GatewayAssistantMeta }
  | { id: string; kind: "thinking"; text: string; round?: number }
  | {
      id: string;
      kind: "tool_call";
      round?: number;
      toolCall: ToolCall;
      summary?: string;
      text: string;
    }
  | {
      id: string;
      kind: "tool_result";
      round?: number;
      toolResult: ToolResultMessage;
      summary?: string;
      text: string;
    }
  | {
      id: string;
      kind: "hosted_search";
      round?: number;
      hostedSearch: HostedSearchBlock;
    }
  | { id: string; kind: "error"; text: string };

export type GatewayRuntimeSnapshotInput = {
  userMessage?: Message | null;
  liveTranscript: LiveTranscriptState;
};

function readMessageId(message: Message | undefined, fallback: string) {
  if (!message) return fallback;
  const rawId = (message as Message & { id?: unknown }).id;
  if (typeof rawId === "string" && rawId.trim()) {
    return rawId.trim();
  }
  return fallback;
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeToolCall(toolCall: ToolCall | undefined, fallbackId: string): ToolCall {
  const source = toolCall as
    | (ToolCall & { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown })
    | undefined;
  const id = typeof source?.id === "string" && source.id.trim() ? source.id.trim() : fallbackId;
  const name = typeof source?.name === "string" && source.name.trim() ? source.name.trim() : "Tool";
  return {
    ...(toolCall ?? {}),
    type: "toolCall",
    id,
    name,
    arguments: normalizeToolArguments(source?.arguments),
  } as ToolCall;
}

function normalizeToolResult(
  toolResult: ToolResultMessage | undefined,
  toolCall: ToolCall,
): ToolResultMessage {
  const source = toolResult as
    | (ToolResultMessage & {
        role?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
        content?: unknown;
      })
    | undefined;
  return {
    ...(toolResult ?? {}),
    role: "toolResult",
    toolCallId:
      typeof source?.toolCallId === "string" && source.toolCallId.trim()
        ? source.toolCallId.trim()
        : toolCall.id,
    toolName:
      typeof source?.toolName === "string" && source.toolName.trim()
        ? source.toolName.trim()
        : toolCall.name,
    content: Array.isArray(source?.content) ? source.content : [],
  } as ToolResultMessage;
}

function buildToolCallEntry(
  prefix: string,
  round: number | undefined,
  index: number,
  toolCall: ToolCall | undefined,
): GatewayRuntimeSnapshotEntry {
  const normalized = normalizeToolCall(toolCall, `${prefix}-tool-${round ?? 0}-${index}`);
  // Snapshot entries must carry the same preview shape (truncated text +
  // meta + monotonic progress) as bridge deltas, so remote consumers can
  // order the two writers and never regress a streaming preview.
  const streamed = {
    ...normalized,
    arguments: buildGatewayToolCallPreviewArguments(normalized),
  } as ToolCall;
  return {
    id: `${prefix}-tool-call-${round ?? 0}-${streamed.id}-${index}`,
    kind: "tool_call",
    round,
    toolCall: streamed,
    summary: summarizeToolCall(streamed),
    text: safeStringify(streamed.arguments),
  };
}

function buildToolResultEntry(
  prefix: string,
  round: number | undefined,
  index: number,
  toolCall: ToolCall,
  toolResult: ToolResultMessage,
): GatewayRuntimeSnapshotEntry {
  const normalized = normalizeToolResult(toolResult, toolCall);
  return {
    id: `${prefix}-tool-result-${round ?? 0}-${normalized.toolCallId}-${index}`,
    kind: "tool_result",
    round,
    toolResult: normalized,
    summary: normalized.toolName ? `${normalized.toolName} 执行结果` : "工具执行结果",
    text: toolResultMessageToText(normalized),
  };
}

function appendRoundEntries(
  entries: GatewayRuntimeSnapshotEntry[],
  round: UiRound,
  prefix: string,
) {
  let textBuffer = "";
  let assistantIndex = 0;
  let thinkingIndex = 0;
  let toolIndex = 0;
  let hostedSearchIndex = 0;
  let metaEmitted = false;

  const flushText = () => {
    if (textBuffer === "" && (!round.meta || metaEmitted)) {
      return;
    }
    entries.push({
      id: `${prefix}-assistant-${round.round}-${assistantIndex}`,
      kind: "assistant",
      round: round.round,
      text: textBuffer,
      meta: metaEmitted ? undefined : round.meta,
    });
    assistantIndex += 1;
    textBuffer = "";
    if (round.meta) {
      metaEmitted = true;
    }
  };

  for (const block of round.blocks) {
    if (block.kind === "text") {
      textBuffer += block.text;
      continue;
    }

    flushText();

    if (block.kind === "thinking") {
      if (block.text.trim()) {
        entries.push({
          id: `${prefix}-thinking-${round.round}-${thinkingIndex}`,
          kind: "thinking",
          round: round.round,
          text: block.text,
        });
        thinkingIndex += 1;
      }
      continue;
    }

    if (block.kind === "tool") {
      const toolCall = normalizeToolCall(
        block.item.toolCall,
        `${prefix}-tool-${round.round}-${toolIndex}`,
      );
      entries.push(buildToolCallEntry(prefix, round.round, toolIndex, block.item.toolCall));
      if (block.item.toolResult) {
        entries.push(
          buildToolResultEntry(prefix, round.round, toolIndex, toolCall, block.item.toolResult),
        );
      }
      toolIndex += 1;
      continue;
    }

    if (block.kind === "hostedSearch") {
      entries.push({
        id: `${prefix}-hosted-search-${round.round}-${hostedSearchIndex}`,
        kind: "hosted_search",
        round: round.round,
        hostedSearch: block.item,
      });
      hostedSearchIndex += 1;
    }
  }

  flushText();
}

function buildUserEntry(message: Message): GatewayRuntimeSnapshotEntry | null {
  if (message.role !== "user") {
    return null;
  }
  const text = getUserMessageDisplayText(message as Message & Record<string, unknown>);
  const attachments = getUserMessageAttachments(message as Message & Record<string, unknown>);
  if (!text.trim() && attachments.length === 0) {
    return null;
  }
  const messageId = readMessageId(message, "runtime-user");
  return {
    id: messageId,
    kind: "user",
    text,
    attachments,
    messageId,
  };
}

export function buildGatewayRuntimeSnapshotEntries(
  input: GatewayRuntimeSnapshotInput,
): GatewayRuntimeSnapshotEntry[] {
  const entries: GatewayRuntimeSnapshotEntry[] = [];
  const userEntry = input.userMessage ? buildUserEntry(input.userMessage) : null;
  if (userEntry) {
    entries.push(userEntry);
  }

  const liveRounds = input.liveTranscript.liveRounds;
  if (liveRounds.length > 0) {
    liveRounds.forEach((round, index) => {
      appendRoundEntries(entries, round, `runtime-live-${index}`);
    });
    return entries;
  }

  if (input.liveTranscript.draftAssistantText) {
    entries.push({
      id: "runtime-draft-assistant",
      kind: "assistant",
      round: 1,
      text: input.liveTranscript.draftAssistantText,
    });
  }

  return entries;
}
