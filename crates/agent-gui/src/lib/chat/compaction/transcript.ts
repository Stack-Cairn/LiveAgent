import type { Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@liveagent/ui/lib/chat/contextUsage";
import { isCheckpointBridgeMessage, splitMergedBridge } from "./bridge";

// ============================================================================
// 对话 → 带标签的纯文本：transcript 档的摘要输入与 deterministic 档的兜底正文共用。
// 不再 JSON.stringify 消息——图片 / 附件只留占位（base64 不进摘要请求），思考内容
// 丢弃，工具参数与结果截断；上一份 checkpoint 的 bridge 不截断，包进
// <previous_checkpoint>。
// ============================================================================

const CLIP_MARKER = "\n[… truncated …]\n";
// 每条之间的分隔开销。
const ENTRY_OVERHEAD_TOKENS = 4;
// 第一条放不下的条目，剩余预算至少这么多才值得截断收下，否则直接停。
const CLIP_MIN_TOKENS = 256;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 头 70% + 尾 30%，中间换成截断标记。切点不落在代理对中间：孤立代理项会序列化
 * 成 \ud83d，Rust serde_json 拒收后整份 summary 被跳过。
 */
export function clipMiddle(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  let head = Math.floor(limit * 0.7);
  let tailStart = text.length - (limit - head);
  if (isHighSurrogate(text.charCodeAt(head - 1))) head -= 1;
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
  return `${text.slice(0, head)}${CLIP_MARKER}${text.slice(tailStart)}`;
}

/** 按估算逐步收缩 clipMiddle 直到放进 token 预算；怎么都放不下时返回空串。 */
export function clipToTokens(text: string, budgetTokens: number): string {
  const total = estimateTextTokens(text);
  let targetChars = Math.floor(text.length * Math.min(1, budgetTokens / Math.max(1, total)));
  for (let attempt = 0; attempt < 64 && targetChars > 0; attempt += 1) {
    const clipped = clipMiddle(text, targetChars);
    if (estimateTextTokens(clipped) <= budgetTokens) return clipped;
    targetChars = Math.floor(targetChars * 0.9);
  }
  return "";
}

/**
 * 从新到旧整条装入预算（每条另计 overheadTokens）；第一条放不下的在剩余 ≥256 token
 * 时经 clip 截断收下，然后停止。kept 按原顺序；omitted = 最早被整条丢弃的条目数。
 * transcript 条目与保留原话共用。
 */
export function fillNewestFirst<T>(
  items: readonly T[],
  budgetTokens: number,
  overheadTokens: number,
  textOf: (item: T) => string,
  clip: (item: T, clipped: string) => T,
): { kept: T[]; omitted: number } {
  const kept: T[] = [];
  let remaining = budgetTokens;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const text = textOf(items[index]);
    const cost = estimateTextTokens(text) + overheadTokens;
    if (cost <= remaining) {
      kept.push(items[index]);
      remaining -= cost;
      continue;
    }
    const clipped =
      remaining >= CLIP_MIN_TOKENS ? clipToTokens(text, remaining - overheadTokens) : "";
    if (clipped) kept.push(clip(items[index], clipped));
    return { kept: kept.reverse(), omitted: clipped ? index : index + 1 };
  }
  return { kept: kept.reverse(), omitted: 0 };
}

type TranscriptOptions = {
  budgetTokens: number;
  toolResultChars?: number;
  toolArgsChars?: number;
};

function contentText(content: UserMessage["content"] | ToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      block.type === "text" ? block.text : block.type === "image" ? "[image]" : "[attachment]",
    )
    .join("\n")
    .trim();
}

function stringifyArguments(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function serializeMessage(message: Message, toolResultChars: number, toolArgsChars: number) {
  if (message.role === "user") {
    const text = contentText(message.content).trim();
    return text ? `[User]\n${text}` : "";
  }
  if (message.role === "toolResult") {
    const label = message.isError ? "Tool error" : "Tool result";
    return `[${label} ${message.toolName}]\n${clipMiddle(contentText(message.content), toolResultChars)}`;
  }
  // assistant：正文与工具调用按块序输出，思考与其他非正文块丢弃。
  const parts: string[] = [];
  let text = "";
  const flushText = () => {
    if (text.trim()) parts.push(`[Assistant]\n${text.trim()}`);
    text = "";
  };
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "toolCall") {
      flushText();
      parts.push(
        `[Tool call] ${block.name}(${clipMiddle(stringifyArguments(block.arguments), toolArgsChars)})`,
      );
    }
  }
  flushText();
  return parts.join("\n");
}

/**
 * 序列化成 [User] / [Assistant] / [Tool call] name(args) / [Tool result name] /
 * [Tool error name] 标签文本。bridge（单独成条或合入首条 user 的前置块）原样输出为
 * <previous_checkpoint>，其余从新到旧装入预算；装不下的更早消息以一行省略标注代替。
 */
export function serializeTranscript(
  messages: readonly Message[],
  { budgetTokens, toolResultChars = 2_000, toolArgsChars = 500 }: TranscriptOptions,
): string {
  let checkpoint = "";
  const entries: string[] = [];
  for (const message of messages) {
    if (isCheckpointBridgeMessage(message)) {
      checkpoint = contentText((message as UserMessage).content);
      continue;
    }
    const merged = splitMergedBridge(message);
    if (merged) checkpoint = merged.text;
    const entry = serializeMessage(merged?.rest ?? message, toolResultChars, toolArgsChars);
    if (entry) entries.push(entry);
  }

  const head = checkpoint ? `<previous_checkpoint>\n${checkpoint}\n</previous_checkpoint>` : "";
  const { kept, omitted } = fillNewestFirst(
    entries,
    Math.max(0, Math.floor(budgetTokens)) - estimateTextTokens(head),
    ENTRY_OVERHEAD_TOKENS,
    (entry) => entry,
    (_entry, clipped) => clipped,
  );
  return [head, omitted > 0 ? `[… ${omitted} earlier messages omitted …]` : "", ...kept]
    .filter(Boolean)
    .join("\n\n");
}
