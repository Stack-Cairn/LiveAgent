import { invoke } from "@tauri-apps/api/core";
import type { Message } from "../agentTypes";

import {
  normalizeConversationState,
  type ConversationViewState,
  type StoredChatContextMeta,
  type StoredContextSegment,
  type StoredSummaryMessage,
} from "./conversationState";
import { normalizeConversationSystemPrompt } from "./systemPrompt";

export type ChatHistorySummary = {
  id: string;
  title: string;
  providerId: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  messageCount?: number;
  createdAt: number;
  updatedAt: number;
  isPinned?: boolean;
  pinnedAt?: number | null;
  isShared?: boolean;
  isPending?: boolean;
};

export type ChatHistoryListPage = {
  items: ChatHistorySummary[];
  totalCount: number;
};

export type ChatHistoryListFilter = {
  cwd?: string;
  cwdEmpty?: boolean;
};

export type ChatHistoryWorkdirSummary = {
  path: string;
  conversationCount: number;
  updatedAt: number;
};

export type ChatHistoryWorkdirsResponse = {
  workdirs: ChatHistoryWorkdirSummary[];
};

type ChatHistorySegmentWireRecord = {
  segmentIndex: number;
  segmentId: string;
  summaryJson?: string | null;
  messagesJson: string;
  messageCount: number;
  startMessageId?: string;
  endMessageId?: string;
  createdAt: number;
  updatedAt: number;
};

type ChatHistoryWireRecord = ChatHistorySummary & {
  contextMetaJson: string;
  activeSegmentIndex: number;
  totalSegmentCount: number;
  totalMessageCount: number;
  segments: ChatHistorySegmentWireRecord[];
};

type ChatHistoryActiveSegmentWireRecord = ChatHistorySummary & {
  contextMetaJson: string;
  activeSegmentIndex: number;
  totalSegmentCount: number;
  totalMessageCount: number;
  activeSegment: ChatHistorySegmentWireRecord;
};

export type ChatHistoryRecord = ChatHistorySummary & {
  state: ConversationViewState;
};

export type ChatHistoryActiveSegmentRecord = ChatHistorySummary & {
  meta: StoredChatContextMeta;
  activeSegment: StoredContextSegment;
};

const conversationWriteQueues = new Map<string, Promise<void>>();

type ChatHistoryUpsertInput = {
  id: string;
  title: string;
  providerId: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  contextMetaJson: string;
  activeSegmentIndex: number;
  totalSegmentCount: number;
  totalMessageCount: number;
  segments: ChatHistorySegmentWireRecord[];
  createdAt?: number;
  updatedAt: number;
};

type ChatHistoryConversationInput = Omit<ChatHistoryUpsertInput, "segments">;

type ChatHistorySegmentMutationInput = {
  conversation: ChatHistoryConversationInput;
  segment: ChatHistorySegmentWireRecord;
};

function isMessageArray(value: unknown): value is Message[] {
  return Array.isArray(value);
}

function parseStoredSummaryMessage(raw: string): StoredSummaryMessage {
  const parsed = JSON.parse(raw) as StoredSummaryMessage | null;
  if (
    !parsed ||
    parsed.role !== "summary" ||
    typeof parsed.id !== "string" ||
    typeof parsed.content !== "string"
  ) {
    throw new Error("历史摘要数据格式无效");
  }
  return parsed;
}

function parseStoredChatContextMeta(
  raw: string,
  fallbackSystemPrompt?: string,
): StoredChatContextMeta {
  const parsed = JSON.parse(raw) as Partial<StoredChatContextMeta> | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("历史上下文元数据格式无效");
  }

  const systemPrompt = normalizeConversationSystemPrompt(
    typeof parsed.systemPrompt === "string" ? parsed.systemPrompt : fallbackSystemPrompt,
  );

  return {
    schemaVersion: 3,
    systemPrompt,
    tools: Array.isArray(parsed.tools) ? parsed.tools : undefined,
    activeSegmentIndex:
      typeof parsed.activeSegmentIndex === "number" ? parsed.activeSegmentIndex : 0,
    totalSegmentCount:
      typeof parsed.totalSegmentCount === "number" ? parsed.totalSegmentCount : 1,
    totalMessageCount:
      typeof parsed.totalMessageCount === "number" ? parsed.totalMessageCount : 0,
  };
}

