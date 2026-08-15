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
};

export type PrefixShape = {
  systemHash: string;
  toolsHash: string;
  prefixHash: string;
  toolCount: number;
};

export type PrefixChangeReason = "system" | "tools";

/** 四种归因外加首轮基线:首轮没有前一份快照可比,不能算作「变了」。 */
export type PrefixChangeSummary = "initial" | "unchanged" | "system" | "tools" | "both";

export type PrefixCacheDiagnostics = {
  prefixHash: string;
  systemHash: string;
  toolsHash: string;
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
 * 按确定性顺序归一工具列表:name → description → parameters 三级比较,一律用
 * code-unit 字典序(默认 `<`)而非 localeCompare —— 后者受 locale 影响,会让同一份
 * 工具集在不同环境下排出不同顺序。
 *
 * 归一之后再哈希,registry 的迭代顺序变化就不会被误报成前缀变更(假阳性)。
 */
function normalizeTools(tools: readonly PrefixShapeTool[]) {
  return tools
    .map((tool) => [tool.name, tool.description ?? "", stringifyParameters(tool.parameters)])
    .sort((a, b) => {
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
      }
      return 0;
    });
}

/** 对当前请求前缀取一份快照。只在请求边界调用一次。 */
export function capturePrefixShape(params: {
  systemPrompt?: string;
  tools?: readonly PrefixShapeTool[];
}): PrefixShape {
  const tools = params.tools ?? [];
  const systemHash = stableHash(params.systemPrompt ?? "");
  const toolsHash = stableHash(JSON.stringify(normalizeTools(tools)));
  return {
    systemHash,
    toolsHash,
    prefixHash: stableHash(`${systemHash}:${toolsHash}`),
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
  }

  let summary: PrefixChangeSummary;
  if (!previous) {
    summary = "initial";
  } else if (reasons.length === 0) {
    summary = "unchanged";
  } else if (reasons.length > 1) {
    summary = "both";
  } else {
    summary = reasons[0];
  }

  return {
    prefixHash: current.prefixHash,
    systemHash: current.systemHash,
    toolsHash: current.toolsHash,
    toolCount: current.toolCount,
    prefixChanged: reasons.length > 0,
    prefixChangeReasons: reasons,
    prefixChangeSummary: summary,
  };
}
