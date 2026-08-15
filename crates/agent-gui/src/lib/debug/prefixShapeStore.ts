/**
 * 按 sessionId 键控的前缀快照存储。归因要求「上一轮」与「本轮」同属一个会话:
 * runner 局部变量既做不到跨 runner 调用存续(同一会话的下一个 turn 只能报
 * initial),也挡不住多会话交错(主会话/子代理/记忆抽取共存)时拿别的会话的
 * 快照当基线比。存储放模块级,按 sessionId 隔离,LRU 上限对齐
 * injectionController 的会话数口径(32)。
 *
 * 与 prefixCacheShape 同目录但刻意分文件:那边承诺纯函数(不含时间量与状态),
 * 这边就是状态本身,不能混在一起稀释那个承诺。
 */
import type { PrefixShape } from "./prefixCacheShape";

/** 缓存的会话数量上限,对齐 injectionController 的 INJECTION_CONVERSATION_STATE_LIMIT。 */
const PREFIX_SHAPE_SESSION_LIMIT = 32;

type PrefixShapeEntry = {
  shape: PrefixShape;
  lastTouchedAt: number;
};

const shapesBySession = new Map<string, PrefixShapeEntry>();

// 淘汰序只需要相对先后。用单调计数器而不是 Date.now():同一毫秒内的多次触碰
// 也能保持稳定次序,且不给对账链路引入时间量。
let touchCounter = 0;

// sessionId 缺失时退化为单槽:等价于旧的 runner 局部变量语义(匿名请求之间
// 仍可能互串),但没有键就没有更好的归属方式,至少保住跨调用的连续性。
let fallbackShape: PrefixShape | null = null;

function pruneShapes() {
  if (shapesBySession.size <= PREFIX_SHAPE_SESSION_LIMIT) return;
  const sorted = [...shapesBySession.entries()].sort(
    (a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt,
  );
  for (const [key] of sorted.slice(0, shapesBySession.size - PREFIX_SHAPE_SESSION_LIMIT)) {
    shapesBySession.delete(key);
  }
}

function normalizeKey(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed ? trimmed : undefined;
}

/** 读取该会话上一轮的前缀快照;读也算触碰,让活跃会话不被 LRU 淘汰。 */
export function readPreviousPrefixShape(sessionId: string | undefined): PrefixShape | null {
  const key = normalizeKey(sessionId);
  if (!key) return fallbackShape;
  const entry = shapesBySession.get(key);
  if (!entry) return null;
  entry.lastTouchedAt = ++touchCounter;
  return entry.shape;
}

/** 每轮捕获后写回,作为该会话下一轮比对的基线。 */
export function recordPrefixShape(sessionId: string | undefined, shape: PrefixShape): void {
  const key = normalizeKey(sessionId);
  if (!key) {
    fallbackShape = shape;
    return;
  }
  const existing = shapesBySession.get(key);
  if (existing) {
    existing.shape = shape;
    existing.lastTouchedAt = ++touchCounter;
    return;
  }
  shapesBySession.set(key, { shape, lastTouchedAt: ++touchCounter });
  pruneShapes();
}
