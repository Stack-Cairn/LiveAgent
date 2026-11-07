import { MCP_ELICITATION_SYNTHETIC_ARG_KEYS } from "./mcpElicitation";
import { deriveFileToolPreview, readStreamPreviewMeta } from "./toolPreview";

// 工具审批的网关同步契约:桌面端在同步给 WebUI 的工具参数上盖“待审批 + 截止
// 时间”标记(见 gatewayToolPreview),WebUI 据此渲染审批卡片并显示倒计时。
// 这些是 __ 前缀的合成参数,不参与展示(见 toolCallArgsForDisplay 过滤),也不
// 影响本地工具执行(执行用真实 arguments,非网关预览副本)。
// 本文件是两端共用的参数协议真源。

/** 工具调用正等待用户审批(真时 WebUI 渲染审批卡片)。 */
export const TOOL_APPROVAL_PENDING_ARG = "__toolApprovalPending";
/** 权威审批截止时间戳(毫秒);WebUI 倒计时与桌面计时同源。 */
export const TOOL_APPROVAL_DEADLINE_ARG = "__toolApprovalDeadlineAt";
/** 待审批工具的命令/参数摘要(桌面端算一次同步给 WebUI,审批栏统一展示)。 */
export const TOOL_APPROVAL_SUMMARY_ARG = "__toolApprovalSummary";
/** 后端会记住 approve_session 时为 true;缺省不提供"本会话始终允许"。 */
export const TOOL_APPROVAL_ALLOW_SESSION_ARG = "__toolApprovalAllowSession";
/** approve_session 生效的授权范围(如 computer_exec 的 call:click)。 */
export const TOOL_APPROVAL_SESSION_SCOPE_ARG = "__toolApprovalSessionScope";
/** 本次允许即对本会话同类操作生效(如 Computer Use);审批栏据此在批准前说明。 */
export const TOOL_APPROVAL_SESSION_WIDE_ARG = "__toolApprovalSessionWide";
/** "允许并记住"会存下的规则(K-brain permission_rules);缺省时不能选作用域。 */
export const TOOL_APPROVAL_REMEMBER_RULES_ARG = "__toolApprovalRememberRules";
/** 记住规则的默认作用域:session / project / user。 */
export const TOOL_APPROVAL_DEFAULT_SCOPE_ARG = "__toolApprovalDefaultScope";
/** 后端没有询问就放行了这次调用(permission.auto_resolved):{source, rule?, scope?}。 */
export const TOOL_PERMISSION_AUTO_RESOLVED_ARG = "__toolPermissionAutoResolved";
/** 审批重新弹出的原因(如后端存不下记住的规则),审批卡片照原文显示。 */
export const TOOL_APPROVAL_NOTICE_ARG = "__toolApprovalNotice";

/**
 * 待审批的文件改动:Edit 的替换前后、Write 的新内容。truncated 表示不是全文;split 表示
 * 两边是各自截断的片段,不能拿来对比,卡片分开显示原内容和新内容。
 */
export type ToolApprovalPreview = {
  path?: string;
  before: string;
  after: string;
  truncated: boolean;
  split?: boolean;
  /**
   * 后端算好的行式 diff（K-brain permission.requested.preview）。有值时卡片照它显示，
   * 不再对比 before/after；空串配 truncated 表示改动太大、后端没给 diff。
   */
  diff?: string;
  /** 这次写入会新建文件。 */
  newFile?: boolean;
};

/** K-brain 给 diff 的上限是 32 KiB；同步与显示时按字符数留同样的余量。 */
const PREVIEW_DIFF_MAX_CHARS = 32 * 1024;

/** 带 K-brain 预览的文件工具（LiveAgent 的 Edit/Write 与 K-brain 自带的 edit/write）。 */
const KBRAIN_PREVIEW_TOOL_NAMES = new Set(["Edit", "Write", "edit", "write"]);

