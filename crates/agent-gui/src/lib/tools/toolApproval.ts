// 工具审批服务(桌面端权威):策略为 ask 的工具在 beforeToolCall 处挂起,等用户
// 在聊天里的审批卡片作出决定。与 AskUserQuestion 同构的挂起/落定/超时/中止模型
// (见 askUserQuestionTools.ts),差异有二:
//   1. 被审批的是普通工具调用(Bash/插件工具…),挂起发生在其执行之前,而非工具
//      自身;因此卡片需要响应式感知 pending 的出现/消失(useSyncExternalStore)。
//   2. 超时缺省为“拒绝”(权限不该默认放行),比 AskUserQuestion 的“自动选推荐”保守。
// 远端(WebUI)应答经 gateway chat_queue.tool_approval 转发到桌面后走同一入口
// answerToolApproval(第 3 步接线)。

import { ASK_USER_QUESTION_TIMEOUT_MS } from "@liveagent/ui/lib/chat/askUserQuestion";
import {
  normalizeToolApprovalReason,
  normalizeToolApprovalRules,
  normalizeToolApprovalScope,
  type ToolApprovalAnswerOptions,
  type ToolApprovalRememberScope,
} from "@liveagent/ui/lib/chat/toolApprovalArgs";

/** 审批窗口毫秒数:复用 AskUserQuestion 的时长常量,行为口径一致。 */
export const TOOL_APPROVAL_TIMEOUT_MS = ASK_USER_QUESTION_TIMEOUT_MS;

/** approve:本次放行;deny:本次拒绝;approve_session:请后端在本会话内记住这条授权范围。 */
export type ToolApprovalDecision = "approve" | "deny" | "approve_session";

export type ToolApprovalSettlement =
  | ({ kind: "decided"; decision: ToolApprovalDecision } & ToolApprovalAnswerOptions)
  | { kind: "timeout" }
  | { kind: "cancelled" };

type PendingToolApproval = {
  conversationId: string;
  toolName: string;
  /** 命令/参数摘要(供审批栏统一展示;Bash 显示命令等)。 */
  summary: string;
  /** 权威应答截止时间戳(毫秒);卡片倒计时与超时兜底同源。null 表示一直等到用户决定。 */
  deadlineAt: number | null;
  /** 后端会记住 approve_session 时才为真;记忆由 K-brain 持有,前端不缓存。 */
  allowSession: boolean;
  /** approve_session 生效的授权范围(如 computer_exec 的 call:click)。 */
  sessionScope: string;
  /** 后端声明:这次允许即对本会话同类操作生效(如 Computer Use)。 */
  sessionWide: boolean;
  /** 允许并记住时后端会存的规则;空表示只能按本会话授权(或不能记住)。 */
  rememberRules: string[];
  defaultScope: ToolApprovalRememberScope;
  settle: (settlement: ToolApprovalSettlement) => void;
};

const pendingByToolCallId = new Map<string, PendingToolApproval>();

// useSyncExternalStore 订阅:pending 表变更时 bump version 并通知,驱动审批卡片
// 在挂起出现/落定时重渲染(被审批的工具调用本身早已在转录中)。
const listeners = new Set<() => void>();
const listenersByConversation = new Map<string, Set<() => void>>();
const pendingSnapshotsByConversation = new Map<string, PendingToolApprovalSummary[]>();
const EMPTY_PENDING_APPROVALS: PendingToolApprovalSummary[] = [];
Object.freeze(EMPTY_PENDING_APPROVALS);
let version = 0;

function emitChange(conversationId: string) {
  const key = conversationId.trim();
  version += 1;
  for (const listener of listeners) listener();
  if (!key) return;
  pendingSnapshotsByConversation.delete(key);
  const conversationListeners = listenersByConversation.get(key);
  if (!conversationListeners) return;
  for (const listener of Array.from(conversationListeners)) listener();
}

export function subscribeToolApprovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToolApprovalVersion(): number {
  return version;
}