function parseStoredSegment(record: ChatHistorySegmentWireRecord): StoredContextSegment {
  const parsedMessages = JSON.parse(record.messagesJson) as unknown;
  if (!isMessageArray(parsedMessages)) {
    throw new Error("历史分段消息格式无效");
  }

  return {
    segmentIndex: record.segmentIndex,
    segmentId: record.segmentId,
    summary: record.summaryJson ? parseStoredSummaryMessage(record.summaryJson) : undefined,
    messages: parsedMessages,
    messageCount: record.messageCount,
    startMessageId: record.startMessageId,
    endMessageId: record.endMessageId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeWireRecord(
  record: ChatHistoryWireRecord,
  fallbackSystemPrompt?: string,
): ChatHistoryRecord {
  if (record.segments.length === 0) {
    throw new Error("历史对话缺少分段数据");
  }
  const meta = parseStoredChatContextMeta(record.contextMetaJson, fallbackSystemPrompt);
  const segments = record.segments.map(parseStoredSegment);
  const state: ConversationViewState = normalizeConversationState({ meta, segments });

  return {
    id: record.id,
    title: record.title,
    providerId: record.providerId,
    model: record.model,
    sessionId: record.sessionId,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    isPinned: record.isPinned,
    pinnedAt: record.pinnedAt,
    state,
  };
}

export async function listChatHistory(
  page: number,
  pageSize: number,
  filter?: ChatHistoryListFilter,
) {
  return invoke<ChatHistoryListPage>("chat_history_list", {
    page,
    pageSize,
    cwd: filter?.cwd,
    cwdEmpty: filter?.cwdEmpty,
  });
}

export async function listChatHistoryWorkdirs() {
  return invoke<ChatHistoryWorkdirsResponse>("chat_history_workdirs");
}

export async function getChatHistory(id: string, fallbackSystemPrompt?: string) {
  const record = await invoke<ChatHistoryWireRecord>("chat_history_get", { id });
  return normalizeWireRecord(record, fallbackSystemPrompt);
}

export async function getChatHistoryActiveSegment(
  id: string,
  fallbackSystemPrompt?: string,
) {
  const record = await invoke<ChatHistoryActiveSegmentWireRecord>(
    "chat_history_get_active_segment",
    { id },
  );
  if (!record.activeSegment) {
    throw new Error("历史对话缺少活跃分段");
  }

  return {
    id: record.id,
    title: record.title,
    providerId: record.providerId,
    model: record.model,
    sessionId: record.sessionId,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    isPinned: record.isPinned,
    pinnedAt: record.pinnedAt,
    meta: parseStoredChatContextMeta(record.contextMetaJson, fallbackSystemPrompt),
    activeSegment: parseStoredSegment(record.activeSegment),
  } satisfies ChatHistoryActiveSegmentRecord;
}

function enqueueConversationWrite<T>(
  conversationId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = conversationId.trim();
  if (!key) {
    return task();
  }

  const previous = conversationWriteQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  conversationWriteQueues.set(key, tail);
  return next.finally(() => {
    if (conversationWriteQueues.get(key) === tail) {
      conversationWriteQueues.delete(key);
    }
  });
}

function buildChatHistoryConversationInput(params: {
  conversationId: string;
  providerId: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  title: string;
  createdAt?: number;
  updatedAt: number;
  state: ConversationViewState;
}): ChatHistoryConversationInput {
  const {
    conversationId,
    providerId,
    model,
    sessionId,
    cwd,
    title,
    createdAt,
    updatedAt,
    state,
  } = params;

  return {
    id: conversationId,
    title,
    providerId,
    model,
    sessionId,
    cwd,
    contextMetaJson: JSON.stringify(state.meta),
    activeSegmentIndex: state.activeSegmentIndex,
    totalSegmentCount: state.meta.totalSegmentCount,
    totalMessageCount: state.meta.totalMessageCount,
    createdAt,
    updatedAt,
  };
}

function buildChatHistorySegmentInput(segment: StoredContextSegment): ChatHistorySegmentWireRecord {
  return {
    segmentIndex: segment.segmentIndex,
    segmentId: segment.segmentId,
    summaryJson: segment.summary ? JSON.stringify(segment.summary) : undefined,
    messagesJson: JSON.stringify(segment.messages),
    messageCount: segment.messageCount,
    startMessageId: segment.startMessageId,
    endMessageId: segment.endMessageId,
    createdAt: segment.createdAt,
    updatedAt: segment.updatedAt,
  };
}

export async function upsertChatHistory(input: ChatHistoryUpsertInput) {
  return enqueueConversationWrite(input.id, () =>
    invoke<ChatHistorySummary>("chat_history_upsert", { input }),
  );
}

async function upsertChatHistoryActiveSegment(input: ChatHistorySegmentMutationInput) {
  return enqueueConversationWrite(input.conversation.id, () =>
    invoke<ChatHistorySummary>("chat_history_upsert_active_segment", { input }),
  );
}

async function appendChatHistorySegment(input: ChatHistorySegmentMutationInput) {
  return enqueueConversationWrite(input.conversation.id, () =>
    invoke<ChatHistorySummary>("chat_history_append_segment", { input }),
  );
}

export async function renameChatHistory(id: string, title: string) {
  return enqueueConversationWrite(id, () =>
    invoke<ChatHistorySummary>("chat_history_rename", { id, title }),
  );
}

export async function deleteChatHistory(id: string) {
  return enqueueConversationWrite(id, async () => {
    await invoke<void>("chat_history_delete", { id });
  });
}

function segmentPrefixMatches(
  previous: StoredContextSegment[],
  next: StoredContextSegment[],
  count: number,
) {
  if (count < 0 || previous.length < count || next.length < count) return false;
  for (let index = 0; index < count; index += 1) {
    const prevSegment = previous[index];
    const nextSegment = next[index];
    if (
      prevSegment.segmentIndex !== nextSegment.segmentIndex ||
      prevSegment.segmentId !== nextSegment.segmentId ||
      prevSegment.messageCount !== nextSegment.messageCount ||
      prevSegment.startMessageId !== nextSegment.startMessageId ||
      prevSegment.endMessageId !== nextSegment.endMessageId ||
      prevSegment.createdAt !== nextSegment.createdAt ||
      prevSegment.updatedAt !== nextSegment.updatedAt ||
      prevSegment.summary?.id !== nextSegment.summary?.id
    ) {
      return false;
    }
  }
  return true;
}

type PersistConversationStateParams = {
  conversationId: string;
  providerId: string;
  model: string;
  sessionId?: string;
  cwd?: string;
  title: string;
  createdAt?: number;
  updatedAt: number;
  state: ConversationViewState;
  previousState?: ConversationViewState | null;
};

export async function persistConversationState(params: PersistConversationStateParams) {
  const conversation = buildChatHistoryConversationInput(params);
  const previousState = params.previousState ?? null;
  const nextState = params.state;

  if (!previousState) {
    return upsertChatHistory({
      ...conversation,
      segments: nextState.segments.map(buildChatHistorySegmentInput),
    });
  }

  const sameShape =
    previousState.activeSegmentIndex === nextState.activeSegmentIndex &&
    previousState.segments.length === nextState.segments.length;
  if (
    sameShape &&
    segmentPrefixMatches(
      previousState.segments,
      nextState.segments,
      Math.max(0, nextState.activeSegmentIndex),
    )
  ) {
    const activeSegment = nextState.segments[nextState.activeSegmentIndex];
    if (activeSegment) {
      return upsertChatHistoryActiveSegment({
        conversation,
        segment: buildChatHistorySegmentInput(activeSegment),
      });
    }
  }

  const appendShape =
    nextState.activeSegmentIndex === previousState.activeSegmentIndex + 1 &&
    nextState.segments.length === previousState.segments.length + 1;
  if (
    appendShape &&
    segmentPrefixMatches(
      previousState.segments,
      nextState.segments,
      previousState.segments.length,
    )
  ) {
    const appendedSegment = nextState.segments[nextState.activeSegmentIndex];
    if (appendedSegment) {
      return appendChatHistorySegment({
        conversation,
        segment: buildChatHistorySegmentInput(appendedSegment),
      });
    }
  }

  return upsertChatHistory({
    ...conversation,
    segments: nextState.segments.map(buildChatHistorySegmentInput),
  });
}
