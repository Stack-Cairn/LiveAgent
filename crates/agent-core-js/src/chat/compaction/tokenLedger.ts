import type { Context, Message, Usage } from "@earendil-works/pi-ai";

import { isCompactionAssistantMessage } from "../conversation/conversationState";

const CHARS_PER_TOKEN = 4;
// CJK 文字的 token 密度远高于西文：主流 tokenizer（o200k/cl100k/Claude）大约
// 每 1.4~1.7 个汉字 1 token。按 chars/4 估会低估约 2.5~3 倍，导致压缩触发
// 严重偏晚甚至撞上下文上限。取 0.7 token/字作为偏保守（宁早勿晚）的估计。
const CJK_TOKENS_PER_CHAR = 0.7;
// 逐消息估算只统计正文字符，补一个小常量近似 JSON 包裹（role/键名/引号）的开销。
const MESSAGE_ENVELOPE_TOKENS = 8;

// 消息在本代码库中是不可变值对象（状态变更只新建数组），因此估算结果可跨
// state/segment/临时 state 按对象身份缓存，热路径不再重复序列化。
const messageTokenCache = new WeakMap<object, number>();
const toolsTokenCache = new WeakMap<object, number>();

// CJK 统一表意文字（含扩展 A）、假名、谚文、兼容表意/形式与全角标点。
// 这些区段全部落在 BMP，按 UTF-16 code unit 判断即可；增补平面字符
// （emoji 等）按两个西文字符计入 chars/4 路径。
function isCjkCodeUnit(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * 文本的分数 token 估算（不 trim、不取整）。按字符类别累加：CJK 字符按
 * CJK_TOKENS_PER_CHAR，其余按 1/CHARS_PER_TOKEN。可加性成立：对任意切分，
 * 分段估算之和恒等于整体估算，因此流式增量可按 delta 累加。
 */
export function estimateTextTokenUnits(text: string): number {
  let cjkChars = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isCjkCodeUnit(text.charCodeAt(index))) cjkChars += 1;
  }
  return (text.length - cjkChars) / CHARS_PER_TOKEN + cjkChars * CJK_TOKENS_PER_CHAR;
}

export function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.ceil(estimateTextTokenUnits(normalized));
}

function stringifiedTokenUnits(value: unknown): number {
  if (typeof value === "string") return estimateTextTokenUnits(value);
  if (value == null) return 0;
  try {
    const serialized = JSON.stringify(value);
    return serialized ? estimateTextTokenUnits(serialized) : 0;
  } catch {
    return estimateTextTokenUnits(String(value));
  }
}

function estimateMessageTokenUnits(message: Message): number {
  let units = 0;
  if (message.role === "assistant") {
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" || block.type === "thinking") {
        const text =
          (block as { text?: string; thinking?: string }).text ??
          (block as { thinking?: string }).thinking;
        if (typeof text === "string") units += estimateTextTokenUnits(text);
        continue;
      }
      if (block.type === "toolCall") {
        units += estimateTextTokenUnits(block.name) + stringifiedTokenUnits(block.arguments);
        continue;
      }
      units += stringifiedTokenUnits(block);
    }
    return units;
  }

  if (message.role === "toolResult") {
    for (const block of message.content) {
      if (block && typeof block === "object" && block.type === "text") {
        units += typeof block.text === "string" ? estimateTextTokenUnits(block.text) : 0;
      } else {
        units += stringifiedTokenUnits(block);
      }
    }
    if (message.details != null) units += stringifiedTokenUnits(message.details);
    return units;
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return estimateTextTokenUnits(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: string }).text;
        units += typeof text === "string" ? estimateTextTokenUnits(text) : 0;
      } else {
        units += stringifiedTokenUnits(block);
      }
    }
    return units;
  }
  return stringifiedTokenUnits(content);
}

export function estimateMessageTokens(message: Message): number {
  const cached = messageTokenCache.get(message);
  if (cached !== undefined) return cached;
  const tokens = Math.ceil(estimateMessageTokenUnits(message)) + MESSAGE_ENVELOPE_TOKENS;
  messageTokenCache.set(message, tokens);
  return tokens;
}

