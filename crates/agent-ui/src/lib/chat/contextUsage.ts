// 上下文用量的两端单一真源：颜色分档阈值、手动压缩门槛、锚点语义
//（assistantAnchorTokens——"下一次请求将要发送的上下文规模"的唯一定义），
// 以及从 transcript 倒扫补算 trailing 消息的口径。锚点一律在读取时从轮次的
// usage + stopReason + 思维链正文现算，不持久化、不随事件携带（唯一例外是
// 压缩检查点快照，它无法从 usage 推导）。GUI 运行中读 TokenLedger（同一锚点
// 函数），空闲与 WebUI 走这里的倒扫。
//
// CJK 感知的文本 token 估算也定义在此（原 agent-gui compaction/tokenLedger.ts，
// 迁入共享层供压缩检查点估值复用；tokenLedger 从这里 re-export 保持旧调用方不动）。

/** 黄色起点，同时是手动压缩可用的起点（issue #359：占用 ≥50% 才允许压缩）。 */
export const CONTEXT_USAGE_WARN_RATIO = 0.5;
/** 红色起点。 */
export const CONTEXT_USAGE_DANGER_RATIO = 0.8;

export type ContextUsageLevel = "ok" | "warn" | "danger";

export function contextUsageLevel(ratio: number): ContextUsageLevel {
  if (ratio >= CONTEXT_USAGE_DANGER_RATIO) return "danger";
  if (ratio >= CONTEXT_USAGE_WARN_RATIO) return "warn";
  return "ok";
}

export function canManualCompact(ratio: number): boolean {
  return ratio >= CONTEXT_USAGE_WARN_RATIO;
}

export function contextUsageRatio(
  totalTokens: number | undefined,
  contextWindow: number | undefined,
): number {
  if (
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens) ||
    totalTokens <= 0 ||
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return 0;
  }
  return totalTokens / contextWindow;
}

const CHARS_PER_TOKEN = 4;
// CJK 文字的 token 密度远高于西文：主流 tokenizer（o200k/cl100k/Claude）大约
// 每 1.4~1.7 个汉字 1 token。按 chars/4 估会低估约 2.5~3 倍，导致压缩触发
// 严重偏晚甚至撞上下文上限。取 0.7 token/字作为偏保守（宁早勿晚）的估计。
const CJK_TOKENS_PER_CHAR = 0.7;
// JSON / tool schema：o200k 把引号、括号、短 key 拆成大量 1-token 碎片，
// 大约 2.5 字/token。按散文 chars/4 估 50k 工具 JSON 只有 12.5k，而同工作区
// 真实首轮 prompt 是 21–26k（system ~4.6k + tools）。搜索后续轮的 cacheRead
// 也稳定在 ~29k（同一前缀），差额几乎全在工具侧。
const JSON_TOKENS_PER_CHAR = 0.4;

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

/**
 * JSON / schema 的分数 token 估算。非 CJK 按 JSON_TOKENS_PER_CHAR，CJK 仍
 * 走 CJK_TOKENS_PER_CHAR。只给工具定义等结构化负载用，散文继续走
 * estimateTextTokenUnits（chars/4），避免把英文正文抬高。
 */
export function estimateJsonTokenUnits(text: string): number {
  let cjkChars = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isCjkCodeUnit(text.charCodeAt(index))) cjkChars += 1;
  }
  return (text.length - cjkChars) * JSON_TOKENS_PER_CHAR + cjkChars * CJK_TOKENS_PER_CHAR;
}

export function estimateJsonTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(estimateJsonTokenUnits(text));
}

// 两端 transcript 项的最小结构投影：GUI RenderTimelineItem（检查点 kind:"summary"）
// 与 WebUI TranscriptRow（检查点 kind:"checkpoint"）经结构化类型直接传入。
// attachments 两端同为 PendingUploadedFile 投影（GUI 时间线项 / WebUI user 行）。
// 轮次 meta 只需 usage + stopReason：锚点在倒扫时现算，meta 不携带任何派生值。
export type ContextUsageScanItem = {
  kind: string;
  text?: string;
  attachments?: readonly unknown[];
  rounds?: readonly {
    meta?: {
      usage?: ContextUsageAnchorUsage;
      stopReason?: string;
      api?: string;
      contextRelevant?: boolean;
    };
    blocks?: readonly {
      kind?: string;
      text?: string;
      item?: unknown;
      /** OpenAI Responses 重放的 reasoning item 估算（thinkingSignature），不是 UI 摘要。 */
      replayTokenUnits?: number;
    }[];
  }[];
  content?: string;
  contextUsageTokens?: number;
};