function capPreviewDiff(diff: string) {
  if (diff.length <= PREVIEW_DIFF_MAX_CHARS) return { text: diff, cut: false };
  const end = diff.lastIndexOf("\n", PREVIEW_DIFF_MAX_CHARS);
  return { text: diff.slice(0, end > 0 ? end : PREVIEW_DIFF_MAX_CHARS), cut: true };
}

/**
 * permission.requested.preview（{path, diff?, new_file?, truncated?}）转成审批卡片的预览；
 * 形状不对或既没有 diff 也没被截断（无可显示）时返回 undefined，调用方退回按工具参数算。
 */
export function approvalPreviewFromKBrain(
  toolName: string,
  preview: unknown,
): ToolApprovalPreview | undefined {
  if (!KBRAIN_PREVIEW_TOOL_NAMES.has(toolName)) return undefined;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return undefined;
  const record = preview as Record<string, unknown>;
  const diff = typeof record.diff === "string" ? capPreviewDiff(record.diff) : undefined;
  const truncated = record.truncated === true || diff?.cut === true;
  if (!diff?.text && !truncated) return undefined;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  return {
    ...(path ? { path } : {}),
    before: "",
    after: "",
    truncated,
    diff: diff?.text ?? "",
    ...(record.new_file === true ? { newFile: true } : {}),
  };
}

/** 待审批改动的预览,桌面端算好后同步给 WebUI,两端显示同一份。 */
export const TOOL_APPROVAL_PREVIEW_ARG = "__toolApprovalPreview";

/** 只能由桌面端写的审批与权限合成参数;模型参数里的同名键在同步前丢掉。 */
export const TOOL_APPROVAL_SYNTHETIC_ARG_KEYS: readonly string[] = [
  TOOL_APPROVAL_PENDING_ARG,
  TOOL_APPROVAL_DEADLINE_ARG,
  TOOL_APPROVAL_SUMMARY_ARG,
  TOOL_APPROVAL_ALLOW_SESSION_ARG,
  TOOL_APPROVAL_SESSION_SCOPE_ARG,
  TOOL_APPROVAL_SESSION_WIDE_ARG,
  TOOL_APPROVAL_REMEMBER_RULES_ARG,
  TOOL_APPROVAL_DEFAULT_SCOPE_ARG,
  TOOL_PERMISSION_AUTO_RESOLVED_ARG,
  TOOL_APPROVAL_NOTICE_ARG,
  TOOL_APPROVAL_PREVIEW_ARG,
  // MCP elicitation forms are stamped only from the desktop's pending store too: a model
  // must not be able to fake a form on the WebUI.
  ...MCP_ELICITATION_SYNTHETIC_ARG_KEYS,
];

const PREVIEW_CONTEXT_LINES = 3;
const PREVIEW_CONTEXT_CHARS = 200;
const PREVIEW_MAX_CHARS = 4000;
const PREVIEW_ELLIPSIS = "…";

function capPreviewText(text: string) {
  if (text.length <= PREVIEW_MAX_CHARS) return { text, cut: false };
  // The marker counts toward the limit, so the synced copy stays inside it.
  const marker = `\n...[${text.length} chars in all]...`;
  let end = PREVIEW_MAX_CHARS - marker.length;
  // Never leave half of a surrogate pair at the cut.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end) + marker, cut: true };
}

const fits = (before: string, after: string) =>
  before.length <= PREVIEW_MAX_CHARS && after.length <= PREVIEW_MAX_CHARS;

