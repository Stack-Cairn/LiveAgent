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
 * 四条路径都要拦：
 * - **按 pid / window_id 寻址**：递归扫描整个入参。上游现约把目标包在
 *   `target` 对象里（`{"target":{"kind":"window","pid":…,"window_id":…}}`），
 *   只看顶层字段等于没拦——早期只认扁平参数的实现可以被官方写法直接绕过。
 * - **按屏幕坐标寻址**：坐标无法反查归属，改为和宿主窗口的实际矩形比对。
 *   模型完全可以从整屏截图上量出「允许」按钮的位置，再以
 *   `{"target":{"kind":"desktop"},"x":…,"y":…}` 发出来。窗口矩形每次调用
 *   前重新取（见 `loadSelfWindowRects`），窗口移动后判断依然成立。
 * - **无目标的键盘输入**：`press_key` / `hotkey` / `type_text` 在 desktop
 *   作用域下不要求 pid / window_id / 坐标，输入投递给**前台应用**——上面
 *   两道闸都管不到。`{"scope":"desktop","key":"return"}` 在宿主处于前台时
 *   等于按掉审批弹窗，`{"keys":["cmd","q"]}` 等于关掉应用。所以这类调用要
 *   查一次当前前台应用：前台是宿主就拒绝；**查不到也拒绝**（fail-closed，
 *   带 pid / window_id 的显式目标不受影响，能力不算丢失）。
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
 * JSON 那样做结构化剔除。但看到不等于能操作：坐标操作被矩形比对拦掉，
 * 无目标的键盘输入被前台检查拦掉，所以这是信息可见性问题，不是审批绕过。
 *
 * 已知极限：前台检查与驱动实际投递之间存在极短的 TOCTOU 窗口（检查通过
 * 后、按键落地前，焦点恰好切到宿主）。宿主侧守卫无法原子化这两步；检查
 * 已经做在发出调用的那一刻，这是能做到的最紧位置。
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

const SELF_FOREGROUND_REFUSAL =
  "LiveAgent 当前是前台应用，这次无明确目标的桌面键盘输入会直接落在宿主界面上" +
  "（可以按掉审批弹窗、用快捷键关闭应用），已被拒绝。请先聚焦目标应用（例如先点击它的窗口），" +
  "或改用带 pid / window_id 的显式窗口目标。（如确需自动化 LiveAgent 本身，" +
  "在「设置 → CUA」中打开「允许操作 LiveAgent 自身」。）";

const SELF_FOREGROUND_UNKNOWN_REFUSAL =
  "无法确认当前前台应用，已拒绝这次无明确目标的桌面键盘输入：确认不了它不会落在 LiveAgent " +
  "自己身上。请改用带 pid / window_id 的显式窗口目标，或稍后重试。";

type SelfIdentity = { pid: number };

/** 宿主窗口在屏幕坐标系里的矩形，单位与 cua-driver 的桌面坐标一致。 */
export type SelfWindowRect = { x: number; y: number; width: number; height: number };

/**
 * 宿主 pid 的缓存。
 *
 * **只缓存成功的结果。** 曾经是 `promise ??= invoke(...).catch(() => null)`
 * ——那会把一次瞬时 IPC 失败缓存成永久的 null，此后每一轮对话的守卫都直接
 * 返回 null（整道闸门关闭），用户看不到任何迹象。安全侧的缓存不该记住失败。
 */
let selfPidPromise: Promise<number | null> | null = null;