export type ContextUsageLiveTail = {
  liveRounds: NonNullable<ContextUsageScanItem["rounds"]>;
  draftAssistantText: string;
};

export function buildContextUsageScanItems(
  historyItems: readonly ContextUsageScanItem[],
  live: ContextUsageLiveTail | null,
): readonly ContextUsageScanItem[] {
  if (!live) return historyItems;
  if (live.liveRounds.length > 0) {
    return [...historyItems, { kind: "assistant", rounds: live.liveRounds }];
  }
  if (live.draftAssistantText) {
    return [
      ...historyItems,
      {
        kind: "assistant",
        rounds: [{ blocks: [{ kind: "text", text: live.draftAssistantText }] }],
      },
    ];
  }
  return historyItems;
}

// 逐消息估算只统计正文字符，补一个小常量近似 JSON 包裹（role/键名/引号）的
// 开销。两端（GUI TokenLedger 与 WebUI 倒扫）共用此口径，调参只改这里。
export const MESSAGE_ENVELOPE_TOKENS = 8;

// 结构化小负载的估算口径（字符串直估，其余 JSON 序列化后估）。只作为
// estimateContentBlockTokenUnits 的兜底叶子使用；带 base64 的二进制块绝不能
// 走到这里（见 BINARY_BLOCK_TOKENS）。
export function stringifiedTokenUnits(value: unknown): number {
  if (typeof value === "string") return estimateTextTokenUnits(value);
  if (value == null) return 0;
  try {
    const serialized = JSON.stringify(value);
    return serialized ? estimateTextTokenUnits(serialized) : 0;
  } catch {
    return estimateTextTokenUnits(String(value));
  }
}

// 模型对图片等二进制附件按图幅/文件计价（Anthropic ≈ 宽×高/750、OpenAI 按
// tile），单块通常数百到 ~2k token，与 base64 长度无关。估算侧拿不到解码
// 尺寸，取计价量级上限的常量。按序列化字符数估会差两个数量级——一张 400KB
// 图的 base64 虚报 ~13 万 token，用量环随锚点在估算/真实 usage 间切换而剧烈
// 跳变，自动压缩也会被幻影读数提前触发。
export const BINARY_BLOCK_TOKENS = 1_600;

// OpenAI Responses 把上一轮 thinking 存成 reasoning item JSON（含
// encrypted_content），下一请求 convertResponsesMessages 原样推进 input。
// UI 只展示 summary 短文；按摘要估算会把空闲环压到真实 prompt 的六成
//（实测搜索轮结束后 ~19k，下一短回复真实 usage ~32k）。
export function isResponsesReasoningSignature(signature: string): boolean {
  const trimmed = signature.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    return parsed?.type === "reasoning";
  } catch {
    return false;
  }
}

export type ThinkingReplayBlock = {
  type?: unknown;
  kind?: unknown;
  text?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
  replayTokenUnits?: unknown;
};

function thinkingBlockText(block: ThinkingReplayBlock): string {
  if (typeof block.thinking === "string") return block.thinking;
  if (typeof block.text === "string") return block.text;
  return "";
}

/**
 * 下一请求实际会发送的思维链规模：Responses 重放 thinkingSignature 整段
 * JSON；其余供应商重放 thinking 正文（Anthropic 带签名回传）。已算好的
 * replayTokenUnits（转录块上）优先，避免把加密 blob 再塞进 UI。
 *
 * encrypted_content 是高熵 base64，o200k 大约 1 token / 2.5 字，chars/4
 * 会低估约 40%，空闲环仍会在下一短回复被真实 usage 抬一截。
 */
const RESPONSES_ENCRYPTED_TOKENS_PER_CHAR = 0.4;

function estimateResponsesReasoningSignatureUnits(signature: string): number {
  try {
    const parsed = JSON.parse(signature) as { encrypted_content?: unknown };
    const encrypted = typeof parsed.encrypted_content === "string" ? parsed.encrypted_content : "";
    if (!encrypted) return estimateTextTokenUnits(signature);
    const wrapperLength = Math.max(0, signature.length - encrypted.length);
    return wrapperLength / CHARS_PER_TOKEN + encrypted.length * RESPONSES_ENCRYPTED_TOKENS_PER_CHAR;
  } catch {
    return estimateTextTokenUnits(signature);
  }
}

