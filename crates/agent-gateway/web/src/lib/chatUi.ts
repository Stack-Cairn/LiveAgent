import type { Message, ToolCall, ToolResultMessage, Usage } from "@/lib/agentTypes";
import { isAbortLikeError } from "@/lib/chat/chatPageHelpers";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import {
  getUserMessageAttachments,
  getUserMessageDisplayText,
  type PendingUploadedFile,
  uploadedFilesVisuallyEqual,
} from "@/lib/chat/uploadedFiles";

import {
  appendTextDeltaToRound,
  appendThinkingDeltaToRound,
  attachToolResultToRound,
  buildDelegateAgentPlaceholderToolCalls,
  getRoundToolTrace,
  summarizeToolCall as summarizeDesktopToolCall,
  upsertHostedSearchToRound,
  upsertToolCallToRound,
  type UiRound,
} from "@/lib/chat/uiMessages";
import {
  enrichHostedSearchBlockWithText,
  mergeHostedSearchBlocks,
  normalizeHostedSearchBlock,
  type HostedSearchBlock,
} from "@/lib/chat/hostedSearch";
import type {
  DelegateAgentCardResultDetails,
  DelegateAgentItemResultDetails,
  DelegateAgentResultDetails,
} from "@/lib/tools/builtinTypes";

import type {
  ChatCheckpointPayload,
  ChatEvent,
  ConversationSummary,
} from "./gatewayTypes";

export type AssistantMeta = NonNullable<UiRound["meta"]>;

export type GatewayTranscriptRound = UiRound & {
  key: string;
  runningToolCallIds: string[];
  thinkingOpen?: boolean;
};