// Cut both sides at the same shared text so the diff of what is left is still exact:
// whole shared lines first, then shared characters (one long line). Only when the
// differing part alone is over the limit are the sides cut on their own, and then they
// are shown apart instead of diffed, so no change is hidden and no kept line shows as
// deleted.
function editPreview(before: string, after: string) {
  if (fits(before, after)) return { before, after, truncated: false };

  const a = before.split("\n");
  const b = after.split("\n");
  const shortest = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shortest && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix += 1;
  }
  const head = Math.max(0, prefix - PREVIEW_CONTEXT_LINES);
  const tail = Math.max(0, suffix - PREVIEW_CONTEXT_LINES);
  const lineBefore = a.slice(head, a.length - tail).join("\n");
  const lineAfter = b.slice(head, b.length - tail).join("\n");
  if (fits(lineBefore, lineAfter)) return { before: lineBefore, after: lineAfter, truncated: true };

  const charShortest = Math.min(lineBefore.length, lineAfter.length);
  let same = 0;
  while (same < charShortest && lineBefore[same] === lineAfter[same]) same += 1;
  let sameEnd = 0;
  while (
    sameEnd < charShortest - same &&
    lineBefore[lineBefore.length - 1 - sameEnd] === lineAfter[lineAfter.length - 1 - sameEnd]
  ) {
    sameEnd += 1;
  }
  // Step out of a surrogate pair so no cut leaves half an emoji.
  const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  let from = Math.max(0, same - PREVIEW_CONTEXT_CHARS);
  if (from > 0 && isLow(lineBefore.charCodeAt(from))) from -= 1;
  let dropEnd = Math.max(0, sameEnd - PREVIEW_CONTEXT_CHARS);
  if (dropEnd > 0 && isLow(lineBefore.charCodeAt(lineBefore.length - dropEnd))) dropEnd -= 1;
  const clip = (text: string) =>
    (from > 0 ? PREVIEW_ELLIPSIS : "") +
    text.slice(from, text.length - dropEnd) +
    (dropEnd > 0 ? PREVIEW_ELLIPSIS : "");
  const charBefore = clip(lineBefore);
  const charAfter = clip(lineAfter);
  if (fits(charBefore, charAfter)) return { before: charBefore, after: charAfter, truncated: true };

  return {
    before: capPreviewText(charBefore).text,
    after: capPreviewText(charAfter).text,
    truncated: true,
    split: true,
  };
}

/**
 * 从工具参数取审批卡片的改动预览。桌面端拿完整参数:没超上限显示全文,超了先聚焦到
 * 改动处。WebUI 优先用桌面同步来的预览;没有时退回网关截断后的副本,Edit 有一边被
 * 截断就分开显示。不是 Edit/Write 或缺内容时返回 undefined。
 */
export function approvalPreviewFromToolCall(
  toolName: string,
  args: unknown,
): ToolApprovalPreview | undefined {
  if (toolName !== "Edit" && toolName !== "Write") return undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const rawPath = typeof record.path === "string" ? record.path : record.file_path;
  const path = typeof rawPath === "string" && rawPath.trim() ? { path: rawPath.trim() } : {};
  if (readStreamPreviewMeta(record)) {
    // The Gateway's copy: each side was cut on its own, so a cut Edit is not diffed.
    const file = deriveFileToolPreview({ name: toolName, arguments: record });
    if (file?.kind === "edit" && file.oldString.has && file.newString.has) {
      const cut = file.oldString.truncated || file.newString.truncated;
      return {
        ...path,
        before: file.oldString.text,
        after: file.newString.text,
        truncated: cut,
        ...(cut ? { split: true } : {}),
      };
    }
    if (file?.kind === "write" && file.content.has) {
      return { ...path, before: "", after: file.content.text, truncated: file.content.truncated };
    }
    return undefined;
  }
  if (toolName === "Edit") {
    const { old_string: before, new_string: after } = record;
    if (typeof before !== "string" || typeof after !== "string") return undefined;
    return { ...path, ...editPreview(before, after) };
  }
  if (typeof record.content !== "string") return undefined;
  const content = capPreviewText(record.content);
  return { ...path, before: "", after: content.text, truncated: content.cut };
}

/** 读同步来的预览参数;不是 Edit/Write 或形状不对时返回 undefined。 */
function syncedApprovalPreview(toolName: string, value: unknown): ToolApprovalPreview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { path, before, after, truncated, split, diff, newFile } = value as Record<string, unknown>;
  if (typeof diff === "string") {
    return approvalPreviewFromKBrain(toolName, { path, diff, new_file: newFile, truncated });
  }
  if (toolName !== "Edit" && toolName !== "Write") return undefined;
  if (typeof before !== "string" || typeof after !== "string") return undefined;
  const old = capPreviewText(before);
  const next = capPreviewText(after);
  const apart = split === true || (toolName === "Edit" && (old.cut || next.cut));
  return {
    ...(typeof path === "string" && path.trim() ? { path: path.trim() } : {}),
    before: old.text,
    after: next.text,
    truncated: truncated === true || old.cut || next.cut,
    ...(apart ? { split: true } : {}),
  };
}