export function subscribeToolApprovalsForConversation(
  conversationId: string,
  listener: () => void,
): () => void {
  const key = conversationId.trim();
  if (!key) return () => undefined;
  const conversationListeners = listenersByConversation.get(key) ?? new Set();
  conversationListeners.add(listener);
  listenersByConversation.set(key, conversationListeners);
  return () => {
    conversationListeners.delete(listener);
    if (conversationListeners.size === 0) {
      listenersByConversation.delete(key);
    }
  };
}

export function getPendingToolApproval(toolCallId: string): PendingToolApproval | null {
  return pendingByToolCallId.get(toolCallId.trim()) ?? null;
}

export function hasPendingToolApproval(toolCallId: string): boolean {
  return pendingByToolCallId.has(toolCallId.trim());
}

export function getToolApprovalDeadlineAt(toolCallId: string): number | null {
  return pendingByToolCallId.get(toolCallId.trim())?.deadlineAt ?? null;
}

/** 某会话当前全部待审批项(供输入框上方的集中审批栏遍历)。随 pending 表变更,
 *  经 subscribeToolApprovals/getToolApprovalVersion 的订阅响应式刷新。 */
export type PendingToolApprovalSummary = {
  toolCallId: string;
  toolName: string;
  summary: string;
  deadlineAt: number | null;
  allowSession: boolean;
  sessionScope: string;
  sessionWide: boolean;
  rememberRules: string[];
  defaultScope: ToolApprovalRememberScope;
};

export function listPendingToolApprovalsForConversation(
  conversationId: string,
): PendingToolApprovalSummary[] {
  const target = conversationId.trim();
  const out: PendingToolApprovalSummary[] = [];
  for (const [toolCallId, pending] of pendingByToolCallId) {
    if (pending.conversationId === target) {
      out.push({
        toolCallId,
        toolName: pending.toolName,
        summary: pending.summary,
        deadlineAt: pending.deadlineAt,
        allowSession: pending.allowSession,
        sessionScope: pending.sessionScope,
        sessionWide: pending.sessionWide,
        rememberRules: pending.rememberRules,
        defaultScope: pending.defaultScope,
      });
    }
  }
  return out;
}

export function getPendingToolApprovalsSnapshot(
  conversationId: string,
): PendingToolApprovalSummary[] {
  const key = conversationId.trim();
  if (!key) return EMPTY_PENDING_APPROVALS;
  const cached = pendingSnapshotsByConversation.get(key);
  if (cached) return cached;
  const pending = listPendingToolApprovalsForConversation(key);
  if (pending.length === 0) return EMPTY_PENDING_APPROVALS;
  pendingSnapshotsByConversation.set(key, pending);
  return pending;
}

export type AnswerToolApprovalOutcome = { ok: boolean; message?: string };

/** 应答一个挂起的审批;远端通道必须带 conversationId 防串会话应答。 */
export function answerToolApproval(
  toolCallId: string,
  decision: ToolApprovalDecision,
  options?: { conversationId?: string } & ToolApprovalAnswerOptions,
): AnswerToolApprovalOutcome {
  const pending = pendingByToolCallId.get(toolCallId.trim());
  if (!pending) {
    return { ok: false, message: "No pending approval (already decided or cancelled)." };
  }
  const expectedConversationId = options?.conversationId?.trim();
  if (expectedConversationId && expectedConversationId !== pending.conversationId) {
    return { ok: false, message: "Approval belongs to a different conversation." };
  }
  pending.settle({ kind: "decided", decision, scope: options?.scope, reason: options?.reason });
  return { ok: true };
}

/** 会话销毁兜底:挂起中的审批按“取消(未批准)”落定。正常中止由 AbortSignal 处理。 */
export function cancelPendingToolApprovalsForConversation(conversationId: string) {
  const targetConversationId = conversationId.trim();
  for (const [toolCallId, pending] of pendingByToolCallId) {
    if (pending.conversationId === targetConversationId) {
      pendingByToolCallId.delete(toolCallId);
      pending.settle({ kind: "cancelled" });
    }
  }
}

