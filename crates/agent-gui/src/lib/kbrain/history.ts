import type {
  AssistantMessage,
  FileContent,
  ImageContent,
  Message,
  TextContent,
} from "@liveagent/app/lib/agentTypes";
import type { HostedSearchBlock } from "@liveagent/ui/lib/chat/hostedSearch";
import {
  type ConversationViewState,
  getHistoryMessageContentHash,
  type HistoryMessageRef,
  type StoredContextSegment,
  type TranscriptSegmentSlice,
} from "../chat/conversation/conversationState";
import type {
  ChatHistoryListFilter,
  ChatHistoryListPage,
  ChatHistoryShareStatus,
  ChatHistorySummary,
  ChatHistoryWindowRecord,
  ConversationPersistenceCursor,
} from "../chat/history/chatHistory";
import { createKBrainClient } from "./client";
import {
  clearKBrainSessionId,
  ensureKBrainConversationId,
  getKBrainConversationId,
  getKBrainSessionId,
  setKBrainSessionId,
} from "./mapping";
import { questionResultDetails } from "./questions";
import { getConfiguredKBrainConnection } from "./runtimeConnection";
import { contextToKBrainMessages } from "./turn";
import type {
  KBrainHistoryResponse,
  KBrainMessage,
  KBrainMessageRef,
  KBrainModelRef,
  KBrainSession,
} from "./types";

const KBRAIN_API = "kbrain.agent.v1" as AssistantMessage["api"];

function baseUrl() {
  return getConfiguredKBrainConnection()?.baseUrl;
}

function client() {
  return createKBrainClient();
}

function epoch(value: string | number | undefined, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function modelJson(model: KBrainModelRef) {
  return JSON.stringify({ customProviderId: model.provider, model: model.model });
}

function contentText(message: KBrainMessage) {
  return (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function userContent(
  message: KBrainMessage,
): string | (TextContent | ImageContent | FileContent)[] {
  const content: (TextContent | ImageContent | FileContent)[] = [];
  for (const block of message.content ?? []) {
    if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
    if (block.type === "image" && block.image_url && block.mime_type) {
      content.push({ type: "image", data: block.image_url, mimeType: block.mime_type });
    }
    if (block.type === "file" && block.file_url && block.mime_type) {
      content.push({
        type: "file",
        data: block.file_url,
        mimeType: block.mime_type,
        ...(block.filename ? { filename: block.filename } : {}),
      });
    }
  }
  return content.length === 1 && content[0]?.type === "text" ? content[0].text : content;
}

function historyStopReason(reason: string | undefined): AssistantMessage["stopReason"] {
  switch (reason) {
    case "cancelled":
    case "aborted":
      return "aborted";
    case "tool_use":
    case "toolUse":
      return "toolUse";
    case "length":
    case "error":
    case "deferred":
      return reason;
    default:
      return "stop";
  }
}

function toHostedSearch(value: KBrainMessage["hosted_search"]): HostedSearchBlock[] {
  return (value ?? []).map((search) => ({
    type: "hostedSearch" as const,
    id: search.id,
    provider: search.provider,
    status: search.status,
    queries: search.queries,
    sources: search.sources,
  }));
}

function toMessage(message: KBrainMessage, index: number): Message | null {
  const timestamp = epoch(message.created_at, index + 1);
  if (message.role === "user") {
    return {
      role: "user",
      content: userContent(message),
      timestamp,
      ...(message.id ? { id: message.id } : {}),
    } as Message;
  }
  if (message.role === "tool") {
    const converted = userContent(message);
    const content =
      typeof converted === "string" ? [{ type: "text" as const, text: converted }] : converted;
    return {
      role: "toolResult",
      toolCallId: message.tool_call_id || `kbrain-tool-${index}`,
      toolName: message.name || "tool",
      content,
      details: questionResultDetails(
        message.name,
        content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ),
      isError: message.stop_reason === "error" || message.stop_reason === "cancelled",
      timestamp,
    };
  }
  if (message.role !== "assistant") return null;
  const content: AssistantMessage["content"] = [];
  for (const block of message.content ?? []) {
    if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
    if (block.type === "thinking" && block.text)
      content.push({ type: "thinking", thinking: block.text });
  }
  content.push(...toHostedSearch(message.hosted_search));
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: (call.arguments ?? {}) as Record<string, unknown>,
    });
  }
  return {
    role: "assistant",
    content,
    api: KBRAIN_API,
    provider: message.provider || "kbrain",
    model: message.model || "unknown",
    responseId: message.id,
    ...(message.id ? { id: message.id } : {}),
    usage: {
      input: message.usage?.input_tokens ?? 0,
      output: message.usage?.output_tokens ?? 0,
      cacheRead: message.usage?.cached_tokens ?? 0,
      cacheWrite: message.usage?.cache_write_tokens ?? 0,
      totalTokens: (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: historyStopReason(message.stop_reason),
    timestamp,
  };
}

function taskMessages(session: KBrainSession, offset: number): Message[] {
  const messages: Message[] = [];
  const seen = new Set<string>();
  for (const task of session.tasks ?? []) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const id = `kbrain-subagent:${task.id}`;
    const assistant = toMessage(
      {
        id,
        role: "assistant",
        model: task.model.model,
        provider: task.model.provider,
        created_at: task.updated_at ?? task.started_at,
        tool_calls: [
          {
            id,
            name: "subagent",
            arguments: {
              id: task.id,
              description: task.description,
              status: task.status,
              model: task.model,
              parent_id: task.parent_id,
            },
          },
        ],
      },
      offset + messages.length,
    );
    if (assistant) messages.push(assistant);
    if (["done", "completed", "error", "failed", "cancelled"].includes(task.status)) {
      messages.push({
        role: "toolResult",
        toolCallId: id,
        toolName: "subagent",
        content: [{ type: "text", text: task.error || task.report || task.status }],
        isError: !["done", "completed"].includes(task.status),
        timestamp: epoch(task.ended_at ?? task.updated_at, epoch(session.updated_at)),
      });
    }
  }
  return messages;
}

function attachTaskMessages(messages: Message[], tasks: Message[]): Message[] {
  let lastAssistant = -1;
  let lastUser = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") lastAssistant = index;
    if (message.role === "user") lastUser = index;
  }
  if (lastAssistant < lastUser || lastAssistant < 0) return tasks;
  const assistant = messages[lastAssistant] as AssistantMessage;
  const knownCalls = new Set(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
        : [],
    ),
  );
  const calls = tasks.flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter((block) => block.type === "toolCall" && !knownCalls.has(block.id))
      : [],
  );
  const addedIds = new Set(calls.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])));
  // Task metadata shares the final round so it cannot replace the parent's visible answer.
  messages[lastAssistant] = { ...assistant, content: [...calls, ...assistant.content] };
  return tasks.filter(
    (message) => message.role === "toolResult" && addedIds.has(message.toolCallId),
  );
}

