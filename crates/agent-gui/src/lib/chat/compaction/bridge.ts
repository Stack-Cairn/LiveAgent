import type { Message, UserMessage } from "@earendil-works/pi-ai";
import {
  estimateContentTokenUnits,
  MESSAGE_ENVELOPE_TOKENS,
} from "@liveagent/ui/lib/chat/contextUsage";
import type { RetainedUserMessage, StoredSummaryMessage } from "../conversation/conversationState";
import { formatFileLedgerBlock } from "./fileLedger";

/**
 * checkpoint bridge：把压缩摘要、保留的用户原话与文件账本渲染成一段请求期文本，
 * 放进 segment 的首条 user 消息（或单独一条 user 消息）。system prompt 因此不再随
 * 每次压缩改写，前缀缓存跨压缩保持稳定。
 *
 * bridge 只存在于发往模型的请求里：永不持久化、永不进入 emittedMessages。渲染是
 * 纯函数且按 summary 对象身份记忆化，整个 segment 期间字节与对象身份都稳定。
 */

const CHECKPOINT_BRIDGE_ID_PREFIX = "context-checkpoint:";
const CHECKPOINT_OPEN_TAG = "<context_checkpoint>";
// 收尾段：bridge 文本恒以它结尾，isCheckpointBridgeText 首尾同时命中才认。说"request"
// 而非"message"：子代理 bus 快照、memory 增量也跟在 bridge 后面，它们不是新请求。
const CHECKPOINT_CLOSE = [
  "</context_checkpoint>",
  "If a newer user request follows this checkpoint, respond to it. Otherwise continue the current task from where it stopped; do not ask the user to repeat anything and do not mention this checkpoint.",
].join("\n");

// 插值内容里的闭合标签一律中和，摘要引用 <details><summary> 片段、用户原话贴的
// XML 都不能提前闭合信封。
const ENVELOPE_CLOSING_TAG_RE = /<\/(?=summary|user_message|context_checkpoint|files)/gi;

function neutralizeClosingTags(text: string): string {
  return text.replace(ENVELOPE_CLOSING_TAG_RE, "<\\/");
}

/**
 * 读回保留原话（bridge 渲染与下一次压缩的候选池共用）。summary 经 chatHistory /
 * 子代理 store 读回时只做了类型断言：坏数据必须被丢弃，绝不能让每次请求都抛错把
 * 会话砖掉。
 */
export function sanitizeRetainedUserMessages(raw: unknown): RetainedUserMessage[] {
  if (!Array.isArray(raw)) return [];
  const result: RetainedUserMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, timestamp, text, truncated } = item as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) continue;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
    result.push({
      ...(typeof id === "string" && id ? { id } : {}),
      timestamp,
      text,
      ...(truncated === true ? { truncated: true as const } : {}),
    });
  }
  return result;
}

function safeFileLedgerBlock(summary: StoredSummaryMessage): string {
  try {
    return formatFileLedgerBlock(summary.summaryMeta?.fileLedger);
  } catch {
    return "";
  }
}

const bridgeTextCache = new WeakMap<StoredSummaryMessage, string>();

/**
 * 渲染 checkpoint bridge 文本；按 summary 对象身份记忆化。摘要正文、保留原话与账本
 * 全空（旧/损坏数据）时为空串：不接 bridge，与旧 system prompt 注入的空摘要跳过一致。
 */
export function renderCheckpointBridgeText(summary: StoredSummaryMessage): string {
  const cached = bridgeTextCache.get(summary);
  if (cached !== undefined) return cached;

  const content = typeof summary.content === "string" ? summary.content.trim() : "";
  const retained = sanitizeRetainedUserMessages(summary.retainedUserMessages).flatMap(
    ({ text, timestamp }) => {
      const date = new Date(timestamp);
      return Number.isNaN(date.getTime()) ? [] : [{ text, time: date.toISOString() }];
    },
  );
  const files = safeFileLedgerBlock(summary);
  if (!content && retained.length === 0 && !files) {
    bridgeTextCache.set(summary, "");
    return "";
  }
  const lines = [
    CHECKPOINT_OPEN_TAG,
    "This conversation continues from an earlier part that was compacted to fit the context window. The summary is your own handoff note covering everything before this point.",
    ...(retained.length > 0
      ? [
          "The user messages are quoted verbatim, oldest first; their requests and constraints still apply unless a later message changes them.",
        ]
      : []),
    "<summary>",
    neutralizeClosingTags(content),
    "</summary>",
  ];
  if (retained.length > 0) {
    lines.push("<user_messages>");
    for (const message of retained) {
      lines.push(
        `<user_message time="${message.time}">${neutralizeClosingTags(message.text)}</user_message>`,
      );
    }
    lines.push("</user_messages>");
  }
  if (files) {
    lines.push("<files>", neutralizeClosingTags(files), "</files>");
  }
  lines.push(CHECKPOINT_CLOSE);
  const text = lines.join("\n");
  bridgeTextCache.set(summary, text);
  return text;
}

const standaloneBridgeCache = new WeakMap<StoredSummaryMessage, UserMessage & { id: string }>();

function standaloneBridgeMessage(summary: StoredSummaryMessage): UserMessage & { id: string } {
  const cached = standaloneBridgeCache.get(summary);
  if (cached) return cached;
  const message: UserMessage & { id: string } = {
    role: "user",
    id: `${CHECKPOINT_BRIDGE_ID_PREFIX}${summary.id}`,
    content: [{ type: "text", text: renderCheckpointBridgeText(summary) }],
    timestamp: summary.timestamp,
  };
  standaloneBridgeCache.set(summary, message);
  return message;
}

const mergedBridgeCache = new WeakMap<
  Message,
  { summary: StoredSummaryMessage; message: Message }
