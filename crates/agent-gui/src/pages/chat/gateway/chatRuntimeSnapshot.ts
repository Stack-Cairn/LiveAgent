import type { Message, ToolCall, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { SharedChatEntry } from "@liveagent/ui/contracts/chatEntry";
import {
  getUserMessageAttachments,
  getUserMessageDisplayText,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import type { ConversationViewState } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptState } from "../../../lib/chat/conversation/liveTranscriptStore";
import {
  safeStringify,
  summarizeToolCall,
  toolResultMessageToText,
  type UiRound,
} from "../../../lib/chat/messages/uiMessages";
import { buildGatewayToolCallPreviewArguments } from "../turns/gatewayToolPreview";

export type GatewayRuntimeSnapshotState = "running" | "completed" | "failed" | "cancelled";

type GatewayAssistantMeta = {
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  usage?: Usage;
  usageTotalTokens?: number;
  contextUsageTokens?: number;
  contextRelevant?: boolean;
};

export type GatewayRuntimeSnapshotEntry = SharedChatEntry<
  ToolCall,
  ToolResultMessage,
  GatewayAssistantMeta,
  { messageId: string }
>;

export type GatewayRuntimeSnapshotInput = {
  userMessage?: Message | null;
  liveTranscript: LiveTranscriptState;
};

export type GatewayFinalProjectionInput = {
  state: ConversationViewState;
  userMessage: Message;
  runId: string;
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

function buildUserEntry(
  message: Message,
): Extract<GatewayRuntimeSnapshotEntry, { kind: "user" }> | null {
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

export function buildGatewayFinalProjectionEntries(
  input: GatewayFinalProjectionInput,
): GatewayRuntimeSnapshotEntry[] {
  const userEntry = buildUserEntry(input.userMessage);
  const entries: GatewayRuntimeSnapshotEntry[] = userEntry ? [userEntry] : [];
  const userMessageId = readMessageId(input.userMessage, "");
  let userIndex = input.state.transcript.items.findIndex(
    (item) => item.kind === "user" && item.messageRef?.messageId === userMessageId,
  );
  if (userIndex < 0 && userEntry) {
    for (let index = input.state.transcript.items.length - 1; index >= 0; index -= 1) {
      const item = input.state.transcript.items[index];
      if (
        item?.kind === "user" &&
        item.text === userEntry.text &&
        item.attachments.length === userEntry.attachments.length
      ) {
        userIndex = index;
        break;
      }
    }
  }
  if (userIndex < 0) {
    return entries;
  }

  let assistantGroupIndex = 0;
  for (let index = userIndex + 1; index < input.state.transcript.items.length; index += 1) {
    const item = input.state.transcript.items[index];
    if (!item) continue;
    if (item.kind === "user") {
      break;
    }
    if (item.kind !== "assistant") {
      continue;
    }
    for (const round of item.rounds) {
      appendRoundEntries(entries, round, `run-${input.runId}-assistant-${assistantGroupIndex}`);
      assistantGroupIndex += 1;
    }
  }
  return entries;
}
