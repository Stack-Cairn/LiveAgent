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
