import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@liveagent/ui/lib/chat/contextUsage";
import {
  getUserMessageAttachments,
  getUserMessageDisplayText,
  parsePastedTextDisplayReferences,
  splitUserAttachmentsForDisplay,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { ProviderId } from "../../settings";
import {
  type CompactionCheckpointStats,
  type ConversationViewState,
  INTERNAL_RESUME_MESSAGE_TEXT,
  type RetainedUserMessage,
} from "../conversation/conversationState";
import {
  isCheckpointBridgeMessage,
  isCheckpointBridgeText,
  sanitizeRetainedUserMessages,
} from "./bridge";
import { RETAINED_USER_MESSAGES_MAX_TOKENS } from "./policy";
import { clipToTokens, fillNewestFirst, serializeTranscript } from "./transcript";

// deterministic 摘要继承的上一份摘要上限（与 LLM 摘要的最小上限同值）：LLM 档持续失败时
// 每次兜底都会再追加一段活动转录，不封顶会让 bridge 单调膨胀。
const DETERMINISTIC_PREVIOUS_SUMMARY_MAX_TOKENS = 8_000;

// 每条的 <user_message time="…"> 包裹开销（ISO 时间戳 + 标签）。
const RETAINED_MESSAGE_OVERHEAD_TOKENS = 16;

// 大段粘贴引用 [Pasted text N: <暂存相对路径>] 只留标签：路径是上传元数据，脱离
// Read 指令里的绝对路径后不可解析，模型照着去 Read 只会失败。
function stripPastedTextPaths(text: string): string {
  const references = parsePastedTextDisplayReferences(text);
  let result = text;
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const { start, end, label } = references[index];
    result = `${result.slice(0, start)}[${label}]${result.slice(end)}`;
  }
  return result;
}

// 发给模型的用户原话：附件消息的 content 末尾拼着 Read 指令与绝对路径（上传元数据），
// 原话在展示字段里，附件只留名字；图片 → [image]，其他非文本块 → [attachment]。
function retainedTextOf(message: Message): string {
  if (message.role !== "user") return "";
  const record = message as Message & Record<string, unknown>;
  const attachments = getUserMessageAttachments(record);
  const content = message.content;
  const parts: string[] = [];
  if (attachments.length > 0) {
    const displayText = getUserMessageDisplayText(record);
    parts.push(stripPastedTextPaths(displayText));
    for (const file of splitUserAttachmentsForDisplay(attachments, displayText).visibleFiles) {
      parts.push(`[attachment: ${file.fileName}]`);
    }
  } else if (typeof content === "string") {
    parts.push(content);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text") {
        if (attachments.length === 0 && !isCheckpointBridgeText(block.text)) parts.push(block.text);
      } else {
        parts.push(block.type === "image" ? "[image]" : "[attachment]");
      }
    }
  }
  return parts.join("\n").trim();
}

function retainedKey(message: RetainedUserMessage): string {
  return message.id ? `id:${message.id}` : `ts:${message.timestamp}\u0000${message.text}`;
}

/**
 * 调用方对单条 user 消息保留文本的裁决：null 排除；字符串替换默认提取的原话；
 * undefined 走默认提取。
 */
export type RetainedUserTextResolver = (message: Message) => string | null | undefined;

/**
 * 选出 checkpoint 要保留的用户原话（纯函数）。候选池 = 上一份摘要的保留集 + 被压缩
 * segment 的真实用户消息，按 id（或时间戳+文本）去重；排除合成续跑消息、bridge 与
 * 调用方判定不可保留的消息。从新到旧整条装入预算，第一条放不下的在剩余 ≥256 token
 * 时截断保留并标记 truncated，然后停止。返回按时间正序。
 */