function summaryForSession(session: KBrainSession, conversationId: string): ChatHistorySummary {
  const createdAt = epoch(session.created_at);
  return {
    id: conversationId,
    title: session.title?.trim() || "K-brain session",
    providerId: session.model.provider,
    model: session.model.model,
    sessionId: session.id,
    cwd: session.cwd,
    selectedModelJson: modelJson(session.model),
    messageCount: session.total_message_count ?? session.message_count,
    createdAt,
    updatedAt: epoch(session.updated_at, createdAt),
    isPinned: session.pinned,
    isShared: session.shared,
  };
}

type ProjectionSnapshot = {
  revision: string;
  indices: Map<string, number>;
  taskMessageCount?: number;
};
const projections = new Map<string, ProjectionSnapshot>();

function backendIdFor(id: string): string {
  const backendId = getKBrainSessionId(id.trim(), baseUrl());
  if (!backendId) throw new Error(`K-brain session mapping not found for conversation ${id}`);
  return backendId;
}

function revisionFor(session: KBrainSession): string {
  if (!session.revision) throw new Error("K-brain session has no history revision");
  return session.revision;
}

function convertMessages(messages: KBrainMessage[], offset = 0): Message[] {
  return messages.flatMap((message, index) => {
    const converted = toMessage(message, offset + index);
    return converted ? [converted] : [];
  });
}