export function estimateThinkingReplayTokenUnits(block: ThinkingReplayBlock): number {
  const replayed = positiveTokenCount(block.replayTokenUnits);
  if (replayed !== undefined) return replayed;
  const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : "";
  if (signature && isResponsesReasoningSignature(signature)) {
    return estimateResponsesReasoningSignatureUnits(signature);
  }
  const text = thinkingBlockText(block);
  return text ? estimateTextTokenUnits(text) : 0;
}

function isThinkingContentBlock(block: ThinkingReplayBlock): boolean {
  return (
    block.type === "thinking" ||
    block.kind === "thinking" ||
    typeof block.thinking === "string" ||
    typeof block.thinkingSignature === "string"
  );
}

/**
 * 该轮思维链是否会进入下一次请求并计费。toolUse 环内各家都要求回传；
 * OpenAI Responses 的 reasoning item 签名、Anthropic 的长签名同样会重放。
 * 短标记（如 completions 路径的 "reasoning_content"）不是协议状态，不算。
 */
export function contentReplaysReasoning(
  content: readonly unknown[] | undefined,
  options?: { api?: string; stopReason?: string; reasoningTokens?: number },
): boolean {
  if (options?.stopReason === "toolUse") return true;
  const api = typeof options?.api === "string" ? options.api : "";
  if (api.includes("responses") && flooredTokens(options?.reasoningTokens) > 0) {
    return true;
  }
  for (const block of content ?? []) {
    if (!block || typeof block !== "object") continue;
    const record = block as ThinkingReplayBlock;
    if (positiveTokenCount(record.replayTokenUnits) !== undefined) return true;
    const signature = typeof record.thinkingSignature === "string" ? record.thinkingSignature : "";
    if (signature && isResponsesReasoningSignature(signature)) return true;
    if (signature.trim().length >= 16) return true;
  }
  return false;
}

// 内容块的统一估算：文本/思维链按 CJK 感知直估，Responses 重放的
// thinkingSignature 按签名正文估，携带 base64 负载的二进制块（pi-ai
// ImageContent 等 {type, data, mimeType} 形态）按常量，其余小型结构块按
// 序列化。GUI TokenLedger 与 WebUI 倒扫共用，两端口径一致。
export function estimateContentBlockTokenUnits(block: unknown): number {
  if (typeof block === "string") return estimateTextTokenUnits(block);
  if (!block || typeof block !== "object") return 0;
  const record = block as ThinkingReplayBlock & { data?: unknown };
  if (isThinkingContentBlock(record)) return estimateThinkingReplayTokenUnits(record);
  if (typeof record.text === "string") return estimateTextTokenUnits(record.text);
  if (typeof record.data === "string") return BINARY_BLOCK_TOKENS;
  return stringifiedTokenUnits(block);
}

// 消息 content 的统一估算（string | 块数组 | 其他结构）。
export function estimateContentTokenUnits(content: unknown): number {
  if (typeof content === "string") return estimateTextTokenUnits(content);
  if (Array.isArray(content)) {
    let units = 0;
    for (const block of content) units += estimateContentBlockTokenUnits(block);
    return units;
  }
  return content == null ? 0 : stringifiedTokenUnits(content);
}

function messageTokensFromUnits(units: number): number {
  return Math.ceil(Math.max(0, units)) + MESSAGE_ENVELOPE_TOKENS;
}

// 两端 store 都按不可变更新替换工具结果对象，估算结果可按对象身份缓存；
// 流式期间倒扫逐帧执行，没有这层缓存会对大工具结果每帧重复估算。
const toolResultTokenCache = new WeakMap<object, number>();

function estimateToolResultTokens(result: { content?: unknown }): number {
  const cached = toolResultTokenCache.get(result);
  if (cached !== undefined) return cached;
  // 只计模型可见的 content：details 是 UI/记账负载，provider 转换从不发送
  //（shell 的全量 stdout/stderr、文件读取元数据都挂在上面），计入会把 shell
  // 输出双算、把纯元数据当上下文，读数系统性虚高。
  const tokens = messageTokensFromUnits(estimateContentTokenUnits(result.content));
  toolResultTokenCache.set(result, tokens);
  return tokens;
}

