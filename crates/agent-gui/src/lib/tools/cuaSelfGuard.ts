import { invoke } from "@tauri-apps/api/core";

/**
 * 把 LiveAgent 自己从 cua-driver 的视野与可操作范围里摘掉。
 *
 * 为什么需要：cua-driver 看到的是整个桌面，其中包括 LiveAgent 自己的窗
 * 口。让模型操作宿主界面是危险的自指——它能点掉自己的审批弹窗（等于绕过
 * 审批）、改自己的权限策略、或者直接把自己关了。上游没有「排除某个 app」
 * 的机制（capability manifest 是工具/资源白名单，且在代理模式下归
 * CuaDriver.app 的守护进程管），所以这道闸只能开在宿主侧。
 *
 * 三条路径都要拦：
 * - **按 pid / window_id 寻址**：递归扫描整个入参。上游现约把目标包在
 *   `target` 对象里（`{"target":{"kind":"window","pid":…,"window_id":…}}`），
 *   只看顶层字段等于没拦——早期只认扁平参数的实现可以被官方写法直接绕过。
 * - **按屏幕坐标寻址**：坐标无法反查归属，改为和宿主窗口的实际矩形比对。
 *   模型完全可以从整屏截图上量出「允许」按钮的位置，再以
 *   `{"target":{"kind":"desktop"},"x":…,"y":…}` 发出来。窗口矩形每次调用
 *   前重新取（见 `loadSelfWindowRects`），窗口移动后判断依然成立。
 * - **出参**：`list_windows` / `list_apps` / `get_accessibility_tree` 的
 *   结果里剔除宿主记录。不剔的话模型下一步就会拿着这些 id 来敲门，白白
 *   撞上入参拦截。官方 MCP 的文本块常带 `✅ …` 之类的摘要前缀，所以不能
 *   要求整段是纯 JSON，得先把 JSON 片段从文本里切出来。
 *
 * window_id 与 pid 的对应关系只有 cua-driver 知道，所以宿主的 window_id
 * 是在出参过滤时顺手学到的（见 `learnedSelfWindowIds`）。在第一次窗口枚
 * 举之前，模型手里本来也不会有 window_id，拦不住也无从利用。
 *
 * 残留面（明知且接受）：整屏截图里仍然能**看到**宿主窗口——图片没法像
 * JSON 那样做结构化剔除。但看到不等于能操作：落在宿主窗口矩形内的坐标
 * 操作会被上面第二条拦掉，所以这是信息可见性问题，不是审批绕过。
 *
 * `cuaAllowSelfTargeting` 置 true 可整体关掉这道闸——用 LiveAgent 自动化
 * 测试 LiveAgent 时需要。默认关闭。
 */

const SELF_TARGET_REFUSAL =
  "该目标是 LiveAgent 自身的窗口，已被拒绝：让模型操作宿主界面可以绕过工具审批、" +
  "改写权限设置或直接关闭应用。请改为操作其他应用。（如确需自动化 LiveAgent 本身，" +
  "在「设置 → CUA」中打开「允许操作 LiveAgent 自身」。）";

const SELF_REGION_REFUSAL =
  "该坐标落在 LiveAgent 自身的窗口范围内，已被拒绝：以桌面为目标按屏幕坐标操作宿主界面，" +
  "同样可以点掉审批弹窗或改写权限设置。请改为操作其他应用的窗口。（如确需自动化 LiveAgent " +
  "本身，在「设置 → CUA」中打开「允许操作 LiveAgent 自身」。）";

type SelfIdentity = { pid: number; bundleId?: string | null };

/** 宿主窗口在屏幕坐标系里的矩形，单位与 cua-driver 的桌面坐标一致。 */
export type SelfWindowRect = { x: number; y: number; width: number; height: number };

let selfIdentityPromise: Promise<SelfIdentity | null> | null = null;

function loadSelfIdentity(): Promise<SelfIdentity | null> {
  selfIdentityPromise ??= invoke<SelfIdentity>("cua_driver_self_identity").catch(() => null);
  return selfIdentityPromise;
}

/**
 * 窗口矩形的短期缓存。
 *
 * 不能像 pid 那样一次取定——窗口会被拖动、缩放。但一次工具调用里可能反复
 * 问到，且 GUI 操作本身就在秒级，几百毫秒内的复用不会让判断失真，同时避免
 * 每次调用都过一趟 IPC。
 */
