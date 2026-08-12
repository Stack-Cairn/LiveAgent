import type { Context, Message, Usage } from "@earendil-works/pi-ai";

import {
  estimateTextTokens,
  estimateTextTokenUnits,
  MESSAGE_ENVELOPE_TOKENS,
  stringifiedTokenUnits,
} from "@liveagent/ui/lib/chat/contextUsage";
import { isCompactionAssistantMessage } from "../conversation/conversationState";
import { readMessageContextUsage, writeAssistantContextUsage } from "./contextUsageMetadata";

// CJK 感知的文本估算、消息包裹常量与非文本值序列化估算全部取自共享层
//（用量环的检查点估值与 WebUI 倒扫复用同一口径，调参只改共享层）；
// 这里 re-export 文本估算保持既有调用方与测试不动。
export { estimateTextTokens, estimateTextTokenUnits };

// liveAgentContextUsage 印章的不变量：totalTokens 只记录 usage 派生的权威值
//（fixedTokens 随印章携带，供跨端 rebase 补偿 system/tools 开销变化），绝不写
// 估算——印章随会话持久化且读取侧优先于 usage，一旦写入估算便永久遮蔽后到的
// 真实读数，且没有任何纠正路径。

// 消息在本代码库中是不可变值对象（状态变更只新建数组），因此估算结果可跨
// state/segment/临时 state 按对象身份缓存，热路径不再重复序列化。
const messageTokenCache = new WeakMap<object, number>();
const toolsTokenCache = new WeakMap<object, number>();

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
  // 仅在无 usage 锚点时维护（total() 也只在该情形读取）；有锚点时恒为 fixedTokens。
  estimatedTotalTokens: number;
  hasObservedUsage: boolean;
  hasFixedTokenAnchor: boolean;
  totalTokens: number;
};

/**
 * 每会话上下文规模账本：observed（最近一次真实 usage，已含 system/tools/全部历史）
 * + trailing（其后消息的估算增量）。有 usage 锚点时读数恒为 observed + trailing——
 * 估算口径有意偏保守（高估），绝不允许覆盖真实读数；仅在完全没有 usage 锚点时
 * 退回 fixed（system+tools 估算）+ 逐消息估算。所有读数 O(1)，重建仅在每次请求
 * 开始时执行一次。
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
    // estimatedTotalTokens 仅在无锚点时维护：有锚点时 total() 不读它，跳过
    // 全量估算循环让重建成本随锚点后的消息数而非全历史增长。
    if (anchorIndex < 0) {
      for (const message of messages) {
        this.estimatedTotalTokens += estimateMessageTokens(message);
      }
    }
    for (let index = anchorIndex + 1; index < messages.length; index += 1) {
      this.trailingTokens += estimateMessageTokens(messages[index]);
    }
  }

  addMessages(messages: readonly Message[]): void {
    for (const message of messages) {
      if (!this.hasObservedUsage) {
        this.estimatedTotalTokens += estimateMessageTokens(message);
      }
      const observed = getMessageObservedTokens(message);
      if (typeof observed === "number") {
        if (
          message.role === "assistant" &&
          !isCompactionAssistantMessage(message) &&
          readMessageContextUsage(message) === undefined
        ) {
          // 印章只盖 usage 派生的权威值（见文件头部不变量）；无 usage 的
          // assistant 消息不盖章，走下方 trailing 估算路径。
          writeAssistantContextUsage(message, {
            totalTokens: observed,
            fixedTokens: this.fixedTokens,
          });
        }
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
    // 有 usage 锚点时恒信 observed + trailing：估算（尤其 base64 图片按序列化
    // 字符数、CJK 按 0.7 tok/char）有意高估，与真实读数取 max 会让环读数与
    // 自动压缩被估算劫持。估算只在完全没有 usage 锚点时兜底。
    if (!this.hasObservedUsage) return this.estimatedTotalTokens;
    return this.observedTokens + this.trailingTokens;
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
