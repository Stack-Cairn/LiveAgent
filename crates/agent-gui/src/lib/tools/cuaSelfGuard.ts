import { invoke } from "@tauri-apps/api/core";

/**
 * 把 LiveAgent 自己从 cua-driver 的视野里摘掉。
 *
 * 为什么需要：cua-driver 看到的是整个桌面，其中包括 LiveAgent 自己的窗
 * 口。让模型操作宿主界面是危险的自指——它能点掉自己的审批弹窗（等于绕过
 * 审批）、改自己的权限策略、或者直接把自己关了。上游没有「排除某个 app」
 * 的机制（capability manifest 是工具/资源白名单，且在代理模式下归
 * CuaDriver.app 的守护进程管），所以这道闸只能开在宿主侧。
 *
 * 两个方向都要拦：
 * - **入参**：调用直接以宿主 pid / window_id 为目标时拒绝，返回一句模型
 *   能读懂的说明，让它换目标而不是原地重试。
 * - **出参**：`list_windows` / `list_apps` / `get_accessibility_tree` 的
 *   结果里剔除宿主记录。不剔的话模型下一步就会拿着这些 id 来敲门，白白
 *   撞上入参拦截。
 *
 * window_id 与 pid 的对应关系只有 cua-driver 知道，所以宿主的 window_id
 * 是在出参过滤时顺手学到的（见 `learnedSelfWindowIds`）。在第一次窗口枚
 * 举之前，模型手里本来也不会有 window_id，拦不住也无从利用。
 *
 * `cuaAllowSelfTargeting` 置 true 可整体关掉这道闸——用 LiveAgent 自动化
 * 测试 LiveAgent 时需要。默认关闭。
 */

const SELF_TARGET_REFUSAL =
  "该目标是 LiveAgent 自身的窗口，已被拒绝：让模型操作宿主界面可以绕过工具审批、" +
  "改写权限设置或直接关闭应用。请改为操作其他应用。（如确需自动化 LiveAgent 本身，" +
  "在「设置 → CUA」中打开「允许操作 LiveAgent 自身」。）";

type SelfIdentity = { pid: number; bundleId?: string | null };

let selfIdentityPromise: Promise<SelfIdentity | null> | null = null;

function loadSelfIdentity(): Promise<SelfIdentity | null> {
  selfIdentityPromise ??= invoke<SelfIdentity>("cua_driver_self_identity").catch(() => null);
  return selfIdentityPromise;
}

/** 出参过滤时学到的宿主 window_id。进程级缓存，无需持久化。 */
const learnedSelfWindowIds = new Set<number>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 入参检查。返回拒绝理由，或 null 表示放行。
 *
 * 只看 `pid` / `window_id` 两个字段：cua-driver 的工具全用它们寻址（见
 * `list_windows` 的 per-record 字段），坐标类参数（x/y）无法反查归属，
 * 由出参过滤间接覆盖——模型拿不到宿主窗口的 bounds 就算不出坐标。
 */
export function refuseSelfTargetedCall(
  args: Record<string, unknown> | undefined,
  selfPid: number | null,
): string | null {
  if (!args) return null;
  const pid = readNumber(args.pid);
  if (selfPid !== null && pid === selfPid) return SELF_TARGET_REFUSAL;
  const windowId = readNumber(args.window_id);
  if (windowId !== null && learnedSelfWindowIds.has(windowId)) return SELF_TARGET_REFUSAL;
  return null;
}

/**
 * 从一条 JSON 文本结果里剔除宿主记录，并顺手记下宿主的 window_id。
 *
 * 结果不是 JSON（截图、纯文本报告）时原样返回：这类载荷里没有可供寻址的
 * 记录，剔无可剔。
 */
export function stripSelfFromJsonText(text: string, selfPid: number | null): string {
  if (selfPid === null) return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }

  let changed = false;

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const kept = node.filter((entry) => {
        const record = asRecord(entry);
        if (!record) return true;
        if (readNumber(record.pid) !== selfPid) return true;
        const windowId = readNumber(record.window_id);
        if (windowId !== null) learnedSelfWindowIds.add(windowId);
        changed = true;
        return false;
      });
      return kept.map(visit);
    }
    const record = asRecord(node);
    if (!record) return node;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) next[key] = visit(value);
    return next;
  };

  const result = visit(parsed);
  return changed ? JSON.stringify(result) : text;
}

/** 供测试重置进程级缓存。 */
export function resetCuaSelfGuardCaches() {
  selfIdentityPromise = null;
  learnedSelfWindowIds.clear();
}

export type CuaSelfGuard = {
  /** 调用前检查；返回拒绝理由或 null。 */
  refuse: (args: Record<string, unknown> | undefined) => string | null;
  /** 结果文本过滤。 */
  strip: (text: string) => string;
};

/**
 * 取得当前生效的守卫。`allowSelfTargeting` 为 true，或宿主身份查不到
 * （非桌面端）时返回 null——调用方据此完全跳过这层。
 */
export async function resolveCuaSelfGuard(
  allowSelfTargeting: boolean,
): Promise<CuaSelfGuard | null> {
  if (allowSelfTargeting) return null;
  const identity = await loadSelfIdentity();
  const selfPid = identity ? readNumber(identity.pid) : null;
  if (selfPid === null) return null;
  return {
    refuse: (args) => refuseSelfTargetedCall(args, selfPid),
    strip: (text) => stripSelfFromJsonText(text, selfPid),
  };
}

export const CUA_SELF_TARGET_REFUSAL = SELF_TARGET_REFUSAL;