async function loadSelfPid(): Promise<number | null> {
  if (selfPidPromise) {
    const cached = await selfPidPromise;
    if (cached !== null) return cached;
  }
  const attempt = invoke<SelfIdentity>("cua_driver_self_identity")
    .then((identity) => readNumber(identity?.pid))
    .catch(() => null);
  selfPidPromise = attempt;
  return attempt;
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

/**
 * 当前前台应用的 pid。**不缓存**：焦点变化以百毫秒计，键盘调用本身不高频，
 * 每次判定过一趟 IPC 换来的是判断永远基于当下事实。取不到返回 null，
 * 调用方按 fail-closed 处理。
 */
async function loadFrontmostPid(): Promise<number | null> {
  try {
    return readNumber(await invoke<number>("cua_driver_frontmost_pid"));
  } catch {
    return null;
  }
}

/** 出参过滤时学到的宿主 window_id。进程级缓存，无需持久化。 */
const learnedSelfWindowIds = new Set<number>();

/**
 * 递归深度上限。入参是 MCP 的 JSON 参数，正常形态最多两三层；给足余量之后
 * 仍然封顶，免得畸形（或刻意构造的）深层结构把扫描拖垮。
 *
 * 超出上限时**当作命中**处理（见 `refuseSelfTargetedCall`）。扫不完就放行
 * 等于给出一条现成的绕过方式：把目标埋到第 13 层即可。宁可拒绝一个畸形到
 * 不像真实调用的请求。
 */
const MAX_SCAN_DEPTH = 12;

/** 拒绝一个深到扫不完的入参时给模型的说明。 */
const SELF_SCAN_DEPTH_REFUSAL =
  "调用参数的嵌套层级超出了安全检查的上限，已被拒绝：无法确认它是否以 LiveAgent 自身为目标。" +
  "请用扁平一些的参数重试。";

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

type ScanResult = "hit" | "truncated" | "clear";

/**
 * 深度遍历，对每个对象节点调用 `visit`。
 *
 * 返回 `hit`（visit 命中）、`truncated`（没命中，但有分支深到扫不完）或
 * `clear`（完整扫完且没命中）。三态而非布尔，是因为调用方要区分「确认安全」
 * 和「没能确认」——安全判定里这两者不能都当放行。
 */
function scanRecords(
  node: unknown,
  visit: (record: Record<string, unknown>) => boolean,
  depth = 0,
): ScanResult {
  if (depth > MAX_SCAN_DEPTH) return "truncated";

  const children = Array.isArray(node) ? node : null;
  if (!children) {
    const record = asRecord(node);
    if (!record) return "clear";
    if (visit(record)) return "hit";
    return scanChildren(Object.values(record), visit, depth);
  }
  return scanChildren(children, visit, depth);
}

function scanChildren(
  values: unknown[],
  visit: (record: Record<string, unknown>) => boolean,
  depth: number,
): ScanResult {
  let truncated = false;
  for (const value of values) {
    const result = scanRecords(value, visit, depth + 1);
    if (result === "hit") return "hit";
    if (result === "truncated") truncated = true;
  }
  return truncated ? "truncated" : "clear";
}

/**
 * 入参检查：按 pid / window_id 寻址的自指调用。返回拒绝理由，或 null 放行。
 *
 * 整棵参数树都要扫，不只是顶层：上游把目标包在 `target` 对象里，只看顶层
 * `pid` / `window_id` 会让官方写法原样通过。扫不完（超出深度上限）同样拒绝。
 */
export function refuseSelfTargetedCall(
  args: Record<string, unknown> | undefined,
  selfPid: number | null,
): string | null {
  if (!args) return null;

  const result = scanRecords(args, (record) => {
    if (selfPid !== null && PID_KEYS.some((key) => readNumber(record[key]) === selfPid)) {
      return true;
    }
    return WINDOW_ID_KEYS.some((key) => {
      const windowId = readNumber(record[key]);
      return windowId !== null && learnedSelfWindowIds.has(windowId);
    });
  });

  if (result === "hit") return SELF_TARGET_REFUSAL;
  if (result === "truncated") return SELF_SCAN_DEPTH_REFUSAL;
  return null;
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
  scanRecords(args, (record) => {
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
  scanRecords(args, (record) => {
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
 * 投递语义是「发给键盘焦点」的工具：desktop 作用域下不带 pid / window_id /
 * 坐标也能生效，v0.22.0 契约里 `press_key` 只要求 `key`、`hotkey` 只要求
 * `keys`、`type_text` 只要求 `text`。
 */
const FOCUS_DELIVERY_TOOLS = new Set(["type_text", "press_key", "hotkey"]);

/**
 * 这次调用是否是「无明确进程身份的键盘输入」——即投递目标由**当前焦点**
 * 决定、而不是由参数决定的那类。
 *
 * 两个条件：
 * - 是键盘 / 文本注入调用。除了按工具名认（上游现约的三个），还按参数形态
 *   兜底：带字符串 `key` 或字符串数组 `keys` 的调用一律算——上游改名或新增
 *   `hold_key` 之类的工具时不至于漏网。`text` 字段刻意**不**参与形态兜底：
 *   `clipboard_write` / 查找类工具也带 text，投递语义与焦点无关，误伤它们
 *   只会让守卫显得不可预测；`type_text` 本身已由工具名覆盖。
 * - 参数里**没有任何** pid / window_id。按契约，带了身份的调用（包括
 *   desktop scope + pid 的后台投递写法）投递给那个窗口，不跟焦点走；宿主
 *   自己的身份在此之前已被 `refuseSelfTargetedCall` 拒掉，所以走到这里的
 *   身份必然指向别的应用。刻意不看 `target.kind`：`kind: "window"` 但不带
 *   身份的调用本来就寻址不到任何窗口，按焦点投递处理是 fail-closed。
 */
export function isDesktopKeyboardCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
): boolean {
  const name = toolName.trim().toLowerCase();
  const byName = FOCUS_DELIVERY_TOOLS.has(name);
  const byShape =
    !byName &&
    args !== undefined &&
    scanRecords(args, (record) => {
      if (typeof record.key === "string") return true;
      return Array.isArray(record.keys) && record.keys.some((k) => typeof k === "string");
    }) === "hit";
  if (!byName && !byShape) return false;

  const identified =
    args !== undefined &&
    scanRecords(args, (record) =>
      [...PID_KEYS, ...WINDOW_ID_KEYS].some((key) => readNumber(record[key]) !== null),
    ) === "hit";
  return !identified;
}

/**
 * 入参检查：无明确目标的键盘输入，在宿主处于前台（或前台不可知）时拒绝。
 *
 * `frontmostPid` 为 null（查询失败 / 平台不支持）时**同样拒绝**：这里不能
 * 学窗口矩形那样「取不到就放行」——键盘输入不存在「误伤矩形下方真实目标」
 * 的二义性，而放行的代价是模型可以对宿主敲任意按键。拒绝话术会引导模型
 * 改用带 pid / window_id 的显式目标，能力不算丢失。
 */
export function refuseDesktopKeyboardCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
  selfPid: number,
  frontmostPid: number | null,
): string | null {
  if (!isDesktopKeyboardCall(toolName, args)) return null;
  if (frontmostPid === null) return SELF_FOREGROUND_UNKNOWN_REFUSAL;
  return frontmostPid === selfPid ? SELF_FOREGROUND_REFUSAL : null;
}

/**
 * 从 `from` 起找出下一段结构完整的 JSON，返回它在原文中的区间。
 *
 * 官方 MCP 的文本块通常是「一行 `✅ Windows listed` 摘要 + 一段 JSON」，
 * 要求整段 trim 后以 `{` / `[` 开头会让这类结果整个漏过过滤。扫描时要认
 * 字符串字面量与转义，否则 payload 里带花括号的字符串会把配对算错。
 */
function findJsonSpan(text: string, from = 0): { start: number; end: number } | null {
  for (let i = from; i < text.length; i++) {
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
    // 从这个位置起始的括号没有配平；再往后找也只会落进同一段未闭合文本。
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

  // 文本里可能不止一段 JSON（多次调用的合并结果、摘要 + 明细）。只处理第一段
  // 会让后面那些原样进模型，所以逐段扫到底。
  let out = "";
  let cursor = 0;
  let changedAny = false;

  for (let span = findJsonSpan(text, cursor); span; span = findJsonSpan(text, cursor)) {
    const raw = text.slice(span.start, span.end);
    const stripped = stripSelfFromJsonValue(raw, selfPid);
    out += text.slice(cursor, span.start) + (stripped ?? raw);
    if (stripped !== null) changedAny = true;
    cursor = span.end;
  }

  // 没有命中就返回原文，不重新拼接——避免无谓地改写模型看到的原文格式。
  if (!changedAny) return text;
  return out + text.slice(cursor);
}

/**
 * 剔除一段 JSON 文本里的宿主记录。有改动返回新的序列化结果，没改动或解析
 * 失败返回 null（调用方据此保留原文）。
 */
function stripSelfFromJsonValue(raw: string, selfPid: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
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
  return changed ? JSON.stringify(result) : null;
}

/** 供测试重置进程级缓存。 */
export function resetCuaSelfGuardCaches() {
  selfPidPromise = null;
  selfRectsCache = null;
  learnedSelfWindowIds.clear();
}

export type CuaSelfGuard = {
  /** 调用前检查；返回拒绝理由或 null。`toolName` 是 MCP 侧的原始工具名。 */
  refuse: (toolName: string, args: Record<string, unknown> | undefined) => Promise<string | null>;
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
  const selfPid = await loadSelfPid();
  if (selfPid === null) return null;
  return {
    refuse: async (toolName, args) => {
      const targeted = refuseSelfTargetedCall(args, selfPid);
      if (targeted) return targeted;
      // 无明确目标的键盘输入跟着焦点走，前台是宿主（或不可知）就拒绝。
      // 前台查询要过一趟 IPC，只在这次调用真的属于该类时才去取。
      if (isDesktopKeyboardCall(toolName, args)) {
        const keyboard = refuseDesktopKeyboardCall(
          toolName,
          args,
          selfPid,
          await loadFrontmostPid(),
        );
        if (keyboard) return keyboard;
      }
      // 窗口矩形同理，只在这次调用真的带了桌面坐标时才去取。
      if (!usesDesktopScreenCoordinates(args)) return null;
      return refuseSelfRegionCall(args, await loadSelfWindowRects());
    },
    strip: (text) => stripSelfFromJsonText(text, selfPid),
  };
}

export const CUA_SELF_TARGET_REFUSAL = SELF_TARGET_REFUSAL;
export const CUA_SELF_REGION_REFUSAL = SELF_REGION_REFUSAL;
export const CUA_SELF_SCAN_DEPTH_REFUSAL = SELF_SCAN_DEPTH_REFUSAL;
export const CUA_SELF_FOREGROUND_REFUSAL = SELF_FOREGROUND_REFUSAL;
export const CUA_SELF_FOREGROUND_UNKNOWN_REFUSAL = SELF_FOREGROUND_UNKNOWN_REFUSAL;
