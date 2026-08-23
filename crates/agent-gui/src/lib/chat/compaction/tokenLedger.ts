import type { AssistantMessage, Context, Message, Usage } from "@earendil-works/pi-ai";

import {
  estimateContentBlockTokenUnits,
  estimateContentTokenUnits,
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

// liveAgentContextUsage 印章的不变量：totalTokens 只记录 usage 派生的权威锚点
//（prompt 侧 + 可见输出估算，见 getMessageUsageAnchorTokens；fixedTokens 随印章
// 携带，供跨端 rebase 补偿 system/tools 开销变化），绝不写纯估算——印章随会话
// 持久化且读取侧优先于 usage，一旦写入估算便永久遮蔽后到的真实读数，且没有
// 任何纠正路径。

// 消息在本代码库中是不可变值对象（状态变更只新建数组），因此估算结果可跨
// state/segment/临时 state 按对象身份缓存，热路径不再重复序列化。
const messageTokenCache = new WeakMap<object, number>();
const toolsTokenCache = new WeakMap<object, number>();

// 统一走共享层的内容块口径（文本 CJK 感知、二进制块按计价常量、小结构兜底
// 序列化）。toolResult 的 details 是 UI/记账负载，provider 转换只发送 content，
// 一律不计——shell 全量输出、文件读取元数据都挂在 details 上，计入即双算。
function estimateMessageTokenUnits(message: Message): number {
  if (message.role === "assistant") {
    let units = 0;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "toolCall") {
        units += estimateTextTokenUnits(block.name) + stringifiedTokenUnits(block.arguments);
        continue;
      }
      // hostedSearch 块（供应商托管搜索的 UI 负载）在请求侧被 sanitizer 剥除，
      // 从不发送给模型；按序列化估算会把 queries/sources JSON 虚计进上下文。
      if ((block as { type?: string }).type === "hostedSearch") continue;
      units += estimateContentBlockTokenUnits(block);
    }
    return units;
  }

  if (message.role === "toolResult") {
    return estimateContentTokenUnits(message.content);
  }

  return estimateContentTokenUnits((message as { content?: unknown }).content);
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

// usage 的 prompt 侧（input + cacheRead + cacheWrite）是"这次请求实际发送的
// 上下文规模"的权威度量。totalTokens 还包含本轮全部 output——推理模型的
// reasoning 往往占大头，而 OpenAI/Anthropic 在下一个用户轮都会丢弃上轮
// reasoning、不计入后续 input。拿 totalTokens 当"当前占用"会系统性虚高，
// 并在下一个真实锚点到来时无压缩回落（用量环 44%→16% 跳水的根因之一）。
function getUsagePromptSideTokens(usage: Usage | undefined): number | undefined {
  if (!usage) return undefined;
  let sum = 0;
  for (const value of [usage.input, usage.cacheRead, usage.cacheWrite]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) sum += value;
  }
  return sum > 0 ? Math.floor(sum) : undefined;
}

// 锚点语义 = "下一次请求将要发送的上下文"的最优估计：usage prompt 侧（权威）
// + 本条消息可见内容估算（正文/工具调用/思维摘要——后续请求会重发的部分）。
// stopReason 为 toolUse 时本轮 reasoning 仍留在同一 turn 的后续请求里
//（OpenAI/Anthropic 工具环内都要求回传并计费），补计 usage.reasoning 保证
// 工具环内的压缩保护不因语义收紧而漏触发；turn 终止（stop 等）则随各家语义
// 丢弃。prompt 侧缺失（中转只报 totalTokens）时回退旧口径的 totalTokens。
function getMessageUsageAnchorTokens(message: AssistantMessage): number | undefined {
  const promptSideTokens = getUsagePromptSideTokens(message.usage);
  if (promptSideTokens === undefined) return getUsageTotalTokens(message.usage);
  const reasoning = message.usage?.reasoning;
  const replayedReasoningTokens =
    message.stopReason === "toolUse" &&
    typeof reasoning === "number" &&
    Number.isFinite(reasoning) &&
    reasoning > 0
      ? Math.floor(reasoning)
      : 0;
  return promptSideTokens + estimateMessageTokens(message) + replayedReasoningTokens;
}

// 供应商托管搜索（hostedSearch）轮次的 usage 是服务端多次内部调用的聚合值：
// 搜索结果全文按 input 计费，却不进入后续请求的上下文。实测（issue：用量环
// 44%→16% 跳水）一个搜索轮报 input 110k，而下一轮实测整个持久上下文只有 52k。
// 这类消息一律不作锚点（旧版本盖的印章同为聚合值，一并忽略），内容走估算，
// 下一个普通轮次的真实 usage 会重新锚定。
export function messageHasHostedSearchBlocks(message: AssistantMessage): boolean {
  for (const block of message.content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "hostedSearch"
    ) {
      return true;
    }
  }
  return false;
}

export function getMessageObservedTokens(message: Message): number | undefined {
  if (message.role !== "assistant") return undefined;
  // 压缩 checkpoint 消息带的是 summarizer 请求的规模，不代表当前会话上下文。
  // （布尔化避免类型谓词在 else 分支把 AssistantMessage 收窄成 never。）
  const isCheckpoint: boolean = isCompactionAssistantMessage(message);
  if (isCheckpoint) return undefined;
  if (messageHasHostedSearchBlocks(message)) return undefined;
  return readMessageContextUsage(message)?.totalTokens ?? getMessageUsageAnchorTokens(message);
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

  /**
   * suppressUsageAnchors：调用方明确知道这批消息的 usage 不可信（如托管搜索
   * 轮次的聚合值，且消息对象可能尚未带上 hostedSearch 块——搜索收尾是异步
   * 替换，内容检测在提交时刻不可靠）时强制走估算路径，不锚定也不盖章。
   */
  addMessages(messages: readonly Message[], options?: { suppressUsageAnchors?: boolean }): void {
    for (const message of messages) {
      if (!this.hasObservedUsage) {
        this.estimatedTotalTokens += estimateMessageTokens(message);
      }
      const observed = options?.suppressUsageAnchors
        ? undefined
        : getMessageObservedTokens(message);
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
    // 有 usage 锚点时恒信 observed + trailing：估算口径偏保守（CJK 0.7 tok/char、
    // 二进制块按计价量级常量），与真实读数取 max 会让环读数与自动压缩被估算
    // 劫持。估算只在完全没有 usage 锚点时兜底。
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