/**
 * 挂起等待用户对一次工具调用作出审批决定。由 K-brain 的 permission.requested 调用。
 * - AbortSignal(turn 停止)→ 落定为 cancelled。
 * - 超过窗口 → 落定为 timeout(门控按“拒绝”处理)。timeoutMs 为 null 时不设窗口,
 *   一直等到用户决定或中止(K-brain 自己不会超时,前端也不替用户拒绝)。
 * - allowSession 为假时 approve_session 按 approve 落定:后端不会记住,不能让用户以为记住了。
 * - scope 只随有规则可记的 approve_session 落定;reason 只随 deny 落定。
 */
export function requestToolApproval(params: {
  toolCallId: string;
  toolName: string;
  summary?: string;
  conversationId: string;
  allowSession?: boolean;
  sessionScope?: string;
  sessionWide?: boolean;
  rememberRules?: string[];
  defaultScope?: string;
  signal?: AbortSignal;
  timeoutMs?: number | null;
}): Promise<ToolApprovalSettlement> {
  const toolCallId = params.toolCallId.trim();
  const conversationId = params.conversationId.trim();
  const timeoutMs =
    params.timeoutMs === null ? null : (params.timeoutMs ?? TOOL_APPROVAL_TIMEOUT_MS);
  const deadlineAt = timeoutMs === null ? null : Date.now() + timeoutMs;

  if (params.signal?.aborted) {
    return Promise.resolve({ kind: "cancelled" });
  }

  return new Promise<ToolApprovalSettlement>((resolve) => {
    const settle = (settlement: ToolApprovalSettlement) => {
      // 幂等:首个到达的落定(用户决定/超时/中止)清理其余监听并广播。
      if (pendingByToolCallId.get(toolCallId) === pending) {
        pendingByToolCallId.delete(toolCallId);
      }
      params.signal?.removeEventListener("abort", onAbort);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      emitChange(conversationId);
      resolve(settlement.kind === "decided" ? decidedSettlement(settlement, pending) : settlement);
    };
    const onAbort = () => settle({ kind: "cancelled" });
    const timeoutId =
      timeoutMs === null
        ? undefined
        : setTimeout(() => settle({ kind: "timeout" }), Math.max(0, timeoutMs));
    const pending: PendingToolApproval = {
      conversationId,
      toolName: params.toolName,
      summary: params.summary ?? "",
      deadlineAt,
      allowSession: params.allowSession === true,
      sessionScope: params.sessionScope?.trim() ?? "",
      sessionWide: params.sessionWide === true,
      rememberRules: normalizeToolApprovalRules(params.rememberRules),
      defaultScope: normalizeToolApprovalScope(params.defaultScope) ?? "session",
      settle,
    };
    pendingByToolCallId.set(toolCallId, pending);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    emitChange(conversationId);
  });
}

// Only what the backend can act on survives: a scope needs rules to remember, a
// reason belongs to a denial, and approve_session without a session grant is once.
function decidedSettlement(
  settlement: Extract<ToolApprovalSettlement, { kind: "decided" }>,
  pending: PendingToolApproval,
): ToolApprovalSettlement {
  if (settlement.decision === "approve_session") {
    if (!pending.allowSession) return { kind: "decided", decision: "approve" };
    const scope =
      pending.rememberRules.length > 0 ? normalizeToolApprovalScope(settlement.scope) : undefined;
    return { kind: "decided", decision: "approve_session", ...(scope ? { scope } : {}) };
  }
  if (settlement.decision === "deny") {
    const reason = normalizeToolApprovalReason(settlement.reason);
    return { kind: "decided", decision: "deny", ...(reason ? { reason } : {}) };
  }
  return { kind: "decided", decision: "approve" };
}
