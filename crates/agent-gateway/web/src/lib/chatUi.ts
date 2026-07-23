import type { Message, ToolCall, ToolResultMessage, Usage } from "@/lib/agentTypes";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import { type HostedSearchBlock, normalizeHostedSearchBlock } from "@/lib/chat/hostedSearch";

import { summarizeToolCall as summarizeDesktopToolCall, type UiRound } from "@/lib/chat/uiMessages";
import {
  getUserMessageAttachments,
  getUserMessageDisplayText,
  type PendingUploadedFile,
} from "@/lib/chat/uploadedFiles";
import { createUuid } from "@/lib/shared/id";

import type { ChatCheckpointPayload, ChatEvent, ConversationSummary } from "./gatewayTypes";

export type AssistantMeta = NonNullable<UiRound["meta"]>;

export type GatewayTranscriptRound = UiRound & {
  key: string;
  runningToolCallIds: string[];
  thinkingOpen?: boolean;
};

export type ChatEntry =
  | {
      id: string;
      kind: "user";
      text: string;
      attachments: PendingUploadedFile[];
      messageId?: string;
      messageRef?: HistoryMessageRef;
      timestamp?: number;
    }
  | {
      id: string;
      kind: "checkpoint";
      content: string;
      summaryId: string;
      coveredMessageCount: number;
      generatedBy: {
        providerId: string;
        model: string;
        promptVersion?: string;
      };
      timestamp?: number;
    }
  | {
      id: string;
      kind: "assistant";
      text: string;
      round?: number;
      meta?: AssistantMeta;
      timestamp?: number;
    }
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

type StoredMessage = {
  role?: unknown;
  id?: unknown;
  content?: unknown;
  details?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  provider?: unknown;
  model?: unknown;
  api?: unknown;
  stopReason?: unknown;
  usage?: unknown;
  timestamp?: unknown;
  summaryMeta?: unknown;
  liveAgentHistoryRef?: unknown;
};

function readMessageTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export type ToolCallLike = {
  id?: unknown;
  name?: unknown;
  toolCallId?: unknown;
  toolCallID?: unknown;
  tool_call_id?: unknown;
  call_id?: unknown;
  toolName?: unknown;
  tool_name?: unknown;
  arguments?: unknown;
  args?: unknown;
  input?: unknown;
  parameters?: unknown;
  toolCall?: unknown;
  payload?: unknown;
  data?: unknown;
};

type NormalizedAssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; toolCall: ToolCallLike }
  | { type: "hostedSearch"; hostedSearch: HostedSearchBlock };

type UploadedFilesUserMessage = Pick<Message, "role" | "content"> & Record<string, unknown>;

const LIVE_UPLOADED_FILE_KINDS = new Set<string>([
  "text",
  "image",
  "pdf",
  "notebook",
  "word",
  "spreadsheet",
  "archive",
]);

function randomId(prefix: string) {
  return `${prefix}-${createUuid()}`;
}

export function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function hashValue(value: unknown) {
  return hashText(safeStringify(value));
}