export type GatewayTranscriptItem =
  | {
      id: string;
      kind: "user";
      text: string;
      attachments: PendingUploadedFile[];
      userOrdinal: number;
      messageRef?: HistoryMessageRef;
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
  | { id: string; kind: "assistant"; rounds: GatewayTranscriptRound[] }
  | { id: string; kind: "error"; text: string };

export type ChatEntry =
  | {
      id: string;
      kind: "user";
      text: string;
      attachments: PendingUploadedFile[];
      messageRef?: HistoryMessageRef;
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
  | { id: string; kind: "assistant"; text: string; round?: number; meta?: AssistantMeta }
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

type ToolCallLike = {
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

type AssistantGroupBuilder = {
  id: string;
  rounds: GatewayTranscriptRound[];
  roundIndexByNumber: Map<number, number>;
};

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
  return `${prefix}-${crypto.randomUUID()}`;
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function hashValue(value: unknown) {
  return hashText(safeStringify(value));
}

const DSML_TAG_PREFIX = String.raw`(?:\uFF5C{2}|\|{2})\s*DSML\s*(?:\uFF5C{2}|\|{2})`;
const DSML_TOOL_CALL_DISPLAY_PATTERN = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>[\s\S]*?(?:<\/\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>|$)`,
  "gi",
);

function stripRecoveredToolCallMarkup(value: string) {
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

function buildAssistantGroupId(seedEntryId: string) {
  return `assistant-group-${seedEntryId}`;
}

function buildTranscriptRoundKey(groupId: string, round: number) {
  return `${groupId}-round-${round}`;
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

function normalizeLiveUploadedFiles(value: unknown): PendingUploadedFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeLiveUploadedFile(item))
    .filter((file): file is PendingUploadedFile => file !== null);
}

function liveUserEntryMatches(
  entry: ChatEntry | undefined,
  text: string,
  attachments: PendingUploadedFile[],
) {
  return (
    entry?.kind === "user" &&
    entry.text === text &&
    uploadedFilesVisuallyEqual(entry.attachments, attachments)
  );
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

function normalizeToolArguments(...candidates: unknown[]): Record<string, unknown> {
  for (const candidate of candidates) {
    const direct = asNonArrayRecord(candidate);
    if (recordHasEntries(direct)) {
      return direct;
    }
    const parsed = parseJsonRecord(candidate);
    if (recordHasEntries(parsed)) {
      return parsed;
    }
  }
  return {};
}

function normalizeToolCallLike(input: ToolCallLike): ToolCallLike {
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

function buildAssistantMeta(params: {
  provider?: unknown;
  model?: unknown;
  api?: unknown;
  stopReason?: unknown;
  usage?: unknown;
}) {
  const usage = params.usage && typeof params.usage === "object"
    ? (params.usage as Usage)
    : undefined;

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

function normalizeCheckpointEntry(params: {
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
    readNumber(params.checkpoint?.timestamp) ??
    readNumber(params.timestamp) ??
    Date.now();

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

function isCheckpointTokenEvent(event: Extract<ChatEvent, { type: "token" }>) {
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

function normalizeToolResultContentBlock(
  block: unknown,
): ToolResultMessage["content"][number][] {
  if (typeof block === "string") {
    return block === "" ? [] : [{ type: "text", text: block }] as ToolResultMessage["content"];
  }

  const record = asRecord(block);
  const type = readString(record.type);
  if (type === "text") {
    return [{ type: "text", text: readString(record.text) }] as ToolResultMessage["content"];
  }
  if (
    type === "image" &&
    typeof record.mimeType === "string" &&
    typeof record.data === "string"
  ) {
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
    readString(params.toolCallId).trim() ||
    params.fallbackToolCallId ||
    randomId("tool-result");
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

function getToolResultText(content: unknown) {
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

function buildToolCallEntry(
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

function buildToolResultEntry(
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

function buildHostedSearchEntry(
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

function formatLiveErrorMessage(message: string, prefix: boolean) {
  if (!prefix || message === "Request failed") {
    return message;
  }
  return message.startsWith("Request failed:") || message.startsWith("Request failed：")
    ? message
    : `Request failed: ${message}`;
}

function hasTailAssistantText(entries: ChatEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.kind === "user" || entry.kind === "checkpoint" || entry.kind === "error") {
      return false;
    }
    if (entry.kind === "assistant" && entry.text.trim()) {
      return true;
    }
  }
  return false;
}

function hasLiveErrorTextEntry(entries: ChatEntry[], message: string) {
  return entries.some((entry) => {
    if (entry.kind === "error") {
      return entry.text.trim() === message;
    }
    if (entry.kind === "assistant") {
      return entry.text.trim() === message;
    }
    return false;
  });
}

export function parseHistoryMessagesJson(raw: string): ChatEntry[] {
  if (raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return [
      {
        id: randomId("history-error"),
        kind: "error",
        text: `历史消息解析失败：${message}`,
      },
    ];
  }

  if (!Array.isArray(parsed)) {
    return [
      {
        id: randomId("history-error"),
        kind: "error",
        text: "历史消息载荷不是数组，无法渲染。",
      },
    ];
  }

  const entries: ChatEntry[] = [];
  let currentRound = 0;

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
        entries.push({
          id: messageRef ? `user-${messageRef.messageId}` : randomId("user"),
          kind: "user",
          text,
          attachments,
          messageRef,
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
        fallbackId: randomId("checkpoint"),
      });
      if (checkpoint) {
        entries.push(checkpoint);
      }
      continue;
    }

    if (role === "assistant") {
      currentRound += 1;
      const round = currentRound;
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
          id: randomId("assistant"),
          kind: "assistant",
          text: textBuffer,
          round,
          meta: metaEmitted ? undefined : meta,
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
            id: randomId("thinking"),
            kind: "thinking",
            round,
            text: block.text,
          });
        }

        if (block.type === "toolCall") {
          entries.push(buildToolCallEntry(block.toolCall, round));
        }

        if (block.type === "hostedSearch") {
          entries.push(buildHostedSearchEntry(block.hostedSearch, round));
        }
      }

      flushText();
      continue;
    }

    if (role === "toolResult") {
      entries.push(buildToolResultEntry(message, currentRound || 1));
    }
  }

  return entries;
}

function findLastAssistantEntryIndex(entries: ChatEntry[], round?: number) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.kind === "user" || entry.kind === "checkpoint" || entry.kind === "error") {
      break;
    }
    if (entry.kind === "assistant" && (round === undefined || entry.round === round)) {
      return index;
    }
  }
  return -1;
}

function hasTailAssistantEntry(
  entries: ChatEntry[],
  matcher: (entry: ChatEntry) => boolean,
) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (entry.kind === "user" || entry.kind === "checkpoint" || entry.kind === "error") {
      break;
    }
    if (matcher(entry)) {
      return true;
    }
  }
  return false;
}

function countTailAssistantEntries(
  entries: ChatEntry[],
  matcher: (entry: ChatEntry) => boolean,
) {
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (entry.kind === "user" || entry.kind === "checkpoint" || entry.kind === "error") {
      break;
    }
    if (matcher(entry)) {
      count += 1;
    }
  }
  return count;
}

function buildLiveAssistantEntryId(round?: number, occurrence = 0) {
  const baseId = `live-assistant-${round ?? 0}`;
  return occurrence <= 0 ? baseId : `${baseId}-${occurrence}`;
}

function isLiveAssistantEntryIdForRound(id: string, round?: number) {
  const baseId = `live-assistant-${round ?? 0}`;
  return id === baseId || id.startsWith(`${baseId}-`);
}

function buildLiveThinkingEntryId(round: number | undefined, occurrence: number) {
  return `live-thinking-${round ?? 0}-${occurrence}`;
}

function buildLiveToolCallBaseId(params: {
  round?: number;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}) {
  const explicitId = readString(params.id).trim();
  if (explicitId !== "") {
    return `live-tool-call-${params.round ?? 0}-${explicitId}`;
  }
  return [
    "live-tool-call",
    String(params.round ?? 0),
    readString(params.name).trim() || "Tool",
    hashValue(asRecord(params.arguments)),
  ].join("-");
}

function buildLiveToolResultBaseId(params: {
  round?: number;
  toolCallId?: unknown;
  toolName?: unknown;
  content?: unknown;
  isError?: unknown;
}) {
  const explicitId = readString(params.toolCallId).trim();
  if (explicitId !== "") {
    return `live-tool-result-${params.round ?? 0}-${explicitId}`;
  }
  return [
    "live-tool-result",
    String(params.round ?? 0),
    readString(params.toolName).trim() || "Tool",
    Boolean(params.isError) ? "error" : "ok",
    hashValue(params.content),
  ].join("-");
}

function buildLiveHostedSearchBaseId(params: {
  round?: number;
  id?: unknown;
  queries?: unknown;
}) {
  const explicitId = readString(params.id).trim();
  if (explicitId !== "") {
    return `live-hosted-search-${params.round ?? 0}-${explicitId}`;
  }
  return [
    "live-hosted-search",
    String(params.round ?? 0),
    hashValue(params.queries),
  ].join("-");
}

function hasCheckpointEntry(entries: ChatEntry[], summaryId: string) {
  return entries.some(
    (entry) => entry.kind === "checkpoint" && entry.summaryId === summaryId,
  );
}

function isMatchingToolCallEntry(
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

function isMatchingToolResultEntry(
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

function mergeTailToolCallArguments(
  entries: ChatEntry[],
  params: {
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
    round?: number;
  },
) {
  const incomingArgs = normalizeToolArguments(params.arguments);
  const hasIncomingArgs = recordHasEntries(incomingArgs);
  const incomingId = readString(params.id).trim();
  const incomingName = readString(params.name).trim();

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (entry.kind === "user" || entry.kind === "checkpoint" || entry.kind === "error") {
      break;
    }
    if (entry.kind !== "tool_call") {
      continue;
    }
    if (params.round !== undefined && entry.round !== params.round) {
      continue;
    }

    const existingArgs = normalizeToolArguments(entry.toolCall.arguments);
    const hasExistingArgs = recordHasEntries(existingArgs);
    let matches = false;
    let canUpdate = false;

    if (incomingId !== "") {
      matches = entry.toolCall.id === incomingId;
      canUpdate =
        matches &&
        hasIncomingArgs &&
        safeStringify(existingArgs) !== safeStringify(incomingArgs);
    } else if (incomingName !== "" && entry.toolCall.name === incomingName) {
      const sameArguments =
        safeStringify(existingArgs) === safeStringify(incomingArgs);
      matches = sameArguments || (!hasExistingArgs && hasIncomingArgs);
      canUpdate = matches && !hasExistingArgs && hasIncomingArgs;
    }

    if (!matches) {
      continue;
    }
    if (!canUpdate) {
      return { entries, matched: true };
    }

    const nextToolCall = {
      ...entry.toolCall,
      id: incomingId || entry.toolCall.id,
      name: incomingName || entry.toolCall.name,
      arguments: incomingArgs,
    } as ToolCall;
    const next = entries.slice();
    next[index] = {
      ...entry,
      toolCall: nextToolCall,
      summary: summarizeToolCall(nextToolCall),
      text: safeStringify(nextToolCall.arguments),
    };
    return { entries: next, matched: true };
  }

  return { entries, matched: false };
}

function enrichTailHostedSearchEntriesWithText(entries: ChatEntry[]): ChatEntry[] {
  let startIndex = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.kind === "user" || entry.kind === "checkpoint" || entry.kind === "error") {
      startIndex = index + 1;
      break;
    }
  }

  let allText = "";
  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind === "assistant") {
      allText += entry.text;
    }
  }
  if (allText === "") {
    return entries;
  }

  let next: ChatEntry[] | null = null;
  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind !== "hosted_search" || entry.hostedSearch.sources.length > 0) {
      continue;
    }

    let nextSearchIndex = entries.length;
    for (let probe = index + 1; probe < entries.length; probe += 1) {
      if (entries[probe]?.kind === "hosted_search") {
        nextSearchIndex = probe;
        break;
      }
    }

    let nearbyText = "";
    for (let probe = index + 1; probe < nextSearchIndex; probe += 1) {
      const textEntry = entries[probe];
      if (textEntry?.kind === "assistant") {
        nearbyText += textEntry.text;
      }
    }

    const enriched = enrichHostedSearchBlockWithText(
      entry.hostedSearch,
      nearbyText || allText,
    );
    if (enriched.sources.length === entry.hostedSearch.sources.length) {
      continue;
    }

    if (!next) {
      next = entries.slice();
    }
    next[index] = {
      ...entry,
      hostedSearch: enriched,
    };
  }

  return next ?? entries;
}

export function pushChatEvent(entries: ChatEntry[], event: ChatEvent): ChatEntry[] {
  if (event.type === "user_message") {
    const text = readString(event.message);
    const attachments = normalizeLiveUploadedFiles(event.uploaded_files);
    if (!text.trim() && attachments.length === 0) {
      return entries;
    }
    if (liveUserEntryMatches(entries.at(-1), text, attachments)) {
      return entries;
    }
    return [
      ...entries,
      {
        id: randomId("live-user"),
        kind: "user",
        text,
        attachments,
      },
    ];
  }

  if (event.type === "token") {
    if (isCheckpointTokenEvent(event)) {
      const checkpoint = normalizeCheckpointEntry({
        id: event.checkpoint?.summaryId,
        content: event.text,
        timestamp: event.checkpoint?.timestamp,
        summaryMeta: {
          coveredMessageCount: event.checkpoint?.coveredMessageCount,
          generatedBy: event.checkpoint?.generatedBy,
        },
        checkpoint: event.checkpoint,
        fallbackId: randomId("checkpoint"),
      });
      if (!checkpoint || hasCheckpointEntry(entries, checkpoint.summaryId)) {
        return entries;
      }
      return [...entries, checkpoint];
    }

    const text = stripRecoveredToolCallMarkup(event.text ?? "");
    const round = readRound(event.round);
    const meta = buildAssistantMeta({
      provider: event.provider,
      model: event.model,
      api: event.api,
      stopReason: event.stopReason,
      usage: event.usage,
    });

    if (text === "" && !meta) {
      return entries;
    }

    const tail = entries.at(-1);
    const assistantIndex =
      tail?.kind === "assistant" && (round === undefined || tail.round === round)
        ? entries.length - 1
        : text === ""
          ? findLastAssistantEntryIndex(entries, round)
          : -1;
    if (assistantIndex >= 0) {
      const target = entries[assistantIndex];
      if (target?.kind !== "assistant") return entries;
      const next = entries.slice();
      next[assistantIndex] = {
        ...target,
        text: target.text + text,
        round: round ?? target.round,
        meta: meta ? { ...(target.meta ?? {}), ...meta } : target.meta,
      };
      return enrichTailHostedSearchEntriesWithText(next);
    }

    const occurrence = countTailAssistantEntries(
      entries,
      (entry) =>
        entry.kind === "assistant" &&
        isLiveAssistantEntryIdForRound(entry.id, round),
    );
    const next: ChatEntry[] = [
      ...entries,
      {
        id: buildLiveAssistantEntryId(round, occurrence),
        kind: "assistant",
        text,
        round,
        meta,
      },
    ];
    return enrichTailHostedSearchEntriesWithText(next);
  }

  if (event.type === "thinking") {
    const text = stripRecoveredToolCallMarkup(event.text ?? "");
    if (text === "") {
      return entries;
    }
    const round = readRound(event.round);
    const last = entries.at(-1);
    if (last?.kind === "thinking" && last.round === round) {
      return [...entries.slice(0, -1), { ...last, text: last.text + text }];
    }
    const occurrence = countTailAssistantEntries(
      entries,
      (entry) => entry.kind === "thinking" && entry.round === round,
    );
    return [
      ...entries,
      {
        id: buildLiveThinkingEntryId(round, occurrence),
        kind: "thinking",
        round,
        text,
      },
    ];
  }

  if (event.type === "tool_call" || event.type === "tool_call_delta") {
    const round = readRound(event.round);
    const eventToolCall = normalizeToolCallLike(event);
    const mergedToolCall = mergeTailToolCallArguments(entries, {
      id: eventToolCall.id,
      name: eventToolCall.name,
      arguments: eventToolCall.arguments,
      round,
    });
    if (mergedToolCall.matched) {
      return mergedToolCall.entries;
    }

    const baseId = buildLiveToolCallBaseId({
      round,
      id: eventToolCall.id,
      name: eventToolCall.name,
      arguments: eventToolCall.arguments,
    });
    const occurrence = countTailAssistantEntries(entries, (entry) =>
      entry.kind === "tool_call" && entry.id.startsWith(baseId),
    );
    const stableId = `${baseId}-${occurrence}`;

    return [
      ...entries,
      buildToolCallEntry(
        {
          id: eventToolCall.id,
          name: eventToolCall.name,
          arguments: eventToolCall.arguments,
        },
        round,
        {
          entryId: stableId,
          fallbackToolCallId: stableId,
        },
      ),
    ];
  }

  if (event.type === "tool_result") {
    const round = readRound(event.round);
    const resultToolCall = normalizeToolCallLike(event);
    const hasResultToolCallArgs = recordHasEntries(
      normalizeToolArguments(resultToolCall.arguments),
    );
    const mergedToolCall = mergeTailToolCallArguments(entries, {
      id: resultToolCall.id,
      name: resultToolCall.name,
      arguments: resultToolCall.arguments,
      round,
    });
    const nextEntries = mergedToolCall.entries;
    if (
      hasTailAssistantEntry(nextEntries, (entry) =>
        isMatchingToolResultEntry(entry, {
          toolCallId: resultToolCall.id ?? event.id,
          toolName: resultToolCall.name ?? event.name,
          content: event.content,
          isError: event.isError,
          round,
        }),
      )
    ) {
      return nextEntries;
    }

    const baseId = buildLiveToolResultBaseId({
      round,
      toolCallId: resultToolCall.id ?? event.id,
      toolName: resultToolCall.name ?? event.name,
      content: event.content,
      isError: event.isError,
    });
    const occurrence = countTailAssistantEntries(entries, (entry) =>
      entry.kind === "tool_result" && entry.id.startsWith(baseId),
    );
    const stableId = `${baseId}-${occurrence}`;
    const shouldPrependToolCall =
      hasResultToolCallArgs &&
      !mergedToolCall.matched &&
      !hasTailAssistantEntry(nextEntries, (entry) =>
        isMatchingToolCallEntry(entry, {
          id: resultToolCall.id,
          name: resultToolCall.name,
          arguments: resultToolCall.arguments,
          round,
        }),
      );

    return [
      ...nextEntries,
      ...(shouldPrependToolCall
        ? [
            buildToolCallEntry(
              {
                id: resultToolCall.id,
                name: resultToolCall.name,
                arguments: resultToolCall.arguments,
              },
              round,
              {
                entryId: `${stableId}-tool-call`,
                fallbackToolCallId: `${stableId}-tool-call`,
              },
            ),
          ]
        : []),
      buildToolResultEntry(
        {
          toolCallId: resultToolCall.id ?? event.id,
          toolName: resultToolCall.name ?? event.name,
          content: event.content,
          details: event.details,
          isError: event.isError,
        },
        round,
        {
          entryId: stableId,
          fallbackToolCallId: stableId,
        },
      ),
    ];
  }

  if (event.type === "hosted_search") {
    const round = readRound(event.round);
    const hostedSearch = normalizeHostedSearchBlock({
      type: "hostedSearch",
      id: event.id,
      provider: event.provider,
      status: event.status,
      queries: event.queries,
      sources: event.sources,
      updatedAt: event.updatedAt,
    });
    if (!hostedSearch) return entries;

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      if (entry.kind === "user" || entry.kind === "checkpoint" || entry.kind === "error") {
        break;
      }
      if (
        entry.kind === "hosted_search" &&
        entry.round === round &&
        entry.hostedSearch.id === hostedSearch.id
      ) {
        const next = entries.slice();
        next[index] = {
          ...entry,
          hostedSearch: mergeHostedSearchBlocks(entry.hostedSearch, hostedSearch),
        };
        return enrichTailHostedSearchEntriesWithText(next);
      }
    }

    const baseId = buildLiveHostedSearchBaseId({
      round,
      id: hostedSearch.id,
      queries: hostedSearch.queries,
    });
    const next: ChatEntry[] = [
      ...entries,
      buildHostedSearchEntry(hostedSearch, round, { entryId: baseId }),
    ];
    return enrichTailHostedSearchEntriesWithText(next);
  }

  if (event.type === "error" || event.type === "failed") {
    const round = event.type === "error" ? readRound(event.round) : undefined;
    const rawMessage = event.message ?? "";
    const message = formatLiveErrorMessage(
      rawMessage.trim() || "Request failed",
      event.type === "failed",
    );
    if (isAbortLikeError(message)) {
      return entries;
    }
    if (hasLiveErrorTextEntry(entries, message)) {
      return entries;
    }
    const errorId = hashText(message);
    const text = `${hasTailAssistantText(entries) ? "\n\n" : ""}${message}`;
    return [
      ...entries,
      {
        id: `live-error-${round ?? 0}-${errorId}`,
        kind: "assistant",
        round,
        text,
      },
    ];
  }

  return entries;
}

function createTranscriptRound(groupId: string, round: number): GatewayTranscriptRound {
  return {
    key: buildTranscriptRoundKey(groupId, round),
    round,
    blocks: [],
    runningToolCallIds: [],
  };
}

function ensureAssistantGroup(builder: AssistantGroupBuilder | null, seedEntryId: string) {
  if (builder) return builder;
  return {
    id: buildAssistantGroupId(seedEntryId),
    rounds: [],
    roundIndexByNumber: new Map<number, number>(),
  };
}

function ensureTranscriptRound(
  builder: AssistantGroupBuilder,
  requestedRound?: number,
): GatewayTranscriptRound {
  const roundNumber =
    requestedRound ??
    builder.rounds[builder.rounds.length - 1]?.round ??
    1;
  const existingIndex = builder.roundIndexByNumber.get(roundNumber);
  if (existingIndex !== undefined) {
    return builder.rounds[existingIndex];
  }

  const nextRound = createTranscriptRound(builder.id, roundNumber);
  builder.roundIndexByNumber.set(roundNumber, builder.rounds.length);
  builder.rounds.push(nextRound);
  return nextRound;
}

function updateTranscriptRound(
  builder: AssistantGroupBuilder,
  roundNumber: number,
  updater: (round: GatewayTranscriptRound) => GatewayTranscriptRound,
) {
  const round = ensureTranscriptRound(builder, roundNumber);
  const index = builder.roundIndexByNumber.get(round.round) ?? 0;
  const nextRound = updater(round);
  builder.rounds[index] = nextRound;
  return nextRound;
}

function collapseThinking(round: GatewayTranscriptRound): GatewayTranscriptRound {
  if (!round.thinkingOpen) return round;
  return { ...round, thinkingOpen: false };
}

function mergeAssistantMeta(
  current: AssistantMeta | undefined,
  next: AssistantMeta | undefined,
) {
  if (!next) return current;
  return {
    ...(current ?? {}),
    ...next,
  };
}

function findToolCallInRound(round: GatewayTranscriptRound, toolCallId: string) {
  return getRoundToolTrace(round).find((item) => item.toolCall.id === toolCallId)?.toolCall;
}

function findPendingToolCallByName(
  round: GatewayTranscriptRound,
  name: string,
) {
  const trace = getRoundToolTrace(round);
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const item = trace[index];
    if (!item) continue;
    if (item.toolCall.name === name && !item.toolResult) {
      return item.toolCall;
    }
  }
  return undefined;
}

function resolveToolCallForResult(
  builder: AssistantGroupBuilder,
  roundNumber: number,
  toolResult: ToolResultMessage,
) {
  const requestedRound = ensureTranscriptRound(builder, roundNumber);
  const byId =
    toolResult.toolCallId && findToolCallInRound(requestedRound, toolResult.toolCallId);
  if (byId) {
    return byId;
  }

  const byName =
    toolResult.toolName && findPendingToolCallByName(requestedRound, toolResult.toolName);
  if (byName) {
    return byName;
  }

  for (let index = builder.rounds.length - 1; index >= 0; index -= 1) {
    const round = builder.rounds[index];
    if (!round) continue;
    const candidateById =
      toolResult.toolCallId && findToolCallInRound(round, toolResult.toolCallId);
    if (candidateById) {
      return candidateById;
    }
    const candidateByName =
      toolResult.toolName && findPendingToolCallByName(round, toolResult.toolName);
    if (candidateByName) {
      return candidateByName;
    }
  }

  return {
    type: "toolCall",
    id: toolResult.toolCallId || randomId("tool-call"),
    name: toolResult.toolName || "Tool",
    arguments: {},
  } as ToolCall;
}

function asDelegateAgentResultDetails(
  details: unknown,
): DelegateAgentResultDetails | null {
  const record = asRecord(details);
  return record.kind === "delegate_agent" && Array.isArray(record.agents)
    ? (record as DelegateAgentResultDetails)
    : null;
}

function readDelegateAgentPrompt(agent: DelegateAgentItemResultDetails) {
  return agent.prompt || agent.description || "";
}

function buildDelegateAgentCardToolCall(params: {
  parentToolResult: ToolResultMessage;
  details: DelegateAgentResultDetails;
  index: number;
  agent: DelegateAgentItemResultDetails;
}): ToolCall {
  const parentToolCallId = params.parentToolResult.toolCallId || "agent";
  return {
    type: "toolCall",
    id: `${parentToolCallId}:agent:${params.index + 1}`,
    name: "Agent",
    arguments: {
      delegate_agent_card: true,
      parent_tool_call_id: parentToolCallId,
      index: params.index + 1,
      total: params.details.agentCount,
      concurrency: params.details.concurrency,
      id: params.agent.id,
      name: params.agent.name,
      role: params.agent.role,
      agent_id: params.agent.agentId,
      prompt: readDelegateAgentPrompt(params.agent),
      mode: params.agent.mode,
    },
  } as ToolCall;
}

function buildDelegateAgentCardToolResult(params: {
  parentToolResult: ToolResultMessage;
  toolCall: ToolCall;
  details: DelegateAgentResultDetails;
  index: number;
  agent: DelegateAgentItemResultDetails;
}): ToolResultMessage {
  const details: DelegateAgentCardResultDetails = {
    kind: "delegate_agent_item",
    parentToolCallId: params.parentToolResult.toolCallId,
    index: params.index,
    total: params.details.agentCount,
    concurrency: params.details.concurrency,
    agent: params.agent,
  };
  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [
      {
        type: "text",
        text:
          params.agent.error ||
          params.agent.applyError ||
          params.agent.summary ||
          readDelegateAgentPrompt(params.agent) ||
          "",
      },
    ],
    details,
    isError: params.agent.status === "failed",
    timestamp: params.parentToolResult.timestamp,
  } as ToolResultMessage;
}

function appendDelegateAgentCardsToRound(
  round: GatewayTranscriptRound,
  parentToolResult: ToolResultMessage,
  details: DelegateAgentResultDetails,
): GatewayTranscriptRound {
  let nextRound = round;
  details.agents.forEach((agent, index) => {
    const toolCall = buildDelegateAgentCardToolCall({
      parentToolResult,
      details,
      index,
      agent,
    });
    const toolResult = buildDelegateAgentCardToolResult({
      parentToolResult,
      toolCall,
      details,
      index,
      agent,
    });
    nextRound = attachToolResultToRound(
      nextRound,
      toolCall,
      toolResult,
    ) as GatewayTranscriptRound;
  });

  const completedIds = new Set([
    parentToolResult.toolCallId,
    ...details.agents.map((_, index) => `${parentToolResult.toolCallId}:agent:${index + 1}`),
  ]);

  return {
    ...nextRound,
    runningToolCallIds: nextRound.runningToolCallIds.filter((id) => !completedIds.has(id)),
  };
}

export function buildTranscriptItems(entries: ChatEntry[]): GatewayTranscriptItem[] {
  const items: GatewayTranscriptItem[] = [];
  let assistantGroup: AssistantGroupBuilder | null = null;
  let userOrdinal = 0;

  const flushAssistantGroup = () => {
    if (!assistantGroup || assistantGroup.rounds.length === 0) {
      assistantGroup = null;
      return;
    }
    items.push({
      id: assistantGroup.id,
      kind: "assistant",
      rounds: assistantGroup.rounds,
    });
    assistantGroup = null;
  };

  for (const entry of entries) {
    if (entry.kind === "user" || entry.kind === "checkpoint" || entry.kind === "error") {
      flushAssistantGroup();
      if (entry.kind === "user") {
        items.push({
          ...entry,
          userOrdinal,
        });
        userOrdinal += 1;
      } else {
        items.push(entry);
      }
      continue;
    }

    assistantGroup = ensureAssistantGroup(assistantGroup, entry.id);
    const roundNumber = entry.round ?? assistantGroup.rounds[assistantGroup.rounds.length - 1]?.round ?? 1;

    if (entry.kind === "assistant") {
      updateTranscriptRound(assistantGroup, roundNumber, (round) => {
        let nextRound = round;
        if (entry.text !== "") {
          nextRound = appendTextDeltaToRound(collapseThinking(nextRound), entry.text) as GatewayTranscriptRound;
        }
        return {
          ...nextRound,
          meta: mergeAssistantMeta(nextRound.meta, entry.meta),
        };
      });
      continue;
    }

    if (entry.kind === "thinking") {
      const sanitizedThinking = stripRecoveredToolCallMarkup(entry.text);
      if (sanitizedThinking === "") {
        continue;
      }
      updateTranscriptRound(assistantGroup, roundNumber, (round) => ({
        ...(appendThinkingDeltaToRound(round, sanitizedThinking) as GatewayTranscriptRound),
        thinkingOpen: true,
      }));
      continue;
    }

    if (entry.kind === "tool_call") {
      updateTranscriptRound(assistantGroup, roundNumber, (round) => {
        const visibleToolCalls = buildDelegateAgentPlaceholderToolCalls(entry.toolCall);
        const runningCandidateIds =
          visibleToolCalls.length > 0
            ? visibleToolCalls.map((toolCall) => toolCall.id)
            : entry.toolCall.id
              ? [entry.toolCall.id]
              : [];
        const withToolCall = upsertToolCallToRound(
          collapseThinking(round),
          entry.toolCall,
        ) as GatewayTranscriptRound;
        const visibleToolCallIds = new Set(
          getRoundToolTrace(withToolCall)
            .map((item) => item.toolCall.id)
            .filter((id): id is string => Boolean(id)),
        );
        const runningToolCallIds = runningCandidateIds.reduce(
          (ids, id) =>
            visibleToolCallIds.has(id) && !ids.includes(id) ? [...ids, id] : ids,
          withToolCall.runningToolCallIds,
        );
        return {
          ...withToolCall,
          runningToolCallIds,
        };
      });
      continue;
    }

    if (entry.kind === "hosted_search") {
      updateTranscriptRound(assistantGroup, roundNumber, (round) => {
        const nextRound = upsertHostedSearchToRound(
          collapseThinking(round),
          entry.hostedSearch,
        ) as GatewayTranscriptRound;
        const visibleToolCallIds = new Set(
          getRoundToolTrace(nextRound)
            .map((item) => item.toolCall.id)
            .filter((id): id is string => Boolean(id)),
        );
        return {
          ...nextRound,
          runningToolCallIds: nextRound.runningToolCallIds.filter((id) =>
            visibleToolCallIds.has(id),
          ),
        };
      });
      continue;
    }

    if (entry.kind === "tool_result") {
      const delegateDetails = asDelegateAgentResultDetails(entry.toolResult.details);
      if (delegateDetails) {
        updateTranscriptRound(assistantGroup, roundNumber, (round) =>
          appendDelegateAgentCardsToRound(
            collapseThinking(round),
            entry.toolResult,
            delegateDetails,
          ),
        );
        continue;
      }

      const toolCall = resolveToolCallForResult(
        assistantGroup,
        roundNumber,
        entry.toolResult,
      );
      updateTranscriptRound(assistantGroup, roundNumber, (round) => {
        const withResult = attachToolResultToRound(
          collapseThinking(round),
          toolCall,
          entry.toolResult,
        ) as GatewayTranscriptRound;
        return {
          ...withResult,
          runningToolCallIds: withResult.runningToolCallIds.filter(
            (id) => id !== toolCall.id,
          ),
        };
      });
    }
  }

  flushAssistantGroup();
  return items;
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
