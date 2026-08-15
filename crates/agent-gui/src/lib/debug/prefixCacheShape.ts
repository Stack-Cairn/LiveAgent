/**
 * 前缀哈希对账：对影响 provider prompt 缓存前缀的请求组成部分(system prompt 与
 * tools)分别取稳定哈希,逐轮比对相邻两次请求的快照,把「这轮为什么 miss」从只能
 * 盯着 cacheRead=0 猜,变成可直接读出的归因串。
 *
 * 本模块只做观测,不改变任何请求内容。它自身必须是纯函数:不含时间量、随机量与
 * 环境依赖,同一输入永远得到同一输出 —— 观测手段一旦自己抖动,归因就失去意义。
 */

// 选 FNV-1a 而不是 SHA-256:crypto.subtle 只有异步接口,而快照要在请求组装的同步
// 路径上一次算完。归因只需要判断「变没变」,不需要密码学强度。
const FNV_PRIME = 0x01000193;
const FNV_OFFSET_BASIS = 0x811c9dc5;
// 第二条哈希流换一个种子,与第一条拼成 64 位输出,把碰撞概率压到可忽略。
const FNV_SECOND_SEED = 0x7ee3a1cf;

export type PrefixShapeTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  /**
   * 约束采样配置(constrained sampling)。与 parameters 一样随请求体上线:配置
   * 一变前缀字节就真的变了,不入账就会在真出事时报 unchanged。当前工具链未必
   * 携带该字段,缺省与空值等价,不影响既有哈希的稳定性语义。
   */
  constrainedSampling?: unknown;
};

/**
 * 影响断点位置与 TTL 的缓存参数。文本字节可以一模一样,但 TTL 从 5m 翻到 1h、或
 * 供应商路径从「顶层自动断点」切到「显式断点」,缓存同样会作废 —— 这类变更 system
 * 与 tools 的哈希都看不见,必须单独入账,否则归因会在真出事时报 unchanged。
 */
export type PrefixShapeCacheControl = {
  cacheRetention?: string;
  ttl?: string;
  breakpointStrategy?: string;
  /**
   * codex 的缓存分片路由键(prompt_cache_key / x-session-id)。sessionId 一变,
   * 服务端换分片,前缀字节再稳命中也会归零 —— 必须单独入账。空串表示「本应
   * 注入但没注入成」:注入失败是静默的,归因里 cacheKey 从有值变空串是它唯一
   * 可见的地方。
   */
  cacheKey?: string;
};

export type PrefixShape = {
  systemHash: string;
  toolsHash: string;
  cacheControlHash: string;
  prefixHash: string;
  toolCount: number;
};

export type PrefixChangeReason = "system" | "tools" | "cacheControl";

/** 归因取值外加首轮基线:首轮没有前一份快照可比,不能算作「变了」。 */
export type PrefixChangeSummary =
  | "initial"
  | "unchanged"
  | "system"
  | "tools"
  | "cacheControl"
  | "multiple";

export type PrefixCacheDiagnostics = {
  prefixHash: string;
  systemHash: string;
  toolsHash: string;
  cacheControlHash: string;
  toolCount: number;
  prefixChanged: boolean;
  prefixChangeReasons: PrefixChangeReason[];
  prefixChangeSummary: PrefixChangeSummary;
};

