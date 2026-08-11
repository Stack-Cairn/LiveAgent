import type { Context, Message, Usage } from "@earendil-works/pi-ai";

import { estimateTextTokens, estimateTextTokenUnits } from "@liveagent/ui/lib/chat/contextUsage";
import { isCompactionAssistantMessage } from "../conversation/conversationState";
import { readMessageContextUsage, writeAssistantContextUsage } from "./contextUsageMetadata";

// CJK 感知的文本估算已迁入共享层（用量环的检查点估值复用同一口径）；
// 这里 re-export 保持既有调用方与测试不动。
export { estimateTextTokens, estimateTextTokenUnits };

// 逐消息估算只统计正文字符，补一个小常量近似 JSON 包裹（role/键名/引号）的开销。
const MESSAGE_ENVELOPE_TOKENS = 8;

// 消息在本代码库中是不可变值对象（状态变更只新建数组），因此估算结果可跨
// state/segment/临时 state 按对象身份缓存，热路径不再重复序列化。
const messageTokenCache = new WeakMap<object, number>();
const toolsTokenCache = new WeakMap<object, number>();

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

export function deriveContextTokens(context: Context, options?: { fixedTokens?: number }): number {
  const ledger = new TokenLedger();
  ledger.rebase(context, options);
  return ledger.total();
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
  return readMessageContextUsage(message)?.totalTokens ?? getUsageTotalTokens(message.usage);
}

export type TokenLedgerSnapshot = {
  fixedTokens: number;
  observedTokens: number;
  trailingTokens: number;
  estimatedTotalTokens: number;
  hasObservedUsage: boolean;
  hasFixedTokenAnchor: boolean;
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
  private estimatedTotalTokens = 0;
  private hasObservedUsage = false;
  private hasFixedTokenAnchor = false;

  rebase(context: Context, options?: { fixedTokens?: number }): void {
    const estimatedFixedTokens =
      estimateTextTokens(context.systemPrompt ?? "") + estimateToolsTokens(context.tools);
    this.fixedTokens =
      typeof options?.fixedTokens === "number" &&
      Number.isFinite(options.fixedTokens) &&
      options.fixedTokens >= 0
        ? Math.floor(options.fixedTokens)
        : estimatedFixedTokens;
    this.observedTokens = 0;
    this.trailingTokens = 0;
    this.estimatedTotalTokens = this.fixedTokens;
    this.hasObservedUsage = false;
    this.hasFixedTokenAnchor = false;

    const messages = context.messages;
    for (const message of messages) {
      this.estimatedTotalTokens += estimateMessageTokens(message);
    }
    let anchorIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const observed = getMessageObservedTokens(message);
      if (typeof observed === "number") {
        const anchored = readMessageContextUsage(message);
        this.observedTokens = anchored
          ? Math.max(0, observed + this.fixedTokens - anchored.fixedTokens)
          : observed;
        this.hasObservedUsage = true;
        this.hasFixedTokenAnchor = anchored !== undefined;
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
      const estimated = estimateMessageTokens(message);
      const totalBeforeMessage = this.total();
      this.estimatedTotalTokens += estimated;
      let observed = getMessageObservedTokens(message);
      if (
        message.role === "assistant" &&
        !isCompactionAssistantMessage(message) &&
        readMessageContextUsage(message) === undefined
      ) {
        observed ??= totalBeforeMessage + estimated;
        writeAssistantContextUsage(message, {
          totalTokens: observed,
          fixedTokens: this.fixedTokens,
        });
      }
      if (typeof observed === "number") {
        // 新 usage 已覆盖它之前的全部上下文，trailing 归零重新累计。
        this.observedTokens = observed;
        this.hasObservedUsage = true;
        this.hasFixedTokenAnchor = readMessageContextUsage(message) !== undefined;
        this.trailingTokens = 0;
        continue;
      }
      this.trailingTokens += estimateMessageTokens(message);
    }
  }

  total(): number {
    if (!this.hasObservedUsage) return this.estimatedTotalTokens;
    const observedTotal = this.observedTokens + this.trailingTokens;
    return this.hasFixedTokenAnchor
      ? observedTotal
      : Math.max(observedTotal, this.estimatedTotalTokens);
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
      estimatedTotalTokens: this.estimatedTotalTokens,
      hasObservedUsage: this.hasObservedUsage,
      hasFixedTokenAnchor: this.hasFixedTokenAnchor,
      totalTokens: this.total(),
    };
  }
}
