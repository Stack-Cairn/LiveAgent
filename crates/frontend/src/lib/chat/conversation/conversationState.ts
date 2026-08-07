import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";

import { assistantMessageToText } from "../../providers/llm";
import { createUuid } from "../../shared/id";
import {
  type FileLedger,
  formatFileLedgerBlock,
  mergeMessagesIntoLedger,
} from "../context/fileLedger";
import {
  sanitizeMessagesForContinuation,
  sanitizeMessagesForModelContext,
} from "../context/requestContextSanitizer";
import { normalizeConversationSystemPrompt } from "../context/systemPrompt";
import { buildUiMessages, type UiRound } from "../messages/uiMessages";
import {
  getUserMessageAttachments,
  getUserMessageDisplayText,
  type PendingUploadedFile,
  stripUploadedFilesMessageMetadata,
} from "../messages/uploadedFiles";

export const INTERNAL_RESUME_MESSAGE_TEXT =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
const SILENT_MEMORY_EXTRACTION_FINAL_TEXTS = new Set(["记忆整理完成。", "本轮无需更新记忆。"]);

export type StoredSummaryMessage = {
  role: "summary";
  id: string;
  timestamp: number;
  content: string;
  summaryMeta: {
    format: "plain-text-v1";
    strategy: "cumulative-checkpoint";
    coversThroughMessageId: string;
    coveredMessageCount: number;
    basedOnSummaryMessageId?: string;
    // 确定性机器维护的文件账本，跨 checkpoint 继承。可选字段；旧数据缺失即视为无账本。
    // 存储在 summaryMeta（对 Rust 的 summary_json 不透明），不占摘要正文的字符预算。
    fileLedger?: FileLedger;
    generatedBy: {
      providerId: string;
      model: string;
      promptVersion?: string;
    };
    stats?: {
      sourceMessageCount: number;
      estimatedInputTokens?: number;
      outputTokens?: number;
      summarizer?: {
        inputTokens?: number;
        outputTokens?: number;
      };
    };
  };
};

// 压缩引擎在 checkpoint assistant 消息上附带的统计扩展：
// conversationTokens 是被压缩会话的规模；summarizer 是压缩请求自身的用量。
// 两者必须分开——checkpoint 消息本身的 usage 恒为零，避免污染 token 观测。
export type CompactionCheckpointStats = {
  conversationTokens?: number;
  summarizer?: {
    inputTokens?: number;
    outputTokens?: number;
  };
};

export type StoredChatContextMeta = {
  schemaVersion: 3;
  systemPrompt?: string;
  tools?: Context["tools"];
  activeSegmentIndex: number;
  totalSegmentCount: number;
  totalMessageCount: number;
};

export type StoredContextSegment = {
  segmentIndex: number;
  segmentId: string;
  summary?: StoredSummaryMessage;
  messages: Message[];
  messageCount: number;
  startMessageId?: string;
  endMessageId?: string;
  createdAt: number;
  updatedAt: number;
};

export type HistoryMessageRef = {
  segmentIndex: number;
  messageIndex: number;
  segmentId: string;
  messageId: string;
  role: string;
  contentHash: string;
};

export type RenderSummaryCard = {
  kind: "summary";
  key: string;
  segmentIndex: number;
  summaryId: string;
  content: string;
  coveredMessageCount: number;
  coversThroughMessageId: string;
  generatedBy: {
    providerId: string;
    model: string;
    promptVersion?: string;
  };
  timestamp: number;
  collapsed: boolean;
};

export type RenderUserMessage = {
  kind: "user";
  key: string;
  segmentIndex: number;
  messageRef?: HistoryMessageRef;
  text: string;
  attachments: PendingUploadedFile[];
  timestamp: number;
  isFromCompactedSegment: boolean;
};

export type RenderAssistantGroup = {
  kind: "assistant";
  key: string;
  segmentIndex: number;
  rounds: UiRound[];
  timestamp: number;
  isFromCompactedSegment: boolean;
};

export type RenderTimelineItem = RenderSummaryCard | RenderUserMessage | RenderAssistantGroup;

export type TranscriptSegmentWindow = {
  segmentIndex: number;
  segmentId: string;
  startMessageIndex: number;
  endMessageIndex: number;
};

export type TranscriptProjection = {
  items: RenderTimelineItem[];
  segmentWindows: TranscriptSegmentWindow[];
  oldestMessageOffset: number;
  hasMoreBefore: boolean;
  revision: string | null;
};

export type TranscriptSegmentSlice = {
  segmentIndex: number;
  segmentId: string;
  summary?: StoredSummaryMessage;
  messages: Message[];
  startMessageIndex: number;
  createdAt: number;
  updatedAt: number;
};

export type ConversationViewState = {
  meta: StoredChatContextMeta;
  segments: StoredContextSegment[];
  transcript: TranscriptProjection;
  activeSegmentIndex: number;
};