const DSML_TAG_PREFIX = String.raw`(?:\uFF5C{2}|\|{2})\s*DSML\s*(?:\uFF5C{2}|\|{2})`;
const DSML_TOOL_CALL_DISPLAY_PATTERN = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>[\s\S]*?(?:<\/\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>|$)`,
  "gi",
);

export function stripRecoveredToolCallMarkup(value: string) {
  if (
    !value.includes("<seed:tool_call>") &&
    !(value.includes("DSML") && value.includes("tool_calls"))
  ) {
    return value;
  }
  return value
    .replace(/<seed:tool_call>[\s\S]*?(?:<\/seed:tool_call>|$)/gi, "")
    .replace(DSML_TOOL_CALL_DISPLAY_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRound(value: unknown) {
  const round = readNumber(value);
  if (typeof round !== "number") return undefined;
  return round > 0 ? Math.floor(round) : undefined;
}

function normalizeLiveUploadedFile(value: unknown): PendingUploadedFile | null {
  const record = asNonArrayRecord(value);
  const relativePath = readString(record.relativePath ?? record.relative_path).trim();
  const fileName = readString(record.fileName ?? record.file_name).trim() || relativePath;
  const kind = readString(record.kind).trim();
  const sizeBytes = readNumber(record.sizeBytes ?? record.size_bytes) ?? 0;
  if (!relativePath || !fileName || !LIVE_UPLOADED_FILE_KINDS.has(kind)) {
    return null;
  }
  const absolutePath = readString(record.absolutePath ?? record.absolute_path).trim();
  const file: PendingUploadedFile = {
    relativePath,
    absolutePath: absolutePath || undefined,
    fileName,
    kind: kind as PendingUploadedFile["kind"],
    sizeBytes: Math.max(0, Math.floor(sizeBytes)),
  };
  const displayMode = readString(record.displayMode ?? record.display_mode).trim();
  if (displayMode === "largePaste") {
    file.displayMode = "largePaste";
  }
  const displayLabel = readString(record.displayLabel ?? record.display_label).trim();
  if (displayLabel) {
    file.displayLabel = displayLabel;
  }
  const displayCharCount = readNumber(record.displayCharCount ?? record.display_char_count);
  if (typeof displayCharCount === "number") {
    file.displayCharCount = Math.max(0, Math.floor(displayCharCount));
  }
  const displayLineCount = readNumber(record.displayLineCount ?? record.display_line_count);
  if (typeof displayLineCount === "number") {
    file.displayLineCount = Math.max(0, Math.floor(displayLineCount));
  }
  return file;
}

export function normalizeLiveUploadedFiles(value: unknown): PendingUploadedFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeLiveUploadedFile(item))
    .filter((file): file is PendingUploadedFile => file !== null);
}

function readHistoryMessageRef(value: unknown): HistoryMessageRef | undefined {
  const record = asRecord(value);
  const segmentIndex = readNumber(record.segmentIndex ?? record.segment_index);
  const messageIndex = readNumber(record.messageIndex ?? record.message_index);
  const segmentId = readString(record.segmentId ?? record.segment_id)?.trim();
  const messageId = readString(record.messageId ?? record.message_id)?.trim();
  const role = readString(record.role)?.trim();
  const contentHash = readString(record.contentHash ?? record.content_hash)?.trim();
  if (
    typeof segmentIndex !== "number" ||
    typeof messageIndex !== "number" ||
    segmentIndex < 0 ||
    messageIndex < 0 ||
    !segmentId ||
    !messageId ||
    !role ||
    !contentHash
  ) {
    return undefined;
  }
  return {
    segmentIndex: Math.floor(segmentIndex),
    messageIndex: Math.floor(messageIndex),
    segmentId,
    messageId,
    role,
    contentHash,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asNonArrayRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordHasEntries(value: Record<string, unknown>) {
  return Object.keys(value).length > 0;
}

function cloneJsonLikeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonLikeValue(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneJsonLikeValue(nestedValue);
    }
    return out;
  }
  return value;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cloneJsonLikeValue(value) as Record<string, unknown>;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim() === "") {
    return {};
  }
  try {
    return asNonArrayRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

export function normalizeToolArguments(...candidates: unknown[]): Record<string, unknown> {
  for (const candidate of candidates) {
    const direct = asNonArrayRecord(candidate);
    if (recordHasEntries(direct)) {
      return cloneRecord(direct);
    }
    const parsed = parseJsonRecord(candidate);
    if (recordHasEntries(parsed)) {
      return cloneRecord(parsed);
    }
  }
  return {};
}

export function normalizeToolCallLike(input: ToolCallLike): ToolCallLike {
  const record = asNonArrayRecord(input);
  const payloadRecord = asNonArrayRecord(record.payload);
  const dataObjectRecord = asNonArrayRecord(record.data);
  const dataJsonRecord = parseJsonRecord(record.data);
  const dataRecord = recordHasEntries(dataObjectRecord) ? dataObjectRecord : dataJsonRecord;
  const nestedToolCall = asNonArrayRecord(
    record.toolCall ?? payloadRecord.toolCall ?? dataRecord.toolCall,
  );
  const source = recordHasEntries(nestedToolCall)
    ? nestedToolCall
    : recordHasEntries(payloadRecord)
      ? payloadRecord
      : recordHasEntries(dataRecord)
        ? dataRecord
        : record;
  return {
    id:
      source.id ??
      source.toolCallId ??
      source.toolCallID ??
      source.tool_call_id ??
      source.call_id ??
      record.id,
    name: source.name ?? source.toolName ?? source.tool_name ?? record.name,
    arguments: normalizeToolArguments(
      source.arguments,
      source.args,
      source.input,
      source.parameters,
      payloadRecord.arguments,
      payloadRecord.args,
      payloadRecord.input,
      payloadRecord.parameters,
      dataRecord.arguments,
      dataRecord.args,
      dataRecord.input,
      dataRecord.parameters,
      record.arguments,
      record.args,
      record.input,
      record.parameters,
    ),
  };
}

function asUploadedFilesUserMessage(message: StoredMessage): UploadedFilesUserMessage {
  return {
    ...asRecord(message),
    role: "user",
    content: message.content as Message["content"],
  };
}

export function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getUsageTotalTokens(usage: unknown) {
  const record = asRecord(usage);
  const totalTokens = record.totalTokens;
  if (typeof totalTokens === "number") return totalTokens;
  const snakeCaseTotal = record.total_tokens;
  return typeof snakeCaseTotal === "number" ? snakeCaseTotal : undefined;
}

export function buildAssistantMeta(params: {
  provider?: unknown;
  model?: unknown;
  api?: unknown;
  stopReason?: unknown;
  usage?: unknown;
}) {
  const usage =
    params.usage && typeof params.usage === "object" ? (params.usage as Usage) : undefined;

  const meta: AssistantMeta = {
    provider: readString(params.provider) || undefined,
    model: readString(params.model) || undefined,
    api: readString(params.api) || undefined,
    stopReason: readString(params.stopReason) || undefined,
    usage,
    usageTotalTokens: getUsageTotalTokens(params.usage),
  };

  return Object.values(meta).some((value) => value !== undefined) ? meta : undefined;
}

export function normalizeCheckpointEntry(params: {
  id?: unknown;
  content?: unknown;
  timestamp?: unknown;
  summaryMeta?: unknown;
  checkpoint?: ChatCheckpointPayload;
  fallbackId?: string;
}) {
  const summaryMetaRecord = asRecord(params.summaryMeta);
  const generatedByRecord = asRecord(
    params.checkpoint?.generatedBy ?? summaryMetaRecord.generatedBy,
  );
  const content = readString(params.content).trim();
  if (content === "") {
    return null;
  }

  const summaryId =
    readString(params.id).trim() ||
    readString(params.checkpoint?.summaryId).trim() ||
    params.fallbackId ||
    randomId("checkpoint");
  const coveredMessageCountCandidate =
    typeof params.checkpoint?.coveredMessageCount === "number"
      ? params.checkpoint.coveredMessageCount
      : summaryMetaRecord.coveredMessageCount;
  const coveredMessageCount =
    typeof coveredMessageCountCandidate === "number" &&
    Number.isFinite(coveredMessageCountCandidate) &&
    coveredMessageCountCandidate > 0
      ? Math.floor(coveredMessageCountCandidate)
      : 0;
  const providerId = readString(generatedByRecord.providerId).trim() || "liveagent";
  const model = readString(generatedByRecord.model).trim() || "summary";
  const promptVersion = readString(generatedByRecord.promptVersion).trim() || undefined;
  const timestamp =
    readNumber(params.checkpoint?.timestamp) ?? readNumber(params.timestamp) ?? Date.now();

  return {
    id: `checkpoint-${summaryId}`,
    kind: "checkpoint" as const,
    content,
    summaryId,
    coveredMessageCount,
    generatedBy: {
      providerId,
      model,
      promptVersion,
    },
    timestamp,
  };
}

export function isCheckpointTokenEvent(event: Extract<ChatEvent, { type: "token" }>) {
  return Boolean(
    event.checkpoint ||
      event.api === "liveagent-compaction" ||
      (event.provider === "liveagent" && event.model === "summary"),
  );
}

function normalizeToolCall(toolCall: ToolCallLike, fallbackId: string): ToolCall {
  const normalized = normalizeToolCallLike(toolCall);
  const id = readString(normalized.id).trim() || fallbackId;
  const name = readString(normalized.name).trim() || "Tool";
  return {
    type: "toolCall",
    id,
    name,
    arguments: normalizeToolArguments(normalized.arguments),
  } as ToolCall;
}

function normalizeToolResultContentBlock(block: unknown): ToolResultMessage["content"][number][] {
  if (typeof block === "string") {
    return block === "" ? [] : ([{ type: "text", text: block }] as ToolResultMessage["content"]);
  }

  const record = asRecord(block);
  const type = readString(record.type);
  if (type === "text") {
    return [{ type: "text", text: readString(record.text) }] as ToolResultMessage["content"];
  }
  if (type === "image" && typeof record.mimeType === "string" && typeof record.data === "string") {
    return [
      {
        type: "image",
        mimeType: record.mimeType,
        data: record.data,
      },
    ] as ToolResultMessage["content"];
  }

  if (Object.keys(record).length === 0) {
    return [];
  }

  return [{ type: "text", text: safeStringify(record) }] as ToolResultMessage["content"];
}

function normalizeToolResultContent(content: unknown): ToolResultMessage["content"] {
  if (Array.isArray(content)) {
    return content.flatMap((block) => normalizeToolResultContentBlock(block));
  }
  return normalizeToolResultContentBlock(content) as ToolResultMessage["content"];
}

function buildToolResult(params: {
  toolCallId?: unknown;
  toolName?: unknown;
  content?: unknown;
  details?: unknown;
  isError?: unknown;
  timestamp?: unknown;
  fallbackToolCallId?: string;
}) {
  const toolCallId =
    readString(params.toolCallId).trim() || params.fallbackToolCallId || randomId("tool-result");
  const toolName = readString(params.toolName).trim() || "Tool";
  const timestamp = readNumber(params.timestamp) ?? Date.now();

  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: normalizeToolResultContent(params.content),
    details: params.details,
    isError: Boolean(params.isError),
    timestamp,
  } as ToolResultMessage;
}

function summarizeToolCall(toolCall: ToolCall) {
  return summarizeDesktopToolCall(toolCall);
}

function getTextFromContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  let text = "";
  for (const block of content) {
    const record = asRecord(block);
    if (readString(record.type) === "text") {
      text += readString(record.text);
    }
  }
  return text;
}

export function getToolResultText(content: unknown) {
  const directText = getTextFromContent(content);
  if (directText.trim() !== "") return directText;

  if (typeof content === "string") {
    return content;
  }

  if (content === undefined) {
    return "";
  }

  return safeStringify(content);
}

function normalizeAssistantBlocks(content: unknown): NormalizedAssistantBlock[] {
  if (typeof content === "string") {
    const text = stripRecoveredToolCallMarkup(content);
    return text.trim() ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: NormalizedAssistantBlock[] = [];
  for (const block of content) {
    const record = asRecord(block);
    const type = readString(record.type);
    if (type === "text") {
      const text = stripRecoveredToolCallMarkup(readString(record.text));
      if (text !== "") {
        blocks.push({ type: "text", text });
      }
      continue;
    }
    if (type === "thinking") {
      const text = stripRecoveredToolCallMarkup(readString(record.thinking));
      if (text !== "") {
        blocks.push({ type: "thinking", text });
      }
      continue;
    }
    if (type === "toolCall" || type === "tool_use") {
      blocks.push({
        type: "toolCall",
        toolCall: normalizeToolCallLike(record),
      });
      continue;
    }
    const hostedSearch = normalizeHostedSearchBlock(record);
    if (hostedSearch) {
      blocks.push({
        type: "hostedSearch",
        hostedSearch,
      });
    }
  }
  return blocks;
}

export function buildToolCallEntry(
  toolCall: ToolCallLike,
  round?: number,
  options?: {
    entryId?: string;
    fallbackToolCallId?: string;
  },
): ChatEntry {
  const normalizedToolCall = normalizeToolCall(
    toolCall,
    options?.fallbackToolCallId ?? randomId("tool-call"),
  );
  return {
    id: options?.entryId ?? randomId("tool-call"),
    kind: "tool_call",
    round,
    toolCall: normalizedToolCall,
    summary: summarizeToolCall(normalizedToolCall),
    text: safeStringify(normalizedToolCall.arguments),
  };
}

export function buildToolResultEntry(
  message: StoredMessage,
  round?: number,
  options?: {
    entryId?: string;
    fallbackToolCallId?: string;
  },
): ChatEntry {
  const toolResult = buildToolResult({
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    details: message.details,
    isError: message.isError,
    timestamp: message.timestamp,
    fallbackToolCallId: options?.fallbackToolCallId,
  });
  return {
    id: options?.entryId ?? randomId("tool-result"),
    kind: "tool_result",
    round,
    toolResult,
    summary: toolResult.toolName ? `${toolResult.toolName} 执行结果` : "工具执行结果",
    text: getToolResultText(message.content),
  };
}

export function buildHostedSearchEntry(
  hostedSearch: HostedSearchBlock,
  round?: number,
  options?: { entryId?: string },
): ChatEntry {
  return {
    id: options?.entryId ?? randomId("hosted-search"),
    kind: "hosted_search",
    round,
    hostedSearch,
  };
}

export function formatLiveErrorMessage(message: string, prefix: boolean) {
  if (!prefix || message === "Request failed") {
    return message;
  }
  return message.startsWith("Request failed:") || message.startsWith("Request failed：")
    ? message
    : `Request failed: ${message}`;
}

export function parseHistoryMessagesJson(raw: string): ChatEntry[] {
  if (raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    const text = `历史消息解析失败：${message}`;
    return [{ id: `history-error:${hashText(text)}`, kind: "error", text }];
  }

  if (!Array.isArray(parsed)) {
    const text = "历史消息载荷不是数组，无法渲染。";
    return [{ id: `history-error:${hashText(text)}`, kind: "error", text }];
  }

  const entries: ChatEntry[] = [];
  const usedUserIds = new Map<string, number>();
  let currentRound = 0;
  // Turn anchor: the current user entry's id ("h:^" for a window that starts
  // mid-turn) plus a per-turn block counter for every non-user entry.
  let turnKey = "ht:^";
  let turnEntrySeq = 0;
  const nextEntryId = () => `${turnKey}>${turnEntrySeq++}`;

  for (const item of parsed) {
    const message = asRecord(item) as StoredMessage;
    const role = readString(message.role);

    if (role === "user") {
      currentRound = 0;
      const userRecord = asUploadedFilesUserMessage(message);
      const text = getUserMessageDisplayText(userRecord);
      const attachments = getUserMessageAttachments(userRecord);
      const messageRef = readHistoryMessageRef(userRecord.liveAgentHistoryRef);
      if (text.trim() || attachments.length > 0) {
        const baseId = messageRef ? `hu:${messageRef.messageId}` : `hu:~${hashText(text)}`;
        const occurrence = usedUserIds.get(baseId) ?? 0;
        usedUserIds.set(baseId, occurrence + 1);
        const id = occurrence === 0 ? baseId : `${baseId}:${occurrence}`;
        turnKey = `ht:${id}`;
        turnEntrySeq = 0;
        entries.push({
          id,
          kind: "user",
          text,
          attachments,
          messageId: messageRef?.messageId,
          messageRef,
          timestamp: readMessageTimestamp(message.timestamp),
        });
      }
      continue;
    }

    if (role === "summary") {
      const checkpoint = normalizeCheckpointEntry({
        id: message.id,
        content: message.content,
        timestamp: message.timestamp,
        summaryMeta: message.summaryMeta,
        fallbackId: nextEntryId(),
      });
      if (checkpoint) {
        entries.push(checkpoint);
      }
      continue;
    }

    if (role === "assistant") {
      currentRound += 1;
      const round = currentRound;
      const messageTimestamp = readMessageTimestamp(message.timestamp);
      const blocks = normalizeAssistantBlocks(message.content);
      const meta = buildAssistantMeta({
        provider: message.provider,
        model: message.model,
        api: message.api,
        stopReason: message.stopReason,
        usage: message.usage,
      });
      let textBuffer = "";
      let metaEmitted = false;

      const flushText = () => {
        if (textBuffer === "" && (!meta || metaEmitted)) return;
        entries.push({
          id: nextEntryId(),
          kind: "assistant",
          text: textBuffer,
          round,
          meta: metaEmitted ? undefined : meta,
          timestamp: messageTimestamp,
        });
        textBuffer = "";
        if (meta) {
          metaEmitted = true;
        }
      };

      for (const block of blocks) {
        if (block.type === "text") {
          textBuffer += block.text;
          continue;
        }

        flushText();

        if (block.type === "thinking" && block.text.trim()) {
          entries.push({
            id: nextEntryId(),
            kind: "thinking",
            round,
            text: block.text,
          });
        }

        if (block.type === "toolCall") {
          const entryId = nextEntryId();
          entries.push(
            buildToolCallEntry(block.toolCall, round, {
              entryId,
              fallbackToolCallId: entryId,
            }),
          );
        }

        if (block.type === "hostedSearch") {
          entries.push(
            buildHostedSearchEntry(block.hostedSearch, round, { entryId: nextEntryId() }),
          );
        }
      }

      flushText();
      continue;
    }

    if (role === "toolResult") {
      const entryId = nextEntryId();
      entries.push(
        buildToolResultEntry(message, currentRound || 1, {
          entryId,
          fallbackToolCallId: entryId,
        }),
      );
    }
  }

  return entries;
}

export function isMatchingToolCallEntry(
  entry: ChatEntry,
  params: {
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
    round?: number;
  },
) {
  if (entry.kind !== "tool_call") {
    return false;
  }
  if (params.round !== undefined && entry.round !== params.round) {
    return false;
  }

  const toolCallId = readString(params.id).trim();
  if (toolCallId !== "") {
    return entry.toolCall.id === toolCallId;
  }

  const toolName = readString(params.name).trim();
  if (toolName === "" || entry.toolCall.name !== toolName) {
    return false;
  }

  return safeStringify(entry.toolCall.arguments) === safeStringify(asRecord(params.arguments));
}

export function isMatchingToolResultEntry(
  entry: ChatEntry,
  params: {
    toolCallId?: unknown;
    toolName?: unknown;
    content?: unknown;
    isError?: unknown;
    round?: number;
  },
) {
  if (entry.kind !== "tool_result") {
    return false;
  }
  if (params.round !== undefined && entry.round !== params.round) {
    return false;
  }

  const toolCallId = readString(params.toolCallId).trim();
  if (toolCallId !== "") {
    return entry.toolResult.toolCallId === toolCallId;
  }

  const toolName = readString(params.toolName).trim();
  if (toolName === "" || entry.toolResult.toolName !== toolName) {
    return false;
  }
  if (Boolean(entry.toolResult.isError) !== Boolean(params.isError)) {
    return false;
  }

  return getToolResultText(entry.toolResult.content) === getToolResultText(params.content);
}

export function formatConversationTitle(
  conversation?: Pick<ConversationSummary, "title" | "id"> | null,
  fallbackId?: string,
) {
  const title = conversation?.title?.trim();
  if (title) return title;
  if (fallbackId?.trim()) return `会话 ${fallbackId.slice(0, 8)}`;
  return "新对话";
}

export function resolveConversationBrowserTitle(params: {
  conversation?: Pick<ConversationSummary, "title" | "id"> | null;
  conversationId?: string | null;
  projectName?: string | null;
  isLocalDraftConversation?: boolean;
  newConversationTitle: string;
}) {
  const conversationId = params.conversationId?.trim() ?? "";
  const newConversationTitle = params.newConversationTitle.trim() || "LiveAgent";
  if (!conversationId || params.isLocalDraftConversation) {
    return newConversationTitle;
  }
  if (params.conversation) {
    return formatConversationTitle(params.conversation, conversationId);
  }
  const projectName = params.projectName?.trim() ?? "";
  return projectName || formatConversationTitle(null, conversationId);
}

export function buildOptimisticConversationTitle(message: string) {
  const firstParagraph = message
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .find((paragraph) => paragraph !== "");
  if (!firstParagraph) {
    return "新对话";
  }
  return Array.from(firstParagraph).slice(0, 10).join("");
}
