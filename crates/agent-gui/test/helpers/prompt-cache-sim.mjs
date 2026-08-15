/**
 * 离线确定性 prompt 缓存模拟器。
 *
 * 目的:在不联网、不用 API key 的前提下,把「这轮缓存命中了多少」变成可断言的数字。
 * 它不猜测 provider 的内部实现,只复刻两条公开且可验证的规则:
 *
 *   1. 缓存按**字节级前缀**匹配。前一次请求与本次请求的公共前缀之外,一律 miss。
 *   2. 命中量在前缀基础上再做一次**向下取整**,取整口径按 provider 分:
 *      - Anthropic:取到「落在公共前缀内的最后一个 cache_control 断点」。
 *        没有断点落在前缀内 ⇒ 命中 0,即所谓「全有全无」。
 *      - DeepSeek / OpenAI 隐式缓存:取到 128 token 块边界。
 *
 * 刻意**不**建模的东西(建模了反而会让结论失真):
 *   - 真实分词器。这里用 chars/4 估算 token。绝对值因此不精确,但本模块所有结论
 *     都是**比值**(命中/总量)与**同一标尺下的 A/B 对比**,估算误差在两侧同向抵消。
 *   - 缓存过期。TTL 到期属于时间量,进来就会让测试不确定。要测 TTL 影响请显式
 *     构造两次不同的 cacheControl 参数,而不是等它自己过期。
 *   - 服务端负载均衡导致的缓存节点未命中。这是运气,不是可回归的行为。
 */

/** token 估算:纯字符数折算,确定性且无依赖。绝对值不精确,比值可用。 */
export function estimateTokens(charCount) {
  return Math.floor(charCount / 4);
}

/** 两个字符串的公共前缀长度。缓存匹配的底层规则就是这一条。 */
export function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

/**
 * 把 Anthropic 请求体按**上线字节序**摊平成一个字符串,同时记录每个
 * `cache_control` 断点落在哪个偏移量上。
 *
 * 顺序必须是 system → tools → messages —— 这是 Anthropic 请求体的实际序列化
 * 顺序,也是「改一个 system 字节会顺带作废后面全部历史」这一现象的成因。摊平
 * 顺序一旦写错,整个模拟器给出的归因就是错的。
 */
export function flattenAnthropicPayload(payload) {
  let text = "";
  /** @type {number[]} 断点偏移量,升序 */
  const breakpoints = [];

  // 顶层 cache_control 的语义是「自动标记最后一个可缓存块」,等价于在整个
  // 请求体末尾放一个断点 —— 也就是只有一级,没有阶梯。
  const hasTopLevel = Boolean(payload.cache_control);

  const pushBlock = (serialized, hasBreakpoint) => {
    text += serialized;
    if (hasBreakpoint) breakpoints.push(text.length);
  };

  const systemBlocks = Array.isArray(payload.system)
    ? payload.system
    : typeof payload.system === "string"
      ? [{ type: "text", text: payload.system }]
      : [];
  for (const block of systemBlocks) {
    pushBlock(`system:${block.text ?? ""}\n`, Boolean(block.cache_control));
  }

  for (const tool of payload.tools ?? []) {
    const schema = JSON.stringify(tool.input_schema ?? tool.parameters ?? {});
    pushBlock(
      `tool:${tool.name}:${tool.description ?? ""}:${schema}\n`,
      Boolean(tool.cache_control),
    );
  }

  for (const message of payload.messages ?? []) {
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: message.content ?? "" }];
    for (const block of blocks) {
      const body =
        block.type === "text"
          ? block.text
          : block.type === "thinking"
            ? block.thinking
            : block.type === "redacted_thinking"
              ? block.data
              : JSON.stringify(block);
      pushBlock(`${message.role}:${block.type}:${body ?? ""}\n`, Boolean(block.cache_control));
    }
  }

  if (hasTopLevel) breakpoints.push(text.length);

  return { text, breakpoints };
}