const SELF_RECTS_TTL_MS = 400;

let selfRectsCache: { at: number; rects: SelfWindowRect[] } | null = null;

async function loadSelfWindowRects(): Promise<SelfWindowRect[]> {
  if (selfRectsCache && Date.now() - selfRectsCache.at <= SELF_RECTS_TTL_MS) {
    return selfRectsCache.rects;
  }
  const rects = await invoke<SelfWindowRect[]>("cua_driver_self_windows").catch(() => []);
  selfRectsCache = { at: Date.now(), rects: Array.isArray(rects) ? rects : [] };
  return selfRectsCache.rects;
}

/** 出参过滤时学到的宿主 window_id。进程级缓存，无需持久化。 */
const learnedSelfWindowIds = new Set<number>();

/**
 * 递归深度上限。入参是 MCP 的 JSON 参数，正常形态最多两三层；给足余量之后
 * 仍然封顶，免得畸形（或刻意构造的）深层结构把扫描拖垮。
 */
const MAX_SCAN_DEPTH = 12;

/** 各家写法里表示进程 id 的字段名。 */
const PID_KEYS = ["pid", "process_id", "processId", "owner_pid", "ownerPid"] as const;

/** 各家写法里表示窗口 id 的字段名。 */
const WINDOW_ID_KEYS = ["window_id", "windowId"] as const;

/**
 * `target.kind` 里表示「某个窗口 / 应用 / 元素」的取值。
 *
 * 只枚举这一侧、把其余（`desktop` / `screen` / `display` / 压根没有 target）
 * 都按屏幕绝对坐标处理，是刻意的 fail-closed：上游新增一种桌面级 target
 * 时不会因为没登记而漏拦。
 */
const SCOPED_TARGET_KINDS = new Set(["window", "app", "application", "element"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 深度遍历，对每个对象节点调用 `visit`；`visit` 返回 true 即提前结束。 */
function walkRecords(
  node: unknown,
  visit: (record: Record<string, unknown>) => boolean,
  depth = 0,
): boolean {
  if (depth > MAX_SCAN_DEPTH) return false;
  if (Array.isArray(node)) {
    return node.some((entry) => walkRecords(entry, visit, depth + 1));
  }
  const record = asRecord(node);
  if (!record) return false;
  if (visit(record)) return true;
  return Object.values(record).some((value) => walkRecords(value, visit, depth + 1));
}

/**
 * 入参检查：按 pid / window_id 寻址的自指调用。返回拒绝理由，或 null 放行。
 *
 * 整棵参数树都要扫，不只是顶层：上游把目标包在 `target` 对象里，只看顶层
 * `pid` / `window_id` 会让官方写法原样通过。
 */
export function refuseSelfTargetedCall(
  args: Record<string, unknown> | undefined,
  selfPid: number | null,
): string | null {
  if (!args) return null;

  const hit = walkRecords(args, (record) => {
    if (selfPid !== null && PID_KEYS.some((key) => readNumber(record[key]) === selfPid)) {
      return true;
    }
    return WINDOW_ID_KEYS.some((key) => {
      const windowId = readNumber(record[key]);
      return windowId !== null && learnedSelfWindowIds.has(windowId);
    });
  });

  return hit ? SELF_TARGET_REFUSAL : null;
}

/**
 * 这次调用是否以「整个桌面」为目标、并带了屏幕坐标。
 *
 * 显式指向某个窗口 / 元素时返回 false：那种坐标是相对该窗口的，而窗口本身
 * 是不是宿主已经由 `refuseSelfTargetedCall` 判过了，这里再按屏幕坐标比对
 * 只会误伤。没有任何 target 字段的扁平写法按桌面处理——早期 API 的坐标就是
 * 屏幕绝对坐标。
 */
export function usesDesktopScreenCoordinates(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;

  let scoped = false;
  walkRecords(args, (record) => {
    const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : null;
    if (kind && SCOPED_TARGET_KINDS.has(kind)) {
      scoped = true;
      return true;
    }
    return false;
  });
  if (scoped) return false;

  return collectScreenPoints(args).length > 0;
}

/** 收集参数里所有形如 `{x, y}` 的点。 */
function collectScreenPoints(args: Record<string, unknown>): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  walkRecords(args, (record) => {
    const x = readNumber(record.x);
    const y = readNumber(record.y);
    if (x !== null && y !== null) points.push({ x, y });
    return false;
  });
  return points;
}

function pointInRect(point: { x: number; y: number }, rect: SelfWindowRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * 入参检查：以桌面为目标、坐标落在宿主窗口矩形内的调用。
 *
 * 只在 `usesDesktopScreenCoordinates` 为真时才有意义；矩形列表为空（拿不到、
 * 或宿主窗口全部不可见）时一律放行——宁可不拦，也不误伤正常目标。
 */
export function refuseSelfRegionCall(
  args: Record<string, unknown> | undefined,
  rects: SelfWindowRect[],
): string | null {
  if (!args || rects.length === 0) return null;
  const points = collectScreenPoints(args);
  const hit = points.some((point) => rects.some((rect) => pointInRect(point, rect)));
  return hit ? SELF_REGION_REFUSAL : null;
}

/**
 * 从文本里切出第一段结构完整的 JSON，返回它在原文中的区间。
 *
 * 官方 MCP 的文本块通常是「一行 `✅ Windows listed` 摘要 + 一段 JSON」，
 * 要求整段 trim 后以 `{` / `[` 开头会让这类结果整个漏过过滤。扫描时要认
 * 字符串字面量与转义，否则 payload 里带花括号的字符串会把配对算错。
 */
function findJsonSpan(text: string): { start: number; end: number } | null {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== "{" && char !== "[") continue;

    const closing = char === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j++) {
      const current = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') inString = false;
        continue;
      }
      if (current === '"') {
        inString = true;
        continue;
      }
      if (current === char) depth++;
      else if (current === closing) {
        depth--;
        if (depth === 0) return { start: i, end: j + 1 };
      }
    }
    // 从这个位置起始的括号没有配平；后面不可能再有更早的完整片段。
    return null;
  }
  return null;
}