function historyWindow(
  localId: string,
  result: KBrainHistoryResponse,
  includeActive: boolean,
  newest: boolean,
  pendingEditId?: string,
): ChatHistoryWindowRecord {
  const session = result.session;
  if (!result.revision) throw new Error("K-brain history has no revision");
  if (includeActive && !result.active_messages) {
    throw new Error("K-brain history has no full active context");
  }
  const createdAt = epoch(session.created_at);
  const updatedAt = epoch(session.updated_at, createdAt);
  const segmentId = `kbrain:${session.id}`;
  const source = session.messages ?? [];
  const offsets = result.message_offsets ?? source.map((_, index) => result.oldest_offset + index);
  if (
    offsets.length !== source.length ||
    offsets.some(
      (offset, index) =>
        !Number.isSafeInteger(offset) || offset < 0 || (index > 0 && offset <= offsets[index - 1]),
    )
  ) {
    throw new Error("K-brain history message_offsets are invalid");
  }
  const indexedMessages = source.flatMap((message, index) => {
    const offset = offsets[index];
    const converted = toMessage(message, offset);
    return converted ? [{ message: converted, offset }] : [];
  });
  const taskOffset = (offsets.at(-1) ?? result.oldest_offset - 1) + 1;
  const tasks = taskMessages(session, taskOffset);
  const windowMessages = indexedMessages.map(({ message }) => message);
  const snapshotKey = `${baseUrl() ?? ""}:${localId}`;
  let snapshot = projections.get(snapshotKey);
  if (snapshot?.revision !== result.revision) {
    snapshot = { revision: result.revision, indices: new Map() };
    projections.set(snapshotKey, snapshot);
  }
  for (const { message, offset } of indexedMessages) {
    const id = (message as { id?: string }).id;
    if (id) snapshot.indices.set(id, offset);
  }
  const activeMessages = includeActive ? convertMessages(result.active_messages ?? []) : [];
  if (pendingEditId) {
    for (const message of [...windowMessages, ...activeMessages]) {
      if (message.role === "user" && (message as { id?: string }).id === pendingEditId) {
        Object.assign(message, { kbrainEditPending: true });
      }
    }
  }
  const activeTasks = includeActive ? attachTaskMessages(activeMessages, tasks) : [];
  let projectedTasks: Message[] = [];
  if (newest) {
    projectedTasks = attachTaskMessages(windowMessages, tasks);
    for (const [index, message] of windowMessages.entries())
      indexedMessages[index].message = message;
    indexedMessages.push(
      ...projectedTasks.map((message, index) => ({ message, offset: taskOffset + index })),
    );
    windowMessages.push(...projectedTasks);
    snapshot.taskMessageCount = projectedTasks.length;
  }
  // Each slice is contiguous; gaps and filtered canonical rows retain their raw offsets.
  const segments: TranscriptSegmentSlice[] = [];
  for (const { message, offset } of indexedMessages) {
    const previous = segments.at(-1);
    if (previous && previous.startMessageIndex + previous.messages.length === offset) {
      previous.messages.push(message);
    } else {
      segments.push({
        segmentIndex: 0,
        segmentId,
        messages: [message],
        startMessageIndex: offset,
        createdAt,
        updatedAt,
      });
    }
  }
  const activeSegment: StoredContextSegment | undefined = includeActive
    ? {
        segmentIndex: 0,
        segmentId,
        messages: [...activeMessages, ...activeTasks],
        messageCount: activeMessages.length + activeTasks.length,
        createdAt,
        updatedAt,
      }
    : undefined;
  const totalMessageCount =
    result.total_message_count + (snapshot.taskMessageCount ?? tasks.length);
  return {
    conversation: { ...summaryForSession(session, localId), messageCount: totalMessageCount },
    meta: {
      schemaVersion: 3,
      systemPrompt:
        result.active_messages
          ?.filter((message) => message.role === "system" || message.role === "developer")
          .map(contentText)
          .join("\n\n") || undefined,
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount,
    },
    segments,
    activeSegment,
    returnedMessageCount: windowMessages.length,
    oldestOffset: result.oldest_offset,
    hasMoreBefore: result.has_more_before,
    revision: result.revision,
    updatedAt,
  };
}

export async function listKBrainHistory(
  page: number,
  pageSize: number,
  filter?: ChatHistoryListFilter,
  shared?: boolean,
): Promise<ChatHistoryListPage> {
  const result = await client().listSessions({
    page,
    pageSize,
    cwd: filter?.cwd,
    cwdEmpty: filter?.cwdEmpty,
    shared,
  });
  const items = result.sessions.map((session) => {
    const localId = ensureKBrainConversationId(session.id, baseUrl());
    setKBrainSessionId(localId, session.id, baseUrl());
    return summaryForSession(session, localId);
  });
  return { items, totalCount: result.total_count };
}