function fnv1a32(input: string, seed: number) {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    // 按字节喂入(低位在前),让同一字符串在任何引擎上都得到同一结果。
    hash = Math.imul(hash ^ (code & 0xff), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ ((code >>> 8) & 0xff), FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

function toHex8(value: number) {
  return value.toString(16).padStart(8, "0");
}

function stableHash(input: string) {
  // 掺入长度,顺带挡掉「内容位模式相近但长度不同」这类边角碰撞。
  const salted = `${input.length}:${input}`;
  return `${toHex8(fnv1a32(salted, FNV_OFFSET_BASIS))}${toHex8(fnv1a32(salted, FNV_SECOND_SEED))}`;
}

function stringifyParameters(parameters: unknown) {
  if (parameters === undefined) return "";
  try {
    return JSON.stringify(parameters) ?? "";
  } catch {
    // schema 理论上都是纯 JSON;真出现循环引用时退化成一个稳定标记,
    // 宁可让该工具的哈希粒度变粗,也不能让对账链路抛错。
    return "[unserializable]";
  }
}

/**
 * 按上线顺序序列化工具列表 —— 刻意**不排序**。
 *
 * 工具数组在请求体里是有序的(`filterRequestTools` 只过滤不重排),registry 迭代
 * 顺序一变,provider 侧前缀就真的作废了。早期这里排过序,理由是「避免 registry
 * 顺序变化造成假阳性」,但那个前提本身就错:顺序变化不是假阳性,是真失效。排序
 * 只会让诊断在 MCP server 重连打乱顺序时报 unchanged —— 观测器恰好在它本该抓到
 * 的场景里说谎。宁可报出一次需要人工判读的 tools 变更,也不能漏报。
 */
function normalizeTools(tools: readonly PrefixShapeTool[]) {
  return tools.map((tool) => [
    tool.name,
    tool.description ?? "",
    stringifyParameters(tool.parameters),
    stringifyParameters(tool.constrainedSampling),
  ]);
}

/**
 * 缓存参数归一:字段顺序固定,缺省值统一落成空串,避免 undefined 与缺字段在
 * JSON 序列化后产生两种不同的哈希。
 */
function normalizeCacheControl(cacheControl: PrefixShapeCacheControl | undefined) {
  return [
    cacheControl?.cacheRetention ?? "",
    cacheControl?.ttl ?? "",
    cacheControl?.breakpointStrategy ?? "",
    cacheControl?.cacheKey ?? "",
  ];
}

/** 对当前请求前缀取一份快照。只在请求边界调用一次。 */
export function capturePrefixShape(params: {
  systemPrompt?: string;
  tools?: readonly PrefixShapeTool[];
  cacheControl?: PrefixShapeCacheControl;
}): PrefixShape {
  const tools = params.tools ?? [];
  const systemHash = stableHash(params.systemPrompt ?? "");
  const toolsHash = stableHash(JSON.stringify(normalizeTools(tools)));
  const cacheControlHash = stableHash(JSON.stringify(normalizeCacheControl(params.cacheControl)));
  return {
    systemHash,
    toolsHash,
    cacheControlHash,
    prefixHash: stableHash(`${systemHash}:${toolsHash}:${cacheControlHash}`),
    toolCount: tools.length,
  };
}

/**
 * 比对相邻两次快照,产出可读归因。previous 为空表示首轮,没有可比对象,
 * 此时既不报 changed 也不编造原因。
 */
export function comparePrefixShape(
  previous: PrefixShape | null | undefined,
  current: PrefixShape,
): PrefixCacheDiagnostics {
  const reasons: PrefixChangeReason[] = [];
  if (previous) {
    if (previous.systemHash !== current.systemHash) reasons.push("system");
    if (previous.toolsHash !== current.toolsHash) reasons.push("tools");
    if (previous.cacheControlHash !== current.cacheControlHash) reasons.push("cacheControl");
  }

  let summary: PrefixChangeSummary;
  if (!previous) {
    summary = "initial";
  } else if (reasons.length === 0) {
    summary = "unchanged";
  } else if (reasons.length > 1) {
    summary = "multiple";
  } else {
    summary = reasons[0];
  }

  return {
    prefixHash: current.prefixHash,
    systemHash: current.systemHash,
    toolsHash: current.toolsHash,
    cacheControlHash: current.cacheControlHash,
    toolCount: current.toolCount,
    prefixChanged: reasons.length > 0,
    prefixChangeReasons: reasons,
    prefixChangeSummary: summary,
  };
}