/**
 * 从一条结果文本里剔除宿主记录，并顺手记下宿主的 window_id。
 *
 * 文本里没有可解析的 JSON（截图说明、纯文本报告）时原样返回：这类载荷里
 * 没有可供寻址的记录，剔无可剔。JSON 片段前后的摘要文字原样保留——那是给
 * 模型看的上下文，改写它没有必要。
 */
export function stripSelfFromJsonText(text: string, selfPid: number | null): string {
  if (selfPid === null) return text;

  const span = findJsonSpan(text);
  if (!span) return text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(span.start, span.end));
  } catch {
    return text;
  }

  let changed = false;

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const kept = node.filter((entry) => {
        const record = asRecord(entry);
        if (!record) return true;
        if (!PID_KEYS.some((key) => readNumber(record[key]) === selfPid)) return true;
        for (const key of WINDOW_ID_KEYS) {
          const windowId = readNumber(record[key]);
          if (windowId !== null) learnedSelfWindowIds.add(windowId);
        }
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
  if (!changed) return text;
  return text.slice(0, span.start) + JSON.stringify(result) + text.slice(span.end);
}

/** 供测试重置进程级缓存。 */
export function resetCuaSelfGuardCaches() {
  selfIdentityPromise = null;
  selfRectsCache = null;
  learnedSelfWindowIds.clear();
}

export type CuaSelfGuard = {
  /** 调用前检查；返回拒绝理由或 null。 */
  refuse: (args: Record<string, unknown> | undefined) => Promise<string | null>;
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
    refuse: async (args) => {
      const targeted = refuseSelfTargetedCall(args, selfPid);
      if (targeted) return targeted;
      // 窗口矩形要过一趟 IPC，只在这次调用真的带了桌面坐标时才去取。
      if (!usesDesktopScreenCoordinates(args)) return null;
      return refuseSelfRegionCall(args, await loadSelfWindowRects());
    },
    strip: (text) => stripSelfFromJsonText(text, selfPid),
  };
}

export const CUA_SELF_TARGET_REFUSAL = SELF_TARGET_REFUSAL;
export const CUA_SELF_REGION_REFUSAL = SELF_REGION_REFUSAL;
