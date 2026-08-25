import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";

import {
  assistantAnchorTokens,
  contentReplaysReasoning,
  estimateContentBlockTokenUnits,
  estimateContentTokenUnits,
  estimateJsonTokens,
  estimateTextTokens,
  estimateTextTokenUnits,
  estimateThinkingReplayTokenUnits,
  hostedSearchFollowUpTokens,
  isStrippedHostedSearchUsage,
  MESSAGE_ENVELOPE_TOKENS,
  stringifiedTokenUnits,
} from "@liveagent/ui/lib/chat/contextUsage";
import { isCompactionAssistantMessage } from "../conversation/conversationState";

// CJK 感知的文本估算、消息包裹常量与非文本值序列化估算全部取自共享层
//（用量环的检查点估值与 WebUI 倒扫复用同一口径，调参只改共享层）；
// 这里 re-export 文本估算保持既有调用方与测试不动。
export { estimateTextTokens, estimateTextTokenUnits };

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
  // 工具定义是 JSON schema，不是散文：走 estimateJsonTokens（约 2.5 字/token），
  // 不要用 chars/4，否则 fixedTokens 会比真实首轮 prompt 少 4–8k。
  const tokens = estimateJsonTokens(JSON.stringify(tools));
  toolsTokenCache.set(tools, tokens);
  return tokens;
}

export type TokenLedgerRebaseOptions = {
  /**
   * fixed 的下界校准（不是替换）：来自上一次真实请求口径的账本快照，可能
   * 含当前上下文缺失的段（后台会话拿不到 skills/memory 提示词）。压缩后
   * systemPrompt 已含新摘要，若整段替换会把摘要从估值里丢掉——首次压缩后
   * 检查点偏低、下一次发送环猛增；旧快照偏大时则检查点偏高、发送时倒退。
   */
  fixedTokens?: number;
  /**
   * provider 边界才拼进 systemPrompt 的追加段估算（agent 模式的工具执行
   * 规则 toolsSuffix 实测 ~4k token）。传入账本的上下文都在拼接之前，不补
   * 会让压缩后的无锚点窗口（检查点值 + 首个回复到达前）系统性少算，首个
   * 真实 usage 一到环就跳涨。
   */
  fixedOverheadTokens?: number;
};

export function deriveContextTokens(context: Context, options?: TokenLedgerRebaseOptions): number {
  const ledger = new TokenLedger();
  ledger.rebase(context, options);
  return ledger.total();
}

// 供应商托管搜索（hostedSearch）轮次的 usage.input / totalTokens 是服务端多次
// 内部调用的聚合值：搜索结果全文按 input 计费，却不进入后续请求。实测一个
// 搜索轮报 input 110k，而下一轮持久上下文只有 52k——这两项绝不能当整段锚点。
// 热缓存时 cacheRead+output 仍是下一请求规模（hostedSearchFollowUpTokens）。
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

// 锚点扣减所需的思维链估算（仅确认不重放、且 usage 未上报 reasoning 时生效）。
function messageThinkingTokenUnits(message: AssistantMessage): number {
  let units = 0;
  for (const block of message.content) {
    if (!block || typeof block !== "object" || block.type !== "thinking") continue;
    units += estimateThinkingReplayTokenUnits(block);
  }
  return units;
}

// 锚点语义唯一定义在共享层：普通轮走 assistantAnchorTokens（usage 纯算术，
// 绝不掺正文估算）；托管搜索 / sanitizer 剥离后的副本只走
// hostedSearchFollowUpTokens（cacheRead+output）。压缩 checkpoint 带的是
// summarizer 请求规模，一律排除。
export function getMessageObservedTokens(
  message: Message,
  options?: { minPrefixTokens?: number },
): number | undefined {
  if (message.role !== "assistant") return undefined;
  // （布尔化避免类型谓词在 else 分支把 AssistantMessage 收窄成 never。）
  const isCheckpoint: boolean = isCompactionAssistantMessage(message);
  if (isCheckpoint) return undefined;
  const minPrefixTokens =
    typeof options?.minPrefixTokens === "number" &&
    Number.isFinite(options.minPrefixTokens) &&
    options.minPrefixTokens > 0
      ? Math.floor(options.minPrefixTokens)
      : 0;
  if (messageHasHostedSearchBlocks(message) || isStrippedHostedSearchUsage(message.usage)) {
    return hostedSearchFollowUpTokens(message.usage, minPrefixTokens);
  }
  return assistantAnchorTokens({
    usage: message.usage,
    stopReason: message.stopReason,
    thinkingTokenUnits: messageThinkingTokenUnits(message),
    replayReasoning: contentReplaysReasoning(message.content, {
      api: message.api,
      stopReason: message.stopReason,
      reasoningTokens: message.usage?.reasoning,
    }),
  });
}