export function estimateToolsTokens(tools: Context["tools"]): number {
  if (!tools || tools.length === 0) return 0;
  const cached = toolsTokenCache.get(tools);
  if (cached !== undefined) return cached;
  const tokens = estimateTextTokens(JSON.stringify(tools));
  toolsTokenCache.set(tools, tokens);
  return tokens;
}

export function getUsageTotalTokens(usage: Usage | undefined): number | undefined {
  if (!usage) return undefined;

  const totalTokens = usage.totalTokens;
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
    return Math.max(0, Math.floor(totalTokens));
  }

  // usage.reasoning 是 output 的子集（pi-ai types.d.ts），推导时绝不能单独累加。
  const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  const derivedTotal = parts.reduce<number>((sum, value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return sum;
    return sum + value;
  }, 0);
  return derivedTotal > 0 ? Math.floor(derivedTotal) : undefined;
}

export function getMessageObservedTokens(message: Message): number | undefined {
  if (message.role !== "assistant") return undefined;
  // 压缩 checkpoint 消息带的是 summarizer 请求的规模，不代表当前会话上下文。
  // （布尔化避免类型谓词在 else 分支把 AssistantMessage 收窄成 never。）
  const isCheckpoint: boolean = isCompactionAssistantMessage(message);
  if (isCheckpoint) return undefined;
  return getUsageTotalTokens(message.usage);
}

export type TokenLedgerSnapshot = {
  fixedTokens: number;
  observedTokens: number;
  trailingTokens: number;
  hasObservedUsage: boolean;
  totalTokens: number;
};

/**
 * 每会话上下文规模账本：observed（最近一次真实 usage，已含 system/tools/全部历史）
 * + trailing（其后消息的估算增量）。无 usage 锚点时退回 fixed（system+tools 估算）
 * + trailing。所有读数 O(1)，重建仅在每次请求开始时 O(n) 一次。
 */
export class TokenLedger {
  private fixedTokens = 0;
  private observedTokens = 0;
  private trailingTokens = 0;
  private hasObservedUsage = false;

  rebase(context: Context): void {
    this.fixedTokens =
      estimateTextTokens(context.systemPrompt ?? "") + estimateToolsTokens(context.tools);
    this.observedTokens = 0;
    this.trailingTokens = 0;
    this.hasObservedUsage = false;

    const messages = context.messages;
    let anchorIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const observed = getMessageObservedTokens(messages[index]);
      if (typeof observed === "number") {
        this.observedTokens = observed;
        this.hasObservedUsage = true;
        anchorIndex = index;
        break;
      }
    }
    for (let index = anchorIndex + 1; index < messages.length; index += 1) {
      this.trailingTokens += estimateMessageTokens(messages[index]);
    }
  }

  addMessages(messages: readonly Message[]): void {
    for (const message of messages) {
      const observed = getMessageObservedTokens(message);
      if (typeof observed === "number") {
        // 新 usage 已覆盖它之前的全部上下文，trailing 归零重新累计。
        this.observedTokens = observed;
        this.hasObservedUsage = true;
        this.trailingTokens = 0;
        continue;
      }
      this.trailingTokens += estimateMessageTokens(message);
    }
  }

  total(): number {
    const base = this.hasObservedUsage ? this.observedTokens : this.fixedTokens;
    return base + this.trailingTokens;
  }

  /**
   * pendingTokenUnits 是流式增量的分数 token 估算（调用方按 delta 用
   * estimateTextTokenUnits 累加），避免每次判定重扫全文。
   */
  totalWithPendingTokens(pendingTokenUnits: number): number {
    if (!Number.isFinite(pendingTokenUnits) || pendingTokenUnits <= 0) return this.total();
    return this.total() + Math.ceil(pendingTokenUnits);
  }

  snapshot(): TokenLedgerSnapshot {
    return {
      fixedTokens: this.fixedTokens,
      observedTokens: this.observedTokens,
      trailingTokens: this.trailingTokens,
      hasObservedUsage: this.hasObservedUsage,
      totalTokens: this.total(),
    };
  }
}