export async function getKBrainHistoryWindow(
  id: string,
  params: {
    maxMessages?: number;
    beforeOffset?: number;
    expectedRevision?: string;
    includeActive?: boolean;
  } = {},
): Promise<ChatHistoryWindowRecord> {
  const localId = id.trim();
  const backendId = getKBrainSessionId(localId, baseUrl());
  if (!backendId) throw new Error(`K-brain session mapping not found for conversation ${localId}`);
  const result = await client().getHistory(backendId, {
    maxMessages: params.maxMessages ?? 360,
    beforeOffset: params.beforeOffset,
    expectedRevision: params.expectedRevision,
    includeActive: params.includeActive ?? true,
  });
  setKBrainSessionId(localId, result.session.id, baseUrl());
  if (params.expectedRevision !== undefined && result.revision !== params.expectedRevision) {
    throw new Error("K-brain history revision conflict");
  }
  return historyWindow(
    localId,
    result,
    params.includeActive ?? true,
    params.beforeOffset === undefined,
  );
}

function refPayload(ref: HistoryMessageRef): KBrainMessageRef {
  return {
    segment_index: ref.segmentIndex,
    message_index: ref.messageIndex,
    segment_id: ref.segmentId,
    message_id: ref.messageId,
    role: ref.role,
    content_hash: ref.contentHash,
  };
}

async function validateRef(id: string, ref: HistoryMessageRef, expectedRevision?: string) {
  const backendId = backendIdFor(id);
  const snapshot = projections.get(`${baseUrl() ?? ""}:${id.trim()}`);
  const current = await client().getSession(backendId);
  const revision = revisionFor(current);
  const expected = expectedRevision ?? snapshot?.revision;
  if (!expected || revision !== expected)
    throw new Error("K-brain history revision conflict; reload the conversation");
  const messages = convertMessages(current.messages ?? []);
  const index = messages.findIndex((message) => (message as { id?: string }).id === ref.messageId);
  const message = messages[index];
  const projectedIndex =
    snapshot?.revision === expected ? snapshot.indices.get(ref.messageId) : undefined;
  if (
    ref.segmentIndex !== 0 ||
    ref.segmentId !== `kbrain:${backendId}` ||
    !message ||
    ref.role !== "user" ||
    message.role !== ref.role ||
    projectedIndex === undefined ||
    ref.messageIndex !== projectedIndex ||
    getHistoryMessageContentHash(message) !== ref.contentHash
  ) {
    throw new Error(
      "K-brain history message reference is stale or does not match the current projection",
    );
  }
  return { session: current, revision };
}

export async function setKBrainHistoryModel(
  id: string,
  selectedModelJson: string,
): Promise<ChatHistorySummary> {
  const localId = id.trim();
  const backendId = getKBrainSessionId(localId, baseUrl());
  if (!backendId) throw new Error(`K-brain session mapping not found for conversation ${localId}`);
  let parsed: { customProviderId?: unknown; model?: unknown };
  try {
    parsed = JSON.parse(selectedModelJson) as { customProviderId?: unknown; model?: unknown };
  } catch {
    throw new Error("K-brain model selection is invalid");
  }
  if (
    !parsed ||
    typeof parsed.customProviderId !== "string" ||
    !parsed.customProviderId.trim() ||
    typeof parsed.model !== "string" ||
    !parsed.model.trim()
  )
    throw new Error("K-brain model selection is invalid");
  const session = await client().updateSession(backendId, {
    model: { provider: parsed.customProviderId, model: parsed.model },
  });
  setKBrainSessionId(localId, session.id, baseUrl());
  return summaryForSession(session, localId);
}

export async function renameKBrainHistory(id: string, title: string): Promise<ChatHistorySummary> {
  const localId = id.trim();
  const backendId = getKBrainSessionId(localId, baseUrl());
  if (!backendId) throw new Error(`K-brain session mapping not found for conversation ${localId}`);
  const session = await client().updateSession(backendId, { title: title.trim() });
  return summaryForSession(session, localId);
}

export async function setKBrainHistoryPinned(
  id: string,
  pinned: boolean,
): Promise<ChatHistorySummary> {
  const localId = id.trim();
  const backendId = getKBrainSessionId(localId, baseUrl());
  if (!backendId) throw new Error(`K-brain session mapping not found for conversation ${localId}`);
  return summaryForSession(await client().updateSession(backendId, { pinned }), localId);
}

export async function setKBrainHistoryCwd(id: string, cwd: string): Promise<ChatHistorySummary> {
  const localId = id.trim();
  const backendId = getKBrainSessionId(localId, baseUrl());
  if (!backendId) throw new Error(`K-brain session mapping not found for conversation ${localId}`);
  return summaryForSession(await client().updateSession(backendId, { cwd }), localId);
}