// 供应商托管搜索块的两端统一 kind（GUI 时间线与 WebUI 行都经共享
// upsertHostedSearchToRound 折叠成该 kind）。含此块的轮次：
// 1) usage.input / totalTokens 是服务端多次内部调用的聚合值（搜索结果全文
//    计入 input 却不进入后续请求），不可作整段锚点——实测一个搜索轮报 118k
//    而真实持久上下文 52k，锚上去会在下一个普通轮次无压缩回落（44%→16%）；
// 2) 热缓存时 cacheRead+output 仍可信，见 hostedSearchFollowUpTokens；
// 3) 块本身在请求侧被 sanitizer 剥除，估算也必须跳过。
export const HOSTED_SEARCH_BLOCK_KIND = "hostedSearch";

function roundHasHostedSearch(
  round: NonNullable<ContextUsageScanItem["rounds"]>[number] | undefined,
): boolean {
  if (!round?.blocks) return false;
  for (const block of round.blocks) {
    if (block.kind === HOSTED_SEARCH_BLOCK_KIND) return true;
  }
  return false;
}

// 锚点扣减所需的思维链正文估算（仅该轮 usage 未上报 reasoning、且确认
// 不会重放时生效）。Responses 重放量走 replayTokenUnits，不走摘要正文。
function roundThinkingTokenUnits(
  round: NonNullable<ContextUsageScanItem["rounds"]>[number],
): number {
  let units = 0;
  for (const block of round.blocks ?? []) {
    if (block.kind !== "thinking") continue;
    units += estimateThinkingReplayTokenUnits(block);
  }
  return units;
}

function roundReplaysReasoning(
  round: NonNullable<ContextUsageScanItem["rounds"]>[number],
): boolean {
  return contentReplaysReasoning(round.blocks, {
    api: round.meta?.api,
    stopReason: round.meta?.stopReason,
    reasoningTokens: round.meta?.usage?.reasoning,
  });
}

function estimateRoundTokens(
  round: NonNullable<ContextUsageScanItem["rounds"]>[number],
  onlyToolResults: boolean,
): number {
  let assistantUnits = 0;
  let toolResultTokens = 0;
  for (const block of round.blocks ?? []) {
    if (block.kind === HOSTED_SEARCH_BLOCK_KIND) continue;
    if (block.kind === "tool") {
      const item =
        block.item && typeof block.item === "object"
          ? (block.item as {
              toolCall?: { name?: string; arguments?: unknown };
              toolResult?: { content?: unknown };
            })
          : undefined;
      const toolCall = item?.toolCall;
      if (!onlyToolResults && toolCall) {
        assistantUnits +=
          stringifiedTokenUnits(toolCall.name) + stringifiedTokenUnits(toolCall.arguments);
      }
      const toolResult = item?.toolResult;
      if (toolResult) toolResultTokens += estimateToolResultTokens(toolResult);
      continue;
    }
    if (!onlyToolResults) {
      assistantUnits += estimateContentBlockTokenUnits(block);
    }
  }
  if (onlyToolResults) return toolResultTokens;
  return (assistantUnits > 0 ? messageTokensFromUnits(assistantUnits) : 0) + toolResultTokens;
}

// "有效 token 计数"的两端单一校验口径（floor 且必须是有限正数）。
export function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

// 供应商 usage 的结构投影（pi-ai Usage 结构兼容；中转可能缺字段或报零）。
export type ContextUsageAnchorUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** output 的子集；仅上报推理分解的供应商设置（可能为 0），其余留空。 */
  reasoning?: number;
  totalTokens?: number;
};

function flooredTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 托管搜索轮的 input / totalTokens 含服务端搜索全文，绝不能当整段锚点
 *（会把环钉在 80k–120k，下一普通轮再掉回 ~32k）。
 *
 * cacheRead 与 output 仍可信：热缓存时 cacheRead 就是已缓存的
 * system+tools+历史前缀（实测稳定在 ~29k–30k），output 是本轮真正
 * 生成的 reasoning+正文（将原样进入下一请求）。下一请求规模 ≈
 * cacheRead + output，不再用 encrypted_content 按 0.4/字估——那会比
 * 真实 output 虚高 5–6k，空闲 36k、短回复后回落到 32k。
 *
 * 冷缓存 sliver（3k–5k）不能当成完整前缀，退回估算。
 */
export const HOSTED_SEARCH_PREFIX_CACHE_MIN = 16_000;