/** 审批决定:allow=本次放行;deny=本次拒绝;approve_session=请后端记住这条授权范围。 */
export type ToolApprovalDecision = "approve" | "deny" | "approve_session";

/** "允许并记住"存规则的作用域,与 K-brain permission_rules 的 scope 同名。 */
export type ToolApprovalRememberScope = "session" | "project" | "user";

/** 决定之外的附带信息:approve_session 的作用域、deny 交给模型的说明。 */
export type ToolApprovalAnswerOptions = { scope?: ToolApprovalRememberScope; reason?: string };

/** 拒绝说明的长度上限,与审批摘要的 2000 字上限一致。 */
export const TOOL_APPROVAL_REASON_MAX_CHARS = 2000;

export function normalizeToolApprovalScope(value: unknown): ToolApprovalRememberScope | undefined {
  return value === "session" || value === "project" || value === "user" ? value : undefined;
}

export function normalizeToolApprovalReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, TOOL_APPROVAL_REASON_MAX_CHARS) : undefined;
}

/** 截短给人看的审批文本(规则、作用域说明);超长时以省略号结尾。 */
export function clampApprovalText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, maxChars - 1);
  // Never leave half of a surrogate pair at the cut.
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * 同步给 WebUI 的记住规则按序列化后的总长度截断:解释器命令的建议是整条命令的
 * 精确规则,可能和命令一样长;引号、反斜杠在 JSON 里还会变长,所以按序列化长度量。
 * 规则在 WebUI 只用于展示(回答只带作用域),截断无害。
 */
export function clampApprovalRules(rules: string[], maxChars: number): string[] {
  const out: string[] = [];
  const fits = (list: string[]) => JSON.stringify(list).length <= maxChars;
  for (const rule of rules) {
    if (fits([...out, rule])) {
      out.push(rule);
      continue;
    }
    // The longest cut of this rule that still fits; then stop adding rules.
    let low = 0;
    let high = rule.length;
    let best = "";
    while (low <= high) {
      const length = Math.floor((low + high) / 2);
      const text = clampApprovalText(rule, length);
      if (fits([...out, text])) {
        best = text;
        low = length + 1;
      } else high = length - 1;
    }
    if (best.length > 1) out.push(best);
    break;
  }
  return out;
}

/** 去重、去空的记住规则列表。 */
export function normalizeToolApprovalRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const rules: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const rule = entry.trim();
    if (rule && !rules.includes(rule)) rules.push(rule);
  }
  return rules;
}

/** WebUI 发给桌面的 chat_queue.tool_approval request_json。 */
export function buildToolApprovalRequestJson(
  decision: ToolApprovalDecision,
  options?: ToolApprovalAnswerOptions,
): string {
  const scope =
    decision === "approve_session" ? normalizeToolApprovalScope(options?.scope) : undefined;
  const reason = decision === "deny" ? normalizeToolApprovalReason(options?.reason) : undefined;
  return JSON.stringify({ decision, ...(scope ? { scope } : {}), ...(reason ? { reason } : {}) });
}

/** 桌面端解析 request_json;旧 WebUI 只发 {decision}。决定非法时返回 null。 */
export function parseToolApprovalRequestJson(
  requestJson: string | undefined,
): ({ decision: ToolApprovalDecision } & ToolApprovalAnswerOptions) | null {
  let value: unknown;
  try {
    value = JSON.parse(requestJson || "{}");
  } catch {
    return null;
  }
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const decision = record ? record.decision : value;
  if (decision !== "approve" && decision !== "deny" && decision !== "approve_session") return null;
  const scope = normalizeToolApprovalScope(record?.scope);
  const reason = normalizeToolApprovalReason(record?.reason);
  return { decision, ...(scope ? { scope } : {}), ...(reason ? { reason } : {}) };
}