/**
 * Anthropic 命中模型:命中量 = **上一次请求**的断点里,仍落在公共前缀内的最靠后那个。
 *
 * 方向很容易搞反,这里写清楚:请求体里的 `cache_control` 标记的是「把到这里为止
 * 的内容**写入**缓存」。所以本轮能**读到**多少,取决于上一轮写到了哪里,而不是
 * 本轮打算写到哪里。用本轮断点算命中,会得出「纯追加会话命中率为 0」这种明显
 * 荒谬的结论 —— 因为本轮的尾部断点永远在公共前缀之外。
 *
 * 这也正是断点数量之争的核心:上一轮只在末尾写了一个断点时,只要本轮前缀在那个
 * 位置之前就发生分叉,命中直接归零;上一轮在 system / tools / messages 各写了
 * 一个,靠前的那些仍然可读 —— 也就是「阶梯」。
 */
export function anthropicCacheHit(previous, current) {
  if (!previous) return { hitChars: 0, totalChars: current.text.length };
  const prefix = commonPrefixLength(previous.text, current.text);

  let hitChars = 0;
  for (const breakpoint of previous.breakpoints) {
    if (breakpoint <= prefix) hitChars = Math.max(hitChars, breakpoint);
  }

  return { hitChars, totalChars: current.text.length };
}

/** DeepSeek / OpenAI 隐式缓存:公共前缀再向下取整到 128 token 块。 */
const IMPLICIT_CACHE_BLOCK_TOKENS = 128;

export function implicitCacheHit(previous, current) {
  if (!previous) return { hitTokens: 0, totalTokens: estimateTokens(current.text.length) };
  const prefixTokens = estimateTokens(commonPrefixLength(previous.text, current.text));
  const blocks = Math.floor(prefixTokens / IMPLICIT_CACHE_BLOCK_TOKENS);
  return {
    hitTokens: blocks * IMPLICIT_CACHE_BLOCK_TOKENS,
    totalTokens: estimateTokens(current.text.length),
  };
}

/**
 * 跑一整条多轮会话,逐轮记账。
 *
 * 首轮没有可比对象,必然全 miss —— 这是物理事实,不是缺陷。命中率因此分两个
 * 口径给出:`overall` 含首轮(对应真实账单),`steadyState` 不含首轮(对应
 * 「会话跑起来之后稳不稳」)。报数时必须说清用的是哪个,否则就是在挑好看的数。
 *
 * 还给出第三个、也是唯一与会话形状无关的口径 `efficiency`:实际命中 ÷ 理论
 * 上限。理论上限是「第 n 轮最多只能命中第 n-1 轮的全量」—— 本轮新增的内容
 * 上一轮根本不存在,不可能命中。绝对命中率因此由 base/delta 比值决定而非由
 * 实现决定:同一份实现,把 system prompt 调大就能让数字变好看。断言绝对命中率
 * 等于在断言 fixture 的形状;断言 efficiency 才是在断言我们没有漏掉任何本可
 * 命中的字节。
 */
export function runCacheSimulation(payloads, { model = "anthropic" } = {}) {
  const flattened = payloads.map(flattenAnthropicPayload);
  const rounds = [];

  let hitUnits = 0;
  let totalUnits = 0;
  let steadyHitUnits = 0;
  let steadyTotalUnits = 0;
  let ceilingUnits = 0;

  for (let index = 0; index < flattened.length; index += 1) {
    const previous = index === 0 ? null : flattened[index - 1];
    const current = flattened[index];

    const result =
      model === "anthropic"
        ? anthropicCacheHit(previous, current)
        : implicitCacheHit(previous, current);
    const hit = result.hitChars ?? result.hitTokens;
    const total = result.totalChars ?? result.totalTokens;

    // 本轮理论上限:上一轮的全量(纯追加时即公共前缀),再多一个字节都不可能命中。
    const ceiling =
      previous === null
        ? 0
        : model === "anthropic"
          ? previous.text.length
          : estimateTokens(previous.text.length);

    hitUnits += hit;
    totalUnits += total;
    ceilingUnits += ceiling;
    if (index > 0) {
      steadyHitUnits += hit;
      steadyTotalUnits += total;
    }

    rounds.push({
      round: index + 1,
      hit,
      total,
      ceiling,
      hitRate: total === 0 ? 0 : hit / total,
      breakpointCount: current.breakpoints.length,
    });
  }

  return {
    rounds,
    overallHitRate: totalUnits === 0 ? 0 : hitUnits / totalUnits,
    steadyStateHitRate: steadyTotalUnits === 0 ? 0 : steadyHitUnits / steadyTotalUnits,
    efficiency: ceilingUnits === 0 ? 1 : hitUnits / ceilingUnits,
  };
}