export async function deleteKBrainHistory(id: string): Promise<void> {
  const localId = id.trim();
  const backendId = getKBrainSessionId(localId, baseUrl());
  if (!backendId) throw new Error(`K-brain session mapping not found for conversation ${localId}`);
  const result = await client().deleteSession(backendId);
  if (result.ok !== true) throw new Error("K-brain session deletion was not confirmed");
  clearKBrainSessionId(localId, baseUrl());
  projections.delete(`${baseUrl() ?? ""}:${localId}`);
}

export async function branchKBrainHistory(
  id: string,
  ref: HistoryMessageRef,
  title?: string,
): Promise<ChatHistorySummary> {
  const localId = id.trim();
  const backendId = getKBrainSessionId(localId, baseUrl());
  if (!backendId) throw new Error(`K-brain session mapping not found for conversation ${localId}`);
  const current = await validateRef(localId, ref);
  const session = await client().branchSession(backendId, {
    message_ref: refPayload(ref),
    expected_revision: current.revision,
    ...(title === undefined ? {} : { title }),
  });
  const childId = ensureKBrainConversationId(session.id, baseUrl());
  setKBrainSessionId(childId, session.id, baseUrl());
  return summaryForSession(session, childId);
}

export async function editKBrainHistory(
  id: string,
  ref: HistoryMessageRef,
  replacementMessage: Message,
  expectedRevision: string,
  maxMessages: number,
): Promise<ChatHistoryWindowRecord> {
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 10000)
    throw new Error("K-brain maxMessages must be between 1 and 10000");
  if (replacementMessage.role !== "user")
    throw new Error("K-brain replacement must be a user message");
  const localId = id.trim();
  const backendId = backendIdFor(localId);
  await validateRef(localId, ref, expectedRevision);
  const replacement = contextToKBrainMessages({ messages: [replacementMessage] })[0];
  if (!replacement) throw new Error("K-brain replacement is empty");
  const session = await client().editSession(backendId, {
    message_ref: refPayload(ref),
    replacement,
    expected_revision: expectedRevision,
  });
  const messages = session.messages ?? [];
  const pending = messages.at(-1);
  if (pending?.role !== "user" || !pending.id)
    throw new Error("K-brain edit response has no pending user message");
  const result = await client().getHistory(backendId, {
    maxMessages,
    expectedRevision: revisionFor(session),
    includeActive: true,
  });
  if (result.revision !== session.revision) throw new Error("K-brain history revision conflict");
  return historyWindow(localId, result, true, true, pending.id);
}

export async function getKBrainHistoryShare(id: string): Promise<ChatHistoryShareStatus> {
  const backendId = getKBrainSessionId(id.trim(), baseUrl());
  if (!backendId) throw new Error(`K-brain session mapping not found for conversation ${id}`);
  const share = await client().getShare(backendId);
  return {
    conversationId: id.trim(),
    enabled: share.enabled,
    token: share.token,
    createdAt: epoch(share.created_at, 0),
    updatedAt: epoch(share.updated_at, 0),
    redactToolContent: share.redact_tool_content,
  };
}

export async function setKBrainHistoryShare(
  id: string,
  enabled: boolean,
  options?: { redactToolContent?: boolean },
): Promise<ChatHistoryShareStatus> {
  const backendId = getKBrainSessionId(id.trim(), baseUrl());
  if (!backendId) throw new Error(`K-brain session mapping not found for conversation ${id}`);
  const share = await client().setShare(backendId, {
    enabled,
    ...(options?.redactToolContent === undefined
      ? {}
      : { redact_tool_content: options.redactToolContent }),
  });
  return {
    conversationId: id.trim(),
    enabled: share.enabled,
    token: share.token,
    createdAt: epoch(share.created_at, 0),
    updatedAt: epoch(share.updated_at, 0),
    redactToolContent: share.redact_tool_content,
  };
}

export function getKBrainHistoryPersistenceCursor(
  state: ConversationViewState,
): ConversationPersistenceCursor {
  const active = state.segments[state.activeSegmentIndex];
  return {
    activeSegmentIndex: active?.segmentIndex ?? 0,
    activeSegmentId: active?.segmentId ?? "kbrain",
  };
}

export function resolveKBrainLocalId(backendId: string): string {
  return (
    getKBrainConversationId(backendId, baseUrl()) ??
    ensureKBrainConversationId(backendId, baseUrl())
  );
}