>();
// 合入形态 → 原消息的反查表，供 stripCheckpointBridges 还原。
const bridgeSourceByMerged = new WeakMap<Message, Message>();

function mergeBridgeIntoUserMessage(message: UserMessage, summary: StoredSummaryMessage): Message {
  const cached = mergedBridgeCache.get(message);
  if (cached && cached.summary === summary) return cached.message;
  const bridgeBlock = { type: "text" as const, text: renderCheckpointBridgeText(summary) };
  // 前置块：memory / skills 增量与缓存断点都挂在消息尾部，前置不挪动它们。
  const content: UserMessage["content"] =
    typeof message.content === "string"
      ? message.content.trim()
        ? [bridgeBlock, { type: "text", text: message.content }]
        : [bridgeBlock]
      : [bridgeBlock, ...message.content];
  const merged = { ...message, content } as Message;
  mergedBridgeCache.set(message, { summary, message: merged });
  bridgeSourceByMerged.set(merged, message);
  return merged;
}

/**
 * 把 bridge 接到 segment 消息前：首条是 user 时作为前置文本块合入（全局避免连续
 * 两条 user——pi-ai 的 chat-completions / Google 转换器都不合并 user→user，严格
 * 交替的中转会直接拒绝）；否则（运行中压缩后 segment 为空或以 assistant 开头）
 * 单独作为一条 user 消息。不修改入参；结果对象身份稳定，TokenLedger 的 WeakMap
 * 估算缓存随之命中。
 */
export function attachCheckpointBridge(
  messages: Message[],
  summary: StoredSummaryMessage,
): Message[] {
  if (!renderCheckpointBridgeText(summary)) return messages;
  const first = messages[0];
  if (first?.role === "user") {
    return [mergeBridgeIntoUserMessage(first, summary), ...messages.slice(1)];
  }
  return [standaloneBridgeMessage(summary), ...messages];
}

/** 单独成条的 bridge 消息（运行中压缩后的续跑上下文）。合入首条 user 的形态不算。 */
export function isCheckpointBridgeMessage(message: Message | undefined): boolean {
  if (!message || message.role !== "user") return false;
  const id = (message as Message & { id?: unknown }).id;
  return typeof id === "string" && id.startsWith(CHECKPOINT_BRIDGE_ID_PREFIX);
}

/**
 * 往请求末尾追加一条 wire-only 的 user 消息（如 plan 模式的补提交提醒）。末尾恰是单独
 * 成条的 bridge（运行中压缩后 segment 为空）时并进 bridge，不出现连续两条 user；并入后
 * 的消息沿用 bridge 的 id，照样被 stripCheckpointBridges 整条丢弃，永不落地。
 */
export function appendWireUserMessage(messages: Message[], message: Message): Message[] {
  const last = messages.at(-1);
  if (message.role !== "user" || !last || !isCheckpointBridgeMessage(last)) {
    return [...messages, message];
  }
  const toBlocks = (content: UserMessage["content"]) =>
    typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  const merged = {
    ...last,
    content: [...toBlocks((last as UserMessage).content), ...toBlocks(message.content)],
  } as Message;
  return [...messages.slice(0, -1), merged];
}

/**
 * 把从请求上下文切出的消息还原成不含 bridge 的形态：合入形态换回原消息，单独成条的
 * bridge 丢弃。runner 把 override.context.messages 整体写进运行时状态，emitted 基线
 * 落在 0 时（子代理压缩后 segment 首条就是 emitted 消息）切片会带上合入形态——不还原
 * 就会被持久化，下一次请求再合入一份。反查表认不出的副本（被克隆过）按首块文本兜底剥离。
 * appendMessagesToConversation 入口同样过一遍：任何漏剥的路径都落不进状态。
 */
export function stripCheckpointBridges(messages: readonly Message[]): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    if (isCheckpointBridgeMessage(message)) continue;
    result.push(bridgeSourceByMerged.get(message) ?? splitMergedBridge(message)?.rest ?? message);
  }
  return result;
}

/** 按首块文本识别合入首条 user 的形态，拆成 bridge 文本与去掉前置块的消息。 */
export function splitMergedBridge(message: Message): { text: string; rest: Message } | undefined {
  const first =
    message.role === "user" && Array.isArray(message.content) ? message.content[0] : undefined;
  if (first?.type !== "text" || !isCheckpointBridgeText(first.text)) return undefined;
  return {
    text: first.text,
    rest: { ...message, content: (message as UserMessage).content.slice(1) } as Message,
  };
}

/** 文本块是否就是 bridge 本身（合入首条 user 的前置块）：首尾标记都要命中。 */
export function isCheckpointBridgeText(text: string): boolean {
  return text.startsWith(CHECKPOINT_OPEN_TAG) && text.endsWith(CHECKPOINT_CLOSE);
}

const bridgeTokensCache = new WeakMap<StoredSummaryMessage, number>();

/**
 * bridge 单独成条时的估算（与 TokenLedger.estimateMessageTokens 同口径：内容
 * 估算 + 消息包裹常量），按 summary 对象身份缓存——每次 rebase 都会读它。
 * contextTokensAfter 在空 segment 上计算，bridge 恰以这一形态计入，账本的
 * checkpoint 下界据此扣回。不接 bridge（渲染为空）时为 0。
 */
export function estimateCheckpointBridgeTokens(summary: StoredSummaryMessage): number {
  const cached = bridgeTokensCache.get(summary);
  if (cached !== undefined) return cached;
  const tokens = renderCheckpointBridgeText(summary)
    ? Math.ceil(estimateContentTokenUnits(standaloneBridgeMessage(summary).content)) +
      MESSAGE_ENVELOPE_TOKENS
    : 0;
  bridgeTokensCache.set(summary, tokens);
  return tokens;
}