export type TokenLedgerSnapshot = {
  fixedTokens: number;
  observedTokens: number;
  trailingTokens: number;
  // 仅在无 usage 锚点时维护（total() 也只在该情形读取）；有锚点时恒为 fixedTokens。
  estimatedTotalTokens: number;
  hasObservedUsage: boolean;
  totalTokens: number;
};

/**
 * 每会话上下文规模账本：observed（最近一次真实 usage 锚点，已含 system/tools/
 * 全部历史）+ trailing（其后消息的估算增量）。有 usage 锚点时读数恒为
 * observed + trailing——估算口径有意偏保守（高估），绝不允许覆盖真实读数；
 * 仅在完全没有 usage 锚点时退回 fixed（system+tools 估算）+ 逐消息估算。
 * 所有读数 O(1)，重建仅在每次请求开始时执行一次。
 */
export class TokenLedger {
  private fixedTokens = 0;
  private observedTokens = 0;
  private trailingTokens = 0;
  private estimatedTotalTokens = 0;
  private hasObservedUsage = false;

  rebase(context: Context, options?: TokenLedgerRebaseOptions): void {
    const fixedOverheadTokens =
      typeof options?.fixedOverheadTokens === "number" &&
      Number.isFinite(options.fixedOverheadTokens) &&
      options.fixedOverheadTokens > 0
        ? Math.floor(options.fixedOverheadTokens)
        : 0;
    const estimatedFixedTokens =
      estimateTextTokens(context.systemPrompt ?? "") +
      estimateToolsTokens(context.tools) +
      fixedOverheadTokens;
    const calibrationFixedTokens =
      typeof options?.fixedTokens === "number" &&
      Number.isFinite(options.fixedTokens) &&
      options.fixedTokens >= 0
        ? Math.floor(options.fixedTokens)
        : undefined;
    // 校准值只作下界（见 TokenLedgerRebaseOptions.fixedTokens）：取 max 保证
    // 本上下文真实存在的段（新摘要）绝不被旧快照替换掉。
    this.fixedTokens =
      calibrationFixedTokens === undefined
        ? estimatedFixedTokens
        : Math.max(estimatedFixedTokens, calibrationFixedTokens);
    this.observedTokens = 0;
    this.trailingTokens = 0;
    this.estimatedTotalTokens = this.fixedTokens;
    this.hasObservedUsage = false;

    const messages = context.messages;
    let anchorIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const observed = getMessageObservedTokens(messages[index], {
        minPrefixTokens: this.fixedTokens,
      });
      if (typeof observed === "number") {
        this.observedTokens = observed;
        this.hasObservedUsage = true;
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
   * suppressUsageAnchors：调用方明确知道这批消息的 input/totalTokens 不可信
   *（托管搜索聚合值，且消息对象可能尚未带上 hostedSearch 块——搜索收尾是
   * 异步替换，内容检测在提交时刻不可靠）。整段锚点仍禁止；热缓存时仍可用
   * cacheRead+output 作为下一请求规模。
   */
  addMessages(messages: readonly Message[], options?: { suppressUsageAnchors?: boolean }): void {
    for (const message of messages) {
      if (!this.hasObservedUsage) {
        this.estimatedTotalTokens += estimateMessageTokens(message);
      }
      const observed = options?.suppressUsageAnchors
        ? hostedSearchFollowUpTokens(
            message.role === "assistant" ? message.usage : undefined,
            this.fixedTokens,
          )
        : getMessageObservedTokens(message, { minPrefixTokens: this.fixedTokens });
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
      totalTokens: this.total(),
    };
  }
}