export type ToolPermissionAutoResolved = {
  source: "rule" | "read_only";
  rule?: string;
  scope?: ToolApprovalRememberScope;
};

/** 规范化 permission.auto_resolved 的标记;来源未知时返回 null。 */
export function normalizeToolPermissionAutoResolved(
  value: unknown,
): ToolPermissionAutoResolved | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (source !== "rule" && source !== "read_only") return null;
  const rule =
    typeof record.rule === "string" && record.rule.trim() ? record.rule.trim() : undefined;
  const scope = normalizeToolApprovalScope(record.scope);
  return { source, ...(rule ? { rule } : {}), ...(scope ? { scope } : {}) };
}

export function readToolPermissionAutoResolved(args: unknown): ToolPermissionAutoResolved | null {
  if (!args || typeof args !== "object") return null;
  return normalizeToolPermissionAutoResolved(
    (args as Record<string, unknown>)[TOOL_PERMISSION_AUTO_RESOLVED_ARG],
  );
}

export function readToolApprovalPending(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  return (args as Record<string, unknown>)[TOOL_APPROVAL_PENDING_ARG] === true;
}

export function readToolApprovalDeadlineAt(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[TOOL_APPROVAL_DEADLINE_ARG];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 远端审批栏的一项;与桌面审批栏 PendingApprovalItem 同形。 */
export type RemoteToolApprovalItem = {
  toolCallId: string;
  toolName: string;
  summary?: string;
  deadlineAt?: number;
  allowSession: boolean;
  sessionScope?: string;
  sessionWide: boolean;
  /** 允许并记住会存的规则;非空时才能选作用域。 */
  rememberRules?: string[];
  defaultScope?: ToolApprovalRememberScope;
  preview?: ToolApprovalPreview;
  notice?: string;
};

/** 从同步过来的工具调用参数还原待审批项;未待审批时返回 null。两个 WebUI 收集器共用。 */
export function pendingToolApprovalFromToolCall(toolCall: {
  id: string;
  name: string;
  arguments?: unknown;
}): RemoteToolApprovalItem | null {
  const args = toolCall.arguments;
  if (!readToolApprovalPending(args)) return null;
  const record = args as Record<string, unknown>;
  const scope = record[TOOL_APPROVAL_SESSION_SCOPE_ARG];
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    summary: readToolApprovalSummary(args),
    deadlineAt: readToolApprovalDeadlineAt(args) ?? undefined,
    allowSession: record[TOOL_APPROVAL_ALLOW_SESSION_ARG] === true,
    sessionScope: typeof scope === "string" && scope.trim() ? scope.trim() : undefined,
    sessionWide: record[TOOL_APPROVAL_SESSION_WIDE_ARG] === true,
    ...rememberFields(record),
    ...previewAndNotice(toolCall.name, record),
  };
}

function previewAndNotice(toolName: string, record: Record<string, unknown>) {
  const preview =
    syncedApprovalPreview(toolName, record[TOOL_APPROVAL_PREVIEW_ARG]) ??
    approvalPreviewFromToolCall(toolName, record);
  const notice = record[TOOL_APPROVAL_NOTICE_ARG];
  return {
    ...(preview ? { preview } : {}),
    ...(typeof notice === "string" && notice.trim() ? { notice: notice.trim() } : {}),
  };
}

function rememberFields(record: Record<string, unknown>) {
  const rules = normalizeToolApprovalRules(record[TOOL_APPROVAL_REMEMBER_RULES_ARG]);
  if (rules.length === 0) return {};
  return {
    rememberRules: rules,
    defaultScope: normalizeToolApprovalScope(record[TOOL_APPROVAL_DEFAULT_SCOPE_ARG]) ?? "session",
  };
}

export function readToolApprovalSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const value = (args as Record<string, unknown>)[TOOL_APPROVAL_SUMMARY_ARG];
  return typeof value === "string" ? value : "";
}