export function selectRetainedUserMessages(params: {
  previous?: RetainedUserMessage[];
  messages: Message[];
  budgetTokens: number;
  resolveText?: RetainedUserTextResolver;
}): RetainedUserMessage[] {
  const budget = Number.isFinite(params.budgetTokens)
    ? Math.max(0, Math.min(Math.floor(params.budgetTokens), RETAINED_USER_MESSAGES_MAX_TOKENS))
    : 0;
  if (budget <= 0) return [];

  const current: RetainedUserMessage[] = [];
  for (const message of params.messages) {
    if (message.role !== "user" || isCheckpointBridgeMessage(message)) continue;
    if (!Number.isFinite(message.timestamp)) continue;
    const resolved = params.resolveText?.(message);
    if (resolved === null) continue;
    const text = resolved === undefined ? retainedTextOf(message) : resolved.trim();
    if (!text || text === INTERNAL_RESUME_MESSAGE_TEXT) continue;
    const id = (message as Message & { id?: unknown }).id;
    current.push({
      ...(typeof id === "string" && id ? { id } : {}),
      timestamp: message.timestamp,
      text,
    });
  }
  // 同一条消息两边都有时以本段完整原文为准（上一份可能是截断版）。
  const currentKeys = new Set(current.map(retainedKey));
  const pooledKeys = new Set<string>();
  const pool: RetainedUserMessage[] = [];
  for (const message of sanitizeRetainedUserMessages(params.previous)) {
    const key = retainedKey(message);
    if (currentKeys.has(key) || pooledKeys.has(key)) continue;
    pooledKeys.add(key);
    pool.push(message);
  }
  for (const message of current) {
    const key = retainedKey(message);
    if (pooledKeys.has(key)) continue;
    pooledKeys.add(key);
    pool.push(message);
  }

  return fillNewestFirst(
    pool,
    budget,
    RETAINED_MESSAGE_OVERHEAD_TOKENS,
    (message) => message.text,
    (message, text) => ({ ...message, text, truncated: true as const }),
  ).kept;
}

type CompactionCheckpointMessage = AssistantMessage & {
  promptVersion: string;
  compactionStats: CompactionCheckpointStats;
  retainedUserMessages?: RetainedUserMessage[];
};

/**
 * 压缩 checkpoint 标记消息：api "liveagent-compaction"、零 usage、compactionStats。
 * provider / model 记实际服务了摘要请求的目标（落成 summaryMeta.generatedBy）。
 */
export function buildCheckpointMessage(params: {
  summaryText: string;
  providerId: ProviderId;
  model: string;
  promptVersion: string;
  timestamp: number;
  conversationTokens: number;
  summarizerUsage: NonNullable<CompactionCheckpointStats["summarizer"]>;
  retainedUserMessages: RetainedUserMessage[];
}): CompactionCheckpointMessage {
  return {
    role: "assistant",
    api: "liveagent-compaction",
    provider: params.providerId,
    model: params.model,
    promptVersion: params.promptVersion,
    content: [{ type: "text", text: params.summaryText }],
    stopReason: "stop",
    timestamp: params.timestamp,
    responseId: `liveagent-compaction-${params.timestamp}-${createUuid()}`,
    // checkpoint 消息自身的 usage 恒为零：summarizer 请求的真实用量走 compactionStats，
    // 绝不冒充会话上下文规模（旧实现的 usage 污染即源于此）。
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    compactionStats: {
      conversationTokens: params.conversationTokens,
      summarizer: params.summarizerUsage,
    },
    ...(params.retainedUserMessages.length > 0
      ? { retainedUserMessages: params.retainedUserMessages }
      : {}),
  } as CompactionCheckpointMessage;
}

/**
 * 无 LLM 的兜底摘要（只在自动触发且 mustProgress 时用）：继承上一份摘要（超过 8k token
 * 时截掉中段），其后附上未被摘要的本段活动（工具结果截到 300 字符，总量 4k token）。
 * 保留原话与文件账本照常经 bridge 带上。
 */
export function deterministicSummary(params: {
  previousSummary?: string;
  messages: readonly Message[];
  reason: string;
}): string {
  const previous = params.previousSummary?.trim() ?? "";
  return [
    estimateTextTokens(previous) > DETERMINISTIC_PREVIOUS_SUMMARY_MAX_TOKENS
      ? clipToTokens(previous, DETERMINISTIC_PREVIOUS_SUMMARY_MAX_TOKENS)
      : previous,
    "## Unsummarized activity",
    `(Automatic summary unavailable: ${params.reason}; re-read files as needed.)`,
    serializeTranscript(params.messages, { budgetTokens: 4_000, toolResultChars: 300 }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 把 checkpoint 的权威上下文快照写进活跃 segment 摘要的 stats.contextTokensAfter。 */
export function withContextTokensAfter(
  state: ConversationViewState,
  contextUsageTokens: number,
): ConversationViewState {
  const segmentIndex = state.activeSegmentIndex;
  const segment = state.segments[segmentIndex];
  if (!segment?.summary) return state;
  const nextSegment = {
    ...segment,
    summary: {
      ...segment.summary,
      summaryMeta: {
        ...segment.summary.summaryMeta,
        stats: {
          ...(segment.summary.summaryMeta.stats ?? {
            sourceMessageCount: segment.summary.summaryMeta.coveredMessageCount,
          }),
          contextTokensAfter: contextUsageTokens,
        },
      },
    },
  };
  const segments = state.segments.slice();
  segments[segmentIndex] = nextSegment;
  return { ...state, segments };
}