export function hostedSearchFollowUpTokens(
  usage: ContextUsageAnchorUsage | undefined,
  minPrefixTokens = 0,
): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const output = flooredTokens(usage.output);
  const cacheRead = flooredTokens(usage.cacheRead);
  if (output <= 0 || cacheRead <= 0) return undefined;
  // 有可信的 system+tools 估算时，cacheRead 必须接近该前缀；否则 16k 的
  // 半截缓存会被当成整段，空闲环再次偏低（19k→30k）。无估算时只拒绝
  // 冷启动 sliver（实测 3k–5k）。小 minPrefix 不得放宽 sliver。
  if (minPrefixTokens >= HOSTED_SEARCH_PREFIX_CACHE_MIN) {
    if (cacheRead < Math.floor(minPrefixTokens * 0.6)) return undefined;
  } else if (cacheRead < HOSTED_SEARCH_PREFIX_CACHE_MIN) {
    return undefined;
  }
  return cacheRead + output;
}

/** sanitizer 剥除 hostedSearch 后清零 input/totalTokens，只留 cacheRead+output。 */
export function isStrippedHostedSearchUsage(usage: ContextUsageAnchorUsage | undefined): boolean {
  if (!usage || typeof usage !== "object") return false;
  return (
    flooredTokens(usage.input) === 0 &&
    flooredTokens(usage.totalTokens) === 0 &&
    flooredTokens(usage.cacheRead) > 0
  );
}

/**
 * 轮次锚点的唯一语义定义："下一次请求将要发送的上下文规模"，只做 usage
 * 算术、绝不掺正文估算：
 *
 *   promptSide = input + cacheRead + cacheWrite   —— 本次请求实际发送量（权威）
 *   visibleOut = replayReasoning || stopReason === "toolUse"
 *                ? output      —— 思维链随下一请求重放并计费（工具环、
 *                                OpenAI Responses 的 encrypted reasoning、
 *                                Anthropic 带签名 thinking）
 *                : output − (reasoning ?? ceil(thinkingTokenUnits))
 *                              —— 确认会被剥离时才扣（Chat Completions 等）
 *   anchor     = promptSide + visibleOut
 *
 * 旧口径默认"stop 后各家都剥离 reasoning"。这对 OpenAI Responses 是错的：
 * convertResponsesMessages 会把 thinkingSignature 整段推进下一轮 input，
 * 扣了之后空闲环偏低，下一短回复的真实 usage 再把它抬回去（19k→30k）。
 *
 * reasoning 缺失（不上报推理分解的供应商）且确认不重放时，按思维链正文
 * 估算 units 扣减。prompt 侧全缺（部分中转只报 totalTokens）时退回
 * totalTokens 做同样的扣减。正文估算值一律不得混入锚点。
 */
export function assistantAnchorTokens(params: {
  usage: ContextUsageAnchorUsage | undefined;
  stopReason?: string;
  /** 该轮思维链正文的分数 token 估算（estimateTextTokenUnits 口径）。 */
  thinkingTokenUnits?: number;
  /** 下一请求会重放本轮 reasoning / thinking。 */
  replayReasoning?: boolean;
}): number | undefined {
  const usage = params.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const reasoning = usage.reasoning;
  const replayReasoning = params.replayReasoning === true || params.stopReason === "toolUse";
  const droppedReasoningTokens = replayReasoning
    ? 0
    : typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0
      ? Math.floor(reasoning)
      : Math.ceil(Math.max(0, params.thinkingTokenUnits ?? 0));
  const promptSideTokens =
    flooredTokens(usage.input) + flooredTokens(usage.cacheRead) + flooredTokens(usage.cacheWrite);
  if (promptSideTokens > 0) {
    return promptSideTokens + Math.max(0, flooredTokens(usage.output) - droppedReasoningTokens);
  }
  const totalTokens = flooredTokens(usage.totalTokens);
  if (totalTokens > 0) return Math.max(1, totalTokens - droppedReasoningTokens);
  return undefined;
}

export type DeriveContextUsageOptions = {
  // 倒扫找不到任何权威锚点（usage/检查点快照）时补进读数的固定开销
  //（system + tools 的估算，由 GUI 的 TokenLedger 提供）。运行中账本的无锚点
  // 口径含 fixed，倒扫历来只累加可见消息正文——两套口径在"供应商不回传
  // usage"的会话上会让空闲读数系统性偏低、与运行中读数来回跳变。有锚点时
  // usage/快照已含 fixed，绝不叠加。
  unanchoredFixedTokens?: number;
};

