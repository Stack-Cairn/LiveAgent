import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";

// ============================================================================
// 上下文溢出判定的单一真源。
//
// 复用点：withStreamRetry 的不重试守卫、providerFailover 的不可 failover 判定、
// 反应式压缩。输入必须是原始失败的 AssistantMessage，不能是 normalizeErrorMessage
// 之后的文本：归一化会只留下嵌套的 error.message，Anthropic 413 的
// `"type":"request_too_large"` 这类类型信息随之丢失（"Request exceeds the
// maximum size" 本身命中不了任何模式）。所以 runner 抛错时用
// AssistantResponseError 把原始消息带出来。
// ============================================================================

/**
 * pi-ai 为 Cerebras 准备的"无 body 的 400/413 即溢出"模式。别的供应商/中转返回
 * 空 body 4xx 的原因五花八门（鉴权、参数校验、网关拦截），当成溢出会误触压缩、
 * 吞掉 failover，所以在这里剔掉。
 */
const BODILESS_4XX_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/**
 * pi-ai 未收录的 Anthropic 措辞："input length and `max_tokens` exceed context
 * limit: 195000 + 32000 > 200000"。它里面的数字还会被 pi-ai 未锚定的 5xx 模式
 * 误当成可重试。
 */
const EXCEED_CONTEXT_LIMIT_PATTERN = /exceeds? context limit/i;

/**
 * 限流永远不是溢出。pi-ai 的 NON_OVERFLOW 只认带空格的 "rate limit" / "too many
 * requests"，其余写法（LiteLLM 的 RateLimitError、Bedrock 的 ThrottlingException、
 * 裸 429）会撞上它的兜底模式（"too many tokens"、"exceeds the limit of N"），
 * 从而既不重试也不 failover。429 两侧排除数字与千分位/小数点，"130,429 tokens"
 * 这类 token 计数不算。
 */
const THROTTLE_PATTERN = /(?:^|[^\d,.])429(?!\d|[,.]\d)|rate.?limit|throttl/i;

/**
 * pi-ai 的宽泛兜底模式同样命中配额 / 鉴权 / 网关错误："403 Monthly token limit
 * exceeded"、"502 Bad Gateway: too many tokens in flight"。文本带鉴权 / 配额 / 服务端
 * 状态时剥掉这几条再判定，具体的溢出措辞（prompt is too long 等）照旧生效。真正的
 * 溢出只会是 400 / 413；词边界保证 "205031 tokens" 不算 5xx。
 */
const LOOSE_OVERFLOW_PATTERN = /too many tokens|token limit exceeded|exceeds the limit of \d+/gi;
const NOT_CONTEXT_PATTERN = /\b(?:40[123]|5\d\d)\b|quota|billing|usage.?limit|daily|monthly/i;

/**
 * 原始 AssistantMessage 是否表示上下文溢出。`contextWindow` 透传给 pi-ai，用于
 * 识别"静默溢出"（成功返回但 usage 已超窗口）。
 */
export function isOverflowError(
  raw: AssistantMessage | undefined,
  contextWindow?: number,
): boolean {
  if (!raw) return false;
  const errorMessage = raw.stopReason === "error" ? (raw.errorMessage ?? "") : "";
  if (THROTTLE_PATTERN.test(errorMessage)) return false;
  if (EXCEED_CONTEXT_LIMIT_PATTERN.test(errorMessage)) return true;
  // 只剥掉无 body 前缀与（非上下文类错误里的）宽泛模式再交给 pi-ai：其余模式（含
  // NON_OVERFLOW 排除）原样生效。
  let probed = errorMessage.replace(BODILESS_4XX_PATTERN, "").trim();
  if (NOT_CONTEXT_PATTERN.test(errorMessage)) probed = probed.replace(LOOSE_OVERFLOW_PATTERN, "");
  return isContextOverflow(
    probed === errorMessage ? raw : { ...raw, errorMessage: probed },
    contextWindow,
  );
}

/**
 * runner 对失败的最终 assistant 抛出的错误。`message` 与原先
 * `new Error(normalizeErrorMessage(...))` 逐字一致，既有按文本判断的分支照旧
 * 生效；`assistant` 额外携带原始消息供溢出等分类使用。
 *
 * 有意不改 `name`：上游有直接 `String(error)` 的路径（如 useChatTurnQueue），
 * 改名会让 "Error: …" 变成 "AssistantResponseError: …"。
 */
export class AssistantResponseError extends Error {
  readonly assistant: AssistantMessage;

  constructor(message: string, assistant: AssistantMessage) {
    super(message);
    this.assistant = assistant;
  }
}

/** 从任意错误里取回原始失败的 AssistantMessage；不是 AssistantResponseError 时返回 undefined。 */
export function readAssistantFromError(error: unknown): AssistantMessage | undefined {
  return error instanceof AssistantResponseError ? error.assistant : undefined;
}