function createEmptySegment(index: number, timestamp = Date.now()): StoredContextSegment {
  return {
    segmentIndex: index,
    segmentId: createUuid(),
    messages: [],
    messageCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function isCompactionAssistantMessage(message: Message): message is AssistantMessage {
  return (
    message.role === "assistant" &&
    (message.api === "liveagent-compaction" ||
      (message.provider === "liveagent" && message.model === "summary"))
  );
}

function isRuntimeHistoryMessage(message: Message) {
  if (message.role === "assistant") return !isCompactionAssistantMessage(message);
  return message.role === "user" || message.role === "toolResult";
}

function getMessageTimestamp(message: Message | undefined) {
  if (!message) return Date.now();
  return typeof message.timestamp === "number" ? message.timestamp : Date.now();
}

function readMessageStringId(message: Message | undefined) {
  if (!message) return undefined;
  const rawId = (message as { id?: unknown }).id;
  if (typeof rawId === "string" && rawId.trim()) {
    return rawId.trim();
  }
  if (message.role === "assistant" && typeof message.responseId === "string") {
    const responseId = message.responseId.trim();
    if (responseId) return responseId;
  }
  return undefined;
}

function isMemoryManagerToolUseAssistantMessage(message: Message): message is AssistantMessage {
  return (
    message.role === "assistant" &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === "toolCall" && block.name === "MemoryManager")
  );
}

function isMemoryManagerToolResultMessage(message: Message) {
  return message.role === "toolResult" && message.toolName === "MemoryManager";
}

function isSilentMemoryExtractionFinalAssistantMessage(message: Message) {
  if (message.role !== "assistant") return false;
  if (message.content.some((block) => block.type === "toolCall")) return false;
  return SILENT_MEMORY_EXTRACTION_FINAL_TEXTS.has(assistantMessageToText(message).trim());
}

function stripLegacySilentMemoryExtractionSuffix(messages: Message[]) {
  if (
    messages.length < 2 ||
    !isSilentMemoryExtractionFinalAssistantMessage(messages[messages.length - 1])
  ) {
    return messages;
  }

  let suffixStart = messages.length - 1;
  while (
    suffixStart > 0 &&
    (isMemoryManagerToolUseAssistantMessage(messages[suffixStart - 1]) ||
      isMemoryManagerToolResultMessage(messages[suffixStart - 1]))
  ) {
    suffixStart -= 1;
  }

  if (suffixStart === 0) return messages;
  return messages.slice(0, suffixStart);
}

function stripLegacySilentMemoryExtractionMessages(messages: Message[]) {
  let changed = false;
  const next: Message[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (message.role === "user") {
      next.push(message);
      index += 1;
      continue;
    }

    const group: Message[] = [];
    while (index < messages.length && messages[index].role !== "user") {
      group.push(messages[index]);
      index += 1;
    }

    const cleanedGroup = stripLegacySilentMemoryExtractionSuffix(group);
    if (cleanedGroup.length !== group.length) changed = true;
    next.push(...cleanedGroup);
  }

  return changed ? next : messages;
}

function getMessageStableId(
  message: Message | undefined,
  segmentIndex: number,
  messageIndex: number,
) {
  const candidate = readMessageStringId(message);
  if (candidate) return candidate;
  return `segment-${segmentIndex}-message-${messageIndex}-${getMessageTimestamp(message)}`;
}

function appendHashPart(parts: string[], value: unknown) {
  const text = String(value ?? "");
  const byteLength =
    typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length;
  parts.push(`${byteLength}:${text}`);
}

function hashFnv1a32(input: string) {
  const bytes =
    typeof TextEncoder === "function"
      ? new TextEncoder().encode(input)
      : Uint8Array.from(input, (char) => char.charCodeAt(0) & 0xff);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

export function getHistoryMessageContentHash(message: Message): string {
  const parts = ["liveagent-history-ref-v1"];
  appendHashPart(parts, message.role);
  if (message.role === "user") {
    appendHashPart(parts, getUserMessageDisplayText(message as Message & Record<string, unknown>));
    const attachments = getUserMessageAttachments(message as Message & Record<string, unknown>);
    appendHashPart(parts, attachments.length);
    for (const file of attachments) {
      appendHashPart(parts, file.relativePath);
      appendHashPart(parts, file.fileName);
      appendHashPart(parts, file.kind);
      appendHashPart(parts, file.sizeBytes);
    }
  } else {
    appendHashPart(parts, JSON.stringify(message.content ?? null));
  }
  return hashFnv1a32(parts.join("|"));
}

function buildHistoryMessageRef(params: {
  segment: StoredContextSegment;
  message: Message | undefined;
  messageIndex: number;
}): HistoryMessageRef | undefined {
  const { segment, message, messageIndex } = params;
  if (!message) return undefined;
  const segmentId = segment.segmentId?.trim();
  const messageId = readMessageStringId(message);
  const role = typeof message.role === "string" ? message.role.trim() : "";
  if (!segmentId || !messageId || !role) return undefined;
  return {
    segmentIndex: segment.segmentIndex,
    messageIndex,
    segmentId,
    messageId,
    role,
    contentHash: getHistoryMessageContentHash(message),
  };
}

// Stable identity of a persisted user message, looked up by its message id.
// Used at send time to stamp the just-appended user message's own ref onto
// the outgoing user_message event, so remote subscribers can anchor a later
// edit-resend rebase without waiting for a history refresh.
export function findHistoryMessageRefByMessageId(
  state: ConversationViewState,
  messageId: string,
): HistoryMessageRef | undefined {
  const target = messageId.trim();
  if (!target) return undefined;
  for (let segmentIndex = state.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    const segment = state.segments[segmentIndex];
    if (!segment) continue;
    for (let messageIndex = segment.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = segment.messages[messageIndex];
      if (!message || readMessageStringId(message) !== target) continue;
      return buildHistoryMessageRef({ segment, message, messageIndex });
    }
  }
  return undefined;
}

function getSummaryId(summary: StoredSummaryMessage | undefined) {
  return summary?.id;
}

function countMessages(segments: StoredContextSegment[]) {
  return segments.reduce((sum, segment) => sum + segment.messages.length, 0);
}

function buildConversationMeta(params: {
  systemPrompt?: string;
  tools?: Context["tools"];
  segments: StoredContextSegment[];
  activeSegmentIndex?: number;
  totalSegmentCount?: number;
  totalMessageCount?: number;
}): StoredChatContextMeta {
  const activeSegmentArrayIndex =
    typeof params.activeSegmentIndex === "number"
      ? Math.max(0, Math.min(params.activeSegmentIndex, Math.max(0, params.segments.length - 1)))
      : Math.max(0, params.segments.length - 1);
  const activeSegmentIndex = params.segments[activeSegmentArrayIndex]?.segmentIndex ?? 0;
  const systemPrompt = normalizeConversationSystemPrompt(params.systemPrompt);
  return {
    schemaVersion: 3,
    systemPrompt,
    tools: params.tools,
    activeSegmentIndex,
    totalSegmentCount:
      params.totalSegmentCount ??
      Math.max(params.segments.length, activeSegmentIndex + (params.segments.length > 0 ? 1 : 0)),
    totalMessageCount: params.totalMessageCount ?? countMessages(params.segments),
  };
}

function getAssistantPromptVersion(assistant: AssistantMessage) {
  const candidate = (assistant as AssistantMessage & { promptVersion?: unknown }).promptVersion;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : "summary-v1";
}

function appendCompactionCheckpointToSegments(
  segments: StoredContextSegment[],
  activeSegmentIndex: number,
  checkpointMessage: AssistantMessage,
  coveredMessageCount: number,
) {
  if (coveredMessageCount === 0) {
    return {
      activeSegmentIndex,
      appended: false,
    };
  }

  const previousSegment = segments[activeSegmentIndex];
  if (!previousSegment || previousSegment.messages.length === 0) {
    return {
      activeSegmentIndex,
      appended: false,
    };
  }

  const previousMessageIndex = Math.max(0, previousSegment.messages.length - 1);
  const coversThroughMessageId =
    previousSegment.endMessageId ||
    getMessageStableId(
      previousSegment.messages[previousMessageIndex],
      previousSegment.segmentIndex,
      previousMessageIndex,
    );
  const nextSegmentIndex = previousSegment.segmentIndex + 1;
  const nextSegment = createEmptySegment(
    nextSegmentIndex,
    checkpointMessage.timestamp ?? Date.now(),
  );
  // 累积账本：上一 checkpoint 的账本（seed）+ 本段被折叠消息的新增操作。在消息级合并，
  // 以保住本段内“先改后读”等真实时序。previousSegment.summary 恰是上一次压缩产生的
  // checkpoint（basedOn 亦指向它），其 fileLedger 覆盖 previousSegment.messages 之前的历史。
  const fileLedger = mergeMessagesIntoLedger(
    previousSegment.summary?.summaryMeta.fileLedger,
    previousSegment.messages,
  );
  nextSegment.summary = createSummaryFromAssistant(checkpointMessage, {
    segmentIndex: nextSegmentIndex,
    coveredMessageCount,
    coversThroughMessageId,
    basedOnSummaryMessageId: getSummaryId(previousSegment.summary),
    sourceMessageCount: previousSegment.messages.length,
    fileLedger,
  });
  segments.push(nextSegment);

  return {
    activeSegmentIndex: segments.length - 1,
    appended: true,
  };
}

function buildSummaryStats(
  assistant: AssistantMessage,
  sourceMessageCount: number,
): NonNullable<StoredSummaryMessage["summaryMeta"]["stats"]> {
  const checkpointStats = (
    assistant as AssistantMessage & { compactionStats?: CompactionCheckpointStats }
  ).compactionStats;
  if (checkpointStats) {
    return {
      sourceMessageCount,
      estimatedInputTokens: checkpointStats.conversationTokens,
      outputTokens: checkpointStats.summarizer?.outputTokens,
      summarizer: checkpointStats.summarizer,
    };
  }
  return {
    sourceMessageCount,
    estimatedInputTokens:
      typeof assistant.usage?.input === "number" ? assistant.usage.input : undefined,
    outputTokens: typeof assistant.usage?.output === "number" ? assistant.usage.output : undefined,
  };
}

function createSummaryFromAssistant(
  assistant: AssistantMessage,
  params: {
    segmentIndex: number;
    coveredMessageCount: number;
    coversThroughMessageId: string;
    basedOnSummaryMessageId?: string;
    sourceMessageCount: number;
    fileLedger?: FileLedger;
  },
): StoredSummaryMessage {
  const content = assistantMessageToText(assistant).trim();
  const summaryId =
    (typeof assistant.responseId === "string" && assistant.responseId.trim()) ||
    `summary-${params.segmentIndex}-${assistant.timestamp ?? Date.now()}`;

  return {
    role: "summary",
    id: summaryId,
    timestamp: assistant.timestamp ?? Date.now(),
    content,
    summaryMeta: {
      format: "plain-text-v1",
      strategy: "cumulative-checkpoint",
      coversThroughMessageId: params.coversThroughMessageId,
      coveredMessageCount: params.coveredMessageCount,
      basedOnSummaryMessageId: params.basedOnSummaryMessageId,
      fileLedger: params.fileLedger,
      generatedBy: {
        providerId:
          typeof assistant.provider === "string" && assistant.provider.trim()
            ? assistant.provider.trim()
            : "liveagent",
        model:
          typeof assistant.model === "string" && assistant.model.trim()
            ? assistant.model.trim()
            : "summary",
        promptVersion: getAssistantPromptVersion(assistant),
      },
      stats: buildSummaryStats(assistant, params.sourceMessageCount),
    },
  };
}

function normalizeSegment(
  segment: StoredContextSegment,
  segmentIndex: number,
): StoredContextSegment {
  const messages = segment.messages.filter((message, messageIndex) => {
    if (!isRuntimeHistoryMessage(message)) return false;
    if (
      segment.summary &&
      messageIndex === 0 &&
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.trim() === INTERNAL_RESUME_MESSAGE_TEXT
    ) {
      return false;
    }
    return true;
  });
  const messageCount = messages.length;
  const startMessageId =
    messageCount > 0 ? getMessageStableId(messages[0], segmentIndex, 0) : undefined;
  const endMessageId =
    messageCount > 0
      ? getMessageStableId(messages[messageCount - 1], segmentIndex, messageCount - 1)
      : undefined;
  const updatedAt =
    messageCount > 0
      ? getMessageTimestamp(messages[messageCount - 1])
      : segment.updatedAt || segment.createdAt || Date.now();

  return {
    segmentIndex,
    segmentId: segment.segmentId || createUuid(),
    summary: segment.summary,
    messages,
    messageCount,
    startMessageId,
    endMessageId,
    createdAt: segment.createdAt || updatedAt,
    updatedAt,
  };
}

export function appendSummaryToSystemPrompt(
  baseSystemPrompt: string | undefined,
  summaryContent: string | undefined,
  fileLedger?: FileLedger,
) {
  if (!summaryContent?.trim()) return baseSystemPrompt;

  const ledgerBlock = formatFileLedgerBlock(fileLedger);
  const summaryBlock = [
    "",
    "## Previous Conversation Summary",
    "",
    "The following is a compressed summary of the earlier conversation. Use it to understand the context,",
    "but do not repeat work that has already been completed.",
    "",
    summaryContent.trim(),
    ...(ledgerBlock ? ["", ledgerBlock] : []),
    "",
  ].join("\n");

  const base = (baseSystemPrompt || "").trim();
  return base ? `${base}\n${summaryBlock}` : summaryBlock.trim();
}

function buildTimelineItemsForSegment(
  segment: StoredContextSegment,
  isCompacted: boolean,
  startMessageIndex = 0,
  options?: { includeSummary?: boolean },
): RenderTimelineItem[] {
  return buildTimelineItemsForSlice(
    {
      segmentIndex: segment.segmentIndex,
      segmentId: segment.segmentId,
      summary: segment.summary,
      messages: segment.messages.slice(startMessageIndex),
      startMessageIndex,
      createdAt: segment.createdAt,
      updatedAt: segment.updatedAt,
    },
    isCompacted,
    options,
  );
}

function readInjectedHistoryMessageRef(message: Message | undefined) {
  if (!message) return undefined;
  const candidate = (message as Message & { liveAgentHistoryRef?: unknown }).liveAgentHistoryRef;
  if (!candidate || typeof candidate !== "object") return undefined;
  const ref = candidate as Partial<HistoryMessageRef>;
  if (
    typeof ref.segmentIndex !== "number" ||
    typeof ref.messageIndex !== "number" ||
    typeof ref.segmentId !== "string" ||
    typeof ref.messageId !== "string" ||
    typeof ref.role !== "string" ||
    typeof ref.contentHash !== "string"
  ) {
    return undefined;
  }
  return ref as HistoryMessageRef;
}

function buildTimelineItemsForSlice(
  slice: TranscriptSegmentSlice,
  isCompacted: boolean,
  options?: { includeSummary?: boolean },
): RenderTimelineItem[] {
  const items: RenderTimelineItem[] = [];

  if (options?.includeSummary !== false && slice.startMessageIndex === 0 && slice.summary) {
    items.push({
      kind: "summary",
      key: `summary-${slice.segmentId}-${slice.summary.id}`,
      segmentIndex: slice.segmentIndex,
      summaryId: slice.summary.id,
      content: slice.summary.content,
      coveredMessageCount: slice.summary.summaryMeta.coveredMessageCount,
      coversThroughMessageId: slice.summary.summaryMeta.coversThroughMessageId,
      generatedBy: slice.summary.summaryMeta.generatedBy,
      timestamp: slice.summary.timestamp,
      collapsed: true,
    });
  }

  const uiMessages = buildUiMessages(slice.messages, slice.startMessageIndex);
  for (const uiMessage of uiMessages) {
    if (uiMessage.role === "user") {
      const absoluteMessageIndex = uiMessage.messageIndex ?? slice.startMessageIndex;
      const source = slice.messages[absoluteMessageIndex - slice.startMessageIndex];
      const injectedRef = readInjectedHistoryMessageRef(source);
      const messageRef =
        injectedRef?.segmentIndex === slice.segmentIndex &&
        injectedRef.segmentId === slice.segmentId &&
        injectedRef.messageIndex === absoluteMessageIndex
          ? injectedRef
          : buildHistoryMessageRef({
              segment: {
                segmentIndex: slice.segmentIndex,
                segmentId: slice.segmentId,
                summary: slice.summary,
                messages: slice.messages,
                messageCount: slice.messages.length,
                createdAt: slice.createdAt,
                updatedAt: slice.updatedAt,
              },
              message: source,
              messageIndex: absoluteMessageIndex,
            });
      items.push({
        kind: "user",
        key: `segment-${slice.segmentId}-${uiMessage.key}`,
        segmentIndex: slice.segmentIndex,
        messageRef,
        text: uiMessage.text,
        attachments: uiMessage.attachments ?? [],
        timestamp: getMessageTimestamp(source),
        isFromCompactedSegment: isCompacted,
      });
      continue;
    }

    items.push({
      kind: "assistant",
      key: `segment-${slice.segmentId}-${uiMessage.key}`,
      segmentIndex: slice.segmentIndex,
      rounds: uiMessage.rounds ?? [],
      timestamp: uiMessage.timestamp ?? getMessageTimestamp(slice.messages.at(-1)),
      isFromCompactedSegment: isCompacted,
    });
  }

  return items;
}

export function createTranscriptProjection(params: {
  segments: TranscriptSegmentSlice[];
  activeSegmentIndex: number;
  oldestMessageOffset: number;
  hasMoreBefore: boolean;
  revision: string | null;
}): TranscriptProjection {
  const segments = params.segments
    .slice()
    .sort(
      (left, right) =>
        left.segmentIndex - right.segmentIndex || left.startMessageIndex - right.startMessageIndex,
    );
  return {
    items: segments.flatMap((segment) =>
      buildTimelineItemsForSlice(segment, segment.segmentIndex < params.activeSegmentIndex),
    ),
    segmentWindows: segments.map((segment) => ({
      segmentIndex: segment.segmentIndex,
      segmentId: segment.segmentId,
      startMessageIndex: segment.startMessageIndex,
      endMessageIndex: segment.startMessageIndex + segment.messages.length,
    })),
    oldestMessageOffset: params.oldestMessageOffset,
    hasMoreBefore: params.hasMoreBefore,
    revision: params.revision,
  };
}

export function prependTranscriptProjection(
  state: ConversationViewState,
  page: TranscriptProjection,
): ConversationViewState {
  const segmentWindows = new Map<string, TranscriptSegmentWindow>();
  for (const window of [...page.segmentWindows, ...state.transcript.segmentWindows]) {
    const previous = segmentWindows.get(window.segmentId);
    segmentWindows.set(
      window.segmentId,
      previous
        ? {
            ...previous,
            startMessageIndex: Math.min(previous.startMessageIndex, window.startMessageIndex),
            endMessageIndex: Math.max(previous.endMessageIndex, window.endMessageIndex),
          }
        : window,
    );
  }

  return {
    ...state,
    transcript: {
      items: [...page.items, ...state.transcript.items],
      segmentWindows: Array.from(segmentWindows.values()).sort(
        (left, right) => left.segmentIndex - right.segmentIndex,
      ),
      oldestMessageOffset: page.oldestMessageOffset,
      hasMoreBefore: page.hasMoreBefore,
      revision: page.revision,
    },
  };
}

function markTimelineItemCompacted(item: RenderTimelineItem): RenderTimelineItem {
  if (item.kind === "summary" || item.isFromCompactedSegment) {
    return item;
  }

  return {
    ...item,
    isFromCompactedSegment: true,
  };
}

function rebuildTimelineForActiveSegment(params: {
  previousItems: RenderTimelineItem[];
  segments: StoredContextSegment[];
  activeSegmentIndex: number;
  activeStartMessageIndex: number;
}) {
  const { previousItems, segments, activeSegmentIndex, activeStartMessageIndex } = params;
  const activeSegment = segments[activeSegmentIndex];
  const activeAbsoluteIndex = activeSegment?.segmentIndex ?? 0;
  const preserved = previousItems
    .filter((item) => item.segmentIndex < activeAbsoluteIndex)
    .map(markTimelineItemCompacted);
  const activeItems = activeSegment
    ? buildTimelineItemsForSegment(activeSegment, false, activeStartMessageIndex)
    : [];
  return [...preserved, ...activeItems];
}

function getTranscriptSegmentStart(
  transcript: TranscriptProjection,
  segment: StoredContextSegment | undefined,
) {
  if (!segment) return 0;
  return (
    transcript.segmentWindows.find((window) => window.segmentId === segment.segmentId)
      ?.startMessageIndex ?? segment.messages.length
  );
}

function syncTranscriptWindows(
  transcript: TranscriptProjection,
  runtimeSegments: StoredContextSegment[],
  changedSegmentIndexes: Iterable<number>,
  getInitialStartMessageIndex: (
    runtimeSegment: StoredContextSegment,
    localSegmentIndex: number,
  ) => number,
) {
  const windows = new Map(
    transcript.segmentWindows.map((window) => [window.segmentId, window] as const),
  );
  for (const index of changedSegmentIndexes) {
    const runtimeSegment = runtimeSegments[index];
    if (!runtimeSegment) continue;
    const existing = windows.get(runtimeSegment.segmentId);
    const startMessageIndex = Math.min(
      existing?.startMessageIndex ?? getInitialStartMessageIndex(runtimeSegment, index),
      runtimeSegment.messages.length,
    );
    windows.set(runtimeSegment.segmentId, {
      segmentIndex: runtimeSegment.segmentIndex,
      segmentId: runtimeSegment.segmentId,
      startMessageIndex,
      endMessageIndex: runtimeSegment.messages.length,
    });
  }
  return Array.from(windows.values()).sort((left, right) => left.segmentIndex - right.segmentIndex);
}

// Extends a segment's timeline items after messages were appended to it.
// Because UI-group boundaries are determined solely by user-message
// positions, an append can only ever extend the trailing non-user run —
// every earlier item is returned by identity so memoized rows bail. Returns
// null when the previous message list is not a reference-identical prefix of
// the next one (caller falls back to a full rebuild).
function extendSegmentTimelineItems(
  previousItems: RenderTimelineItem[],
  previousSegment: StoredContextSegment,
  nextSegment: StoredContextSegment,
  visibleStartMessageIndex: number,
): RenderTimelineItem[] | null {
  const prevMessages = previousSegment.messages;
  const nextMessages = nextSegment.messages;
  if (nextMessages.length < prevMessages.length) return null;
  for (let index = 0; index < prevMessages.length; index += 1) {
    if (nextMessages[index] !== prevMessages[index]) return null;
  }
  if (nextMessages.length === prevMessages.length) return previousItems;

  let runStart = prevMessages.length;
  while (runStart > 0 && prevMessages[runStart - 1].role !== "user") {
    runStart -= 1;
  }
  const visibleRunStart = Math.max(runStart, visibleStartMessageIndex);

  let boundary = prevMessages.length;
  let reused = previousItems;
  if (runStart < prevMessages.length && nextMessages[prevMessages.length].role !== "user") {
    // The trailing assistant run grows: rebuild it from its start. Drop the
    // previously emitted trailing assistant item for this segment (if any) so
    // the rebuilt run replaces it; a contentless or render-only tail that
    // emitted nothing leaves nothing to drop.
    boundary = visibleRunStart;
    const trailingItem = previousItems[previousItems.length - 1];
    if (
      trailingItem?.kind === "assistant" &&
      trailingItem.segmentIndex === previousSegment.segmentIndex
    ) {
      reused = previousItems.slice(0, -1);
    }
  }

  return [
    ...reused,
    ...buildTimelineItemsForSegment(nextSegment, false, boundary, { includeSummary: false }),
  ];
}

// Timeline update for the append hot path (send twin, settle, checkpoint):
// O(appended messages) instead of a full active-segment rebuild, with every
// untouched item preserved by identity so the row layer's caches hold.
function updateTimelineForAppend(params: {
  previousItems: RenderTimelineItem[];
  transcript: TranscriptProjection;
  previousSegments: StoredContextSegment[];
  previousActiveSegmentIndex: number;
  segments: StoredContextSegment[];
  activeSegmentIndex: number;
}): RenderTimelineItem[] {
  const {
    previousItems,
    transcript,
    previousSegments,
    previousActiveSegmentIndex,
    segments,
    activeSegmentIndex,
  } = params;

  const previousActive = previousSegments[previousActiveSegmentIndex];
  const nextOfPrevious = segments[previousActiveSegmentIndex];
  const fallback = () =>
    rebuildTimelineForActiveSegment({
      previousItems,
      segments,
      activeSegmentIndex,
      activeStartMessageIndex: getTranscriptSegmentStart(transcript, segments[activeSegmentIndex]),
    });
  if (!previousActive || !nextOfPrevious || previousActive.segmentId !== nextOfPrevious.segmentId) {
    return fallback();
  }

  const extended = extendSegmentTimelineItems(
    previousItems,
    previousActive,
    nextOfPrevious,
    getTranscriptSegmentStart(transcript, previousActive),
  );
  if (extended === null) {
    return fallback();
  }
  if (activeSegmentIndex === previousActiveSegmentIndex) {
    return extended;
  }

  // A compaction checkpoint advanced the active segment: everything before
  // the new active segment is compacted now, and the checkpoint-born
  // segments (summary card plus any trailing messages) build from scratch —
  // they are new and small.
  const compacted = extended.map((item) =>
    item.segmentIndex < (segments[activeSegmentIndex]?.segmentIndex ?? 0)
      ? markTimelineItemCompacted(item)
      : item,
  );
  const appendedSegmentItems = segments
    .filter((segment) => segment.segmentIndex > previousActive.segmentIndex)
    .flatMap((segment) =>
      buildTimelineItemsForSegment(
        segment,
        segment.segmentIndex < (segments[activeSegmentIndex]?.segmentIndex ?? 0),
      ),
    );
  return [...compacted, ...appendedSegmentItems];
}

export function normalizeConversationState(input: {
  meta: Pick<StoredChatContextMeta, "systemPrompt" | "tools"> &
    Partial<Omit<StoredChatContextMeta, "schemaVersion" | "systemPrompt" | "tools">>;
  segments: StoredContextSegment[];
  transcript?: TranscriptProjection;
}): ConversationViewState {
  const rawSegments = input.segments.length > 0 ? input.segments : [createEmptySegment(0)];
  // normalizeSegment silently drops non-runtime messages from legacy data.
  // The wire totalMessageCount still counts them; persist rewrites the loaded
  // segments without them, so the header total must shrink by the same amount
  // or Rust's segment-sum consistency check rejects every future persist.
  let droppedMessageCount = 0;
  const segments = rawSegments
    .slice()
    .sort((a, b) => a.segmentIndex - b.segmentIndex)
    .map((segment) => {
      const normalized = normalizeSegment(segment, Math.max(0, segment.segmentIndex));
      droppedMessageCount += segment.messages.length - normalized.messages.length;
      return normalized;
    });
  const activeSegmentIndex = Math.max(0, segments.length - 1);
  const activeAbsoluteIndex = segments[activeSegmentIndex]?.segmentIndex ?? 0;
  const meta = buildConversationMeta({
    systemPrompt: input.meta.systemPrompt,
    tools: input.meta.tools,
    segments,
    activeSegmentIndex,
    totalSegmentCount: Math.max(input.meta.totalSegmentCount ?? 0, activeAbsoluteIndex + 1),
    totalMessageCount:
      input.meta.totalMessageCount !== undefined
        ? Math.max(0, input.meta.totalMessageCount - droppedMessageCount)
        : countMessages(segments),
  });
  const transcript =
    input.transcript ??
    createTranscriptProjection({
      segments: segments.map((segment) => ({
        segmentIndex: segment.segmentIndex,
        segmentId: segment.segmentId,
        summary: segment.summary,
        messages: segment.messages,
        startMessageIndex: 0,
        createdAt: segment.createdAt,
        updatedAt: segment.updatedAt,
      })),
      activeSegmentIndex: activeAbsoluteIndex,
      oldestMessageOffset: 0,
      hasMoreBefore: false,
      revision: null,
    });

  return {
    meta,
    segments,
    activeSegmentIndex,
    transcript,
  };
}

export function createConversationStateFromContext(context: Context): ConversationViewState {
  const seed = normalizeConversationState({
    meta: {
      systemPrompt: context.systemPrompt,
      tools: context.tools,
    },
    segments: [createEmptySegment(0)],
  });

  return appendMessagesToConversation(seed, context.messages);
}

export function buildRequestContext(
  state: ConversationViewState,
  options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
): Context {
  const activeSegment = state.segments[state.activeSegmentIndex] ?? createEmptySegment(0);
  const contextMessages = stripLegacySilentMemoryExtractionMessages(activeSegment.messages);
  const runtimeMessages = options?.includeUploadedFilesMetadata
    ? contextMessages
    : contextMessages.map(stripUploadedFilesMessageMetadata);
  const next: Context = {
    messages: options?.includeAbortedMessages
      ? sanitizeMessagesForModelContext(runtimeMessages)
      : sanitizeMessagesForContinuation(runtimeMessages),
  };

  const systemPrompt = appendSummaryToSystemPrompt(
    state.meta.systemPrompt,
    activeSegment.summary?.content,
    activeSegment.summary?.summaryMeta.fileLedger,
  );
  if (typeof systemPrompt === "string") {
    next.systemPrompt = systemPrompt;
  }
  if (Array.isArray(state.meta.tools)) {
    next.tools = state.meta.tools;
  }

  return next;
}

export function getActiveSegment(state: ConversationViewState) {
  return state.segments[state.activeSegmentIndex] ?? state.segments[state.segments.length - 1];
}

export function applyCompactionCheckpoint(
  state: ConversationViewState,
  checkpointMessage: AssistantMessage,
): ConversationViewState {
  if (!isCompactionAssistantMessage(checkpointMessage)) {
    return state;
  }
  return appendMessagesToConversation(state, [checkpointMessage]);
}

export function appendMessagesToConversation(
  state: ConversationViewState,
  incomingMessages: Message[],
): ConversationViewState {
  if (incomingMessages.length === 0) return state;

  const segments = state.segments.map((segment) => ({
    ...segment,
    messages: segment.messages.slice(),
  }));
  let activeSegmentIndex = Math.min(
    Math.max(0, state.activeSegmentIndex),
    Math.max(0, segments.length - 1),
  );
  const previousActiveSegmentIndex = activeSegmentIndex;
  const changedSegmentIndexes = new Set<number>();
  let appendedMessageCount = 0;

  for (const message of incomingMessages) {
    if (isCompactionAssistantMessage(message)) {
      const checkpoint = appendCompactionCheckpointToSegments(
        segments,
        activeSegmentIndex,
        message,
        state.meta.totalMessageCount + appendedMessageCount,
      );
      if (checkpoint.appended) {
        activeSegmentIndex = checkpoint.activeSegmentIndex;
        changedSegmentIndexes.add(activeSegmentIndex);
      }
      continue;
    }

    if (!isRuntimeHistoryMessage(message)) continue;
    segments[activeSegmentIndex].messages.push(message);
    segments[activeSegmentIndex].updatedAt = getMessageTimestamp(message);
    changedSegmentIndexes.add(activeSegmentIndex);
    appendedMessageCount += 1;
  }

  if (changedSegmentIndexes.size === 0) return state;

  const normalizedSegments = segments.map((segment, index) =>
    changedSegmentIndexes.has(index) ? normalizeSegment(segment, segment.segmentIndex) : segment,
  );
  const meta = buildConversationMeta({
    systemPrompt: state.meta.systemPrompt,
    tools: state.meta.tools,
    segments: normalizedSegments,
    activeSegmentIndex,
    totalSegmentCount: Math.max(
      state.meta.totalSegmentCount,
      (normalizedSegments[activeSegmentIndex]?.segmentIndex ?? 0) + 1,
    ),
    totalMessageCount: state.meta.totalMessageCount + appendedMessageCount,
  });
  const items = updateTimelineForAppend({
    previousItems: state.transcript.items,
    transcript: state.transcript,
    previousSegments: state.segments,
    previousActiveSegmentIndex,
    segments: normalizedSegments,
    activeSegmentIndex,
  });
  const segmentWindows = syncTranscriptWindows(
    state.transcript,
    normalizedSegments,
    changedSegmentIndexes,
    (runtimeSegment, index) => {
      const previousSegment = state.segments[index];
      return previousSegment?.segmentId === runtimeSegment.segmentId
        ? previousSegment.messages.length
        : 0;
    },
  );

  return {
    meta,
    segments: normalizedSegments,
    activeSegmentIndex,
    transcript: {
      ...state.transcript,
      items,
      segmentWindows,
      revision: null,
    },
  };
}

function shiftUiRounds(rounds: UiRound[], offset: number): UiRound[] {
  if (offset <= 0) return rounds;
  return rounds.map((round) => {
    const ordinalKey = /^r(\d+)$/.exec(round.key);
    return {
      ...round,
      round: round.round + offset,
      // `r<n>` keys are ordinal-derived and would collide with the merge
      // target's own rounds; shift them in lockstep. Foreign keys stay put.
      key: ordinalKey ? `r${Number(ordinalKey[1]) + offset}` : round.key,
    };
  });
}

function getLastRoundNumber(rounds: UiRound[]) {
  return rounds.reduce((max, round) => Math.max(max, round.round), 0);
}

export function appendRenderOnlyMessagesToConversation(
  state: ConversationViewState,
  incomingMessages: Message[],
): ConversationViewState {
  if (incomingMessages.length === 0) return state;

  const uiMessages = buildUiMessages(incomingMessages).filter(
    (message) => message.role === "assistant" && (message.rounds?.length ?? 0) > 0,
  );
  if (uiMessages.length === 0) return state;

  const transcriptItems = state.transcript.items.slice();
  const timestamp = getMessageTimestamp(incomingMessages[incomingMessages.length - 1]);
  const activeSegmentIndex = getActiveSegment(state)?.segmentIndex ?? state.meta.activeSegmentIndex;

  for (const uiMessage of uiMessages) {
    const sourceRounds = uiMessage.rounds ?? [];
    if (sourceRounds.length === 0) continue;

    const lastIndex = transcriptItems.length - 1;
    const lastItem = transcriptItems[lastIndex];
    if (
      lastItem?.kind === "assistant" &&
      lastItem.segmentIndex === activeSegmentIndex &&
      !lastItem.isFromCompactedSegment
    ) {
      const roundOffset = getLastRoundNumber(lastItem.rounds);
      transcriptItems[lastIndex] = {
        ...lastItem,
        rounds: [...lastItem.rounds, ...shiftUiRounds(sourceRounds, roundOffset)],
        timestamp,
      };
      continue;
    }

    transcriptItems.push({
      kind: "assistant",
      key: `render-only-${getActiveSegment(state)?.segmentId ?? state.activeSegmentIndex}-${transcriptItems.length}-${timestamp}`,
      segmentIndex: activeSegmentIndex,
      rounds: sourceRounds,
      timestamp,
      isFromCompactedSegment: false,
    });
  }

  return {
    ...state,
    transcript: {
      ...state.transcript,
      items: transcriptItems,
    },
  };
}

export function replaceActiveSegmentMessages(
  state: ConversationViewState,
  messages: Message[],
): ConversationViewState {
  const activeSegment = state.segments[state.activeSegmentIndex];
  if (!activeSegment) return state;
  const previousMessageCount = activeSegment.messages.length;

  const segments = state.segments.map((segment, index) =>
    index === state.activeSegmentIndex
      ? {
          ...segment,
          messages: messages.slice(),
          updatedAt:
            messages.length > 0
              ? getMessageTimestamp(messages[messages.length - 1])
              : segment.createdAt,
        }
      : segment,
  );
  const normalizedSegments = segments.map((segment, index) =>
    index === state.activeSegmentIndex ? normalizeSegment(segment, segment.segmentIndex) : segment,
  );
  const meta = buildConversationMeta({
    systemPrompt: state.meta.systemPrompt,
    tools: state.meta.tools,
    segments: normalizedSegments,
    activeSegmentIndex: state.activeSegmentIndex,
    totalSegmentCount: state.meta.totalSegmentCount,
    totalMessageCount: state.meta.totalMessageCount - previousMessageCount + messages.length,
  });
  const activeStartMessageIndex = getTranscriptSegmentStart(state.transcript, activeSegment);
  const items = rebuildTimelineForActiveSegment({
    previousItems: state.transcript.items,
    segments: normalizedSegments,
    activeSegmentIndex: state.activeSegmentIndex,
    activeStartMessageIndex,
  });
  const segmentWindows = syncTranscriptWindows(
    state.transcript,
    normalizedSegments,
    [state.activeSegmentIndex],
    (runtimeSegment) => runtimeSegment.messages.length,
  );

  return {
    meta,
    segments: normalizedSegments,
    activeSegmentIndex: state.activeSegmentIndex,
    transcript: {
      ...state.transcript,
      items,
      segmentWindows,
      revision: null,
    },
  };
}