/**
 * 倒扫 transcript 求当前上下文占用：最近一个 assistant 轮次的真实 API usage
 * 经 assistantAnchorTokens 现算为锚点（已含该轮之前的 system/tools/历史与
 * 本轮可见输出），再累加锚点之后的用户消息（正文 + 附件元数据）、后续
 * assistant 内容与工具结果。压缩检查点优先使用桌面端同步的权威
 * contextUsageTokens；旧历史没有该字段时才退回摘要正文估算（此时同样补
 * unanchoredFixedTokens 对齐口径）。
 */
export function deriveContextUsageTokens(
  items: readonly ContextUsageScanItem[],
  options?: DeriveContextUsageOptions,
): number | undefined {
  const unanchoredFixedTokens = positiveTokenCount(options?.unanchoredFixedTokens) ?? 0;
  let trailingTokens = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "summary" || item.kind === "checkpoint") {
      const authoritativeTokens = positiveTokenCount(item.contextUsageTokens);
      if (authoritativeTokens !== undefined) return authoritativeTokens + trailingTokens;
      const estimatedTokens =
        typeof item.content === "string" ? estimateTextTokens(item.content) : undefined;
      return estimatedTokens === undefined
        ? undefined
        : estimatedTokens + trailingTokens + unanchoredFixedTokens;
    }
    if (item.kind === "user") {
      let units = typeof item.text === "string" ? estimateTextTokenUnits(item.text.trim()) : 0;
      // 附件按元数据序列化估算（路径/文件名/规模等即运行时注入的指令行量级；
      // 原生 base64 附件路径下这是下界）。不计会让"检查点后发大批附件"的
      // 空闲读数两端一致偏低，且纯附件消息此前完全计零。
      for (const attachment of item.attachments ?? []) {
        units += stringifiedTokenUnits(attachment);
      }
      if (units > 0) {
        trailingTokens += messageTokensFromUnits(units);
      }
      continue;
    }
    if (item.kind !== "assistant" || !item.rounds) continue;
    for (let roundIndex = item.rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
      const round = item.rounds[roundIndex];
      if (!round) continue;
      if (round.meta?.contextRelevant === false) continue;
      const usage = round.meta?.usage;
      if (roundHasHostedSearch(round)) {
        // input/totalTokens 是搜索全文聚合值，跳过；热缓存时 cacheRead+output
        // 已是下一请求规模，当作锚点，避免 encrypted 估算把空闲环抬高再回落。
        const followUpTokens = hostedSearchFollowUpTokens(usage, unanchoredFixedTokens);
        if (followUpTokens !== undefined) {
          return followUpTokens + trailingTokens;
        }
        trailingTokens += estimateRoundTokens(round, false);
        continue;
      }
      if (usage) {
        const anchorTokens = assistantAnchorTokens({
          usage,
          stopReason: round.meta?.stopReason,
          thinkingTokenUnits: roundThinkingTokenUnits(round),
          replayReasoning: roundReplaysReasoning(round),
        });
        if (anchorTokens !== undefined) {
          return anchorTokens + trailingTokens + estimateRoundTokens(round, true);
        }
      }
      trailingTokens += estimateRoundTokens(round, false);
    }
  }
  const unanchoredTotal = trailingTokens + unanchoredFixedTokens;
  return unanchoredTotal > 0 ? unanchoredTotal : undefined;
}

/** 倒扫能否落到 usage / 权威检查点。无锚点时 GUI 空闲应改信账本（完整消息含 thinkingSignature）。 */
export function hasContextUsageUsageAnchor(
  items: readonly ContextUsageScanItem[],
  options?: DeriveContextUsageOptions,
): boolean {
  const minPrefixTokens = positiveTokenCount(options?.unanchoredFixedTokens) ?? 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "summary" || item.kind === "checkpoint") {
      return positiveTokenCount(item.contextUsageTokens) !== undefined;
    }
    if (item.kind !== "assistant" || !item.rounds) continue;
    for (let roundIndex = item.rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
      const round = item.rounds[roundIndex];
      if (!round || round.meta?.contextRelevant === false) continue;
      if (roundHasHostedSearch(round)) {
        if (hostedSearchFollowUpTokens(round.meta?.usage, minPrefixTokens) !== undefined) {
          return true;
        }
        continue;
      }
      const anchorTokens = assistantAnchorTokens({
        usage: round.meta?.usage,
        stopReason: round.meta?.stopReason,
        thinkingTokenUnits: roundThinkingTokenUnits(round),
        replayReasoning: roundReplaysReasoning(round),
      });
      if (anchorTokens !== undefined) return true;
    }
  }
  return false;
}
