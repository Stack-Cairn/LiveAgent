// 工具审批服务(桌面端权威):策略为 ask 的工具在 beforeToolCall 处挂起,等用户
// 在聊天里的审批卡片作出决定。与 AskUserQuestion 同构的挂起/落定/超时/中止模型
// (见 askUserQuestionTools.ts),差异有二:
//   1. 被审批的是普通工具调用(Bash/插件工具…),挂起发生在其执行之前,而非工具
//      自身;因此卡片需要响应式感知 pending 的出现/消失(useSyncExternalStore)。
//   2. 超时缺省为“拒绝”(权限不该默认放行),比 AskUserQuestion 的“自动选推荐”保守。
// 远端(WebUI)应答经 gateway chat_queue.tool_approval 转发到桌面后走同一入口
// answerToolApproval(第 3 步接线)。

import {
  ASK_USER_QUESTION_TIMEOUT_MS,
  scheduleAtDeadline,
} from "@liveagent/ui/lib/chat/askUserQuestion";

/** 审批窗口毫秒数:复用 AskUserQuestion 的时长常量,行为口径一致。 */
export const TOOL_APPROVAL_TIMEOUT_MS = ASK_USER_QUESTION_TIMEOUT_MS;

// 运行时审批窗口（毫秒）：由设置 system.interactiveTimeoutMinutes 经 App.tsx 注入
// （与 AskUserQuestion 同一设置、同一窗口；永不超时用很大的值表达）。未注入回退默认常量。
let configuredToolApprovalTimeoutMs = TOOL_APPROVAL_TIMEOUT_MS;

/** 由设置层注入运行时审批窗口（毫秒）。 */
export function setToolApprovalTimeoutMs(timeoutMs: number): void {
  configuredToolApprovalTimeoutMs = timeoutMs;
}

/** approve:本次放行;deny:本次拒绝;approve_session:本会话内该工具后续免审。 */
export type ToolApprovalDecision = "approve" | "deny" | "approve_session";

export type ToolApprovalSettlement =
  | { kind: "decided"; decision: ToolApprovalDecision }
  | { kind: "timeout" }
  | { kind: "cancelled" };

type PendingToolApproval = {
  conversationId: string;
  toolName: string;
  /** 命令/参数摘要(供审批栏统一展示;Bash 显示命令等)。 */
  summary: string;
  /** 权威应答截止时间戳(毫秒);卡片倒计时与超时兜底同源。 */
  deadlineAt: number;
  settle: (settlement: ToolApprovalSettlement) => void;
};

const pendingByToolCallId = new Map<string, PendingToolApproval>();

// 本会话内“记住(approve_session)”的工具名集合,按 conversationId 分区。
// 只存内存、随会话生命周期存在;持久化的策略走 settings.system.toolPolicies。
const sessionAllowByConversation = new Map<string, Set<string>>();

// useSyncExternalStore 订阅:pending 表变更时 bump version 并通知,驱动审批卡片
// 在挂起出现/落定时重渲染(被审批的工具调用本身早已在转录中)。
const listeners = new Set<() => void>();
let version = 0;

function emitChange() {
  version += 1;
  for (const listener of listeners) listener();
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
  deadlineAt: number;
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
      });
    }
  }
  return out;
}

export function isSessionApproved(conversationId: string, toolName: string): boolean {
  return sessionAllowByConversation.get(conversationId)?.has(toolName) ?? false;
}

function rememberSessionApproval(conversationId: string, toolName: string) {
  let set = sessionAllowByConversation.get(conversationId);
  if (!set) {
    set = new Set();
    sessionAllowByConversation.set(conversationId, set);
  }
  set.add(toolName);
}

export type AnswerToolApprovalOutcome = { ok: boolean; message?: string };

/** 应答一个挂起的审批;远端通道必须带 conversationId 防串会话应答。 */
export function answerToolApproval(
  toolCallId: string,
  decision: ToolApprovalDecision,
  options?: { conversationId?: string },
): AnswerToolApprovalOutcome {
  const pending = pendingByToolCallId.get(toolCallId.trim());
  if (!pending) {
    return { ok: false, message: "No pending approval (already decided or cancelled)." };
  }
  const expectedConversationId = options?.conversationId?.trim();
  if (expectedConversationId && expectedConversationId !== pending.conversationId) {
    return { ok: false, message: "Approval belongs to a different conversation." };
  }
  pending.settle({ kind: "decided", decision });
  return { ok: true };
}

/** 会话销毁兜底:挂起中的审批按“取消(未批准)”落定。正常中止由 AbortSignal 处理。 */
export function cancelPendingToolApprovalsForConversation(conversationId: string) {
  for (const [toolCallId, pending] of pendingByToolCallId) {
    if (pending.conversationId === conversationId) {
      pendingByToolCallId.delete(toolCallId);
      pending.settle({ kind: "cancelled" });
    }
  }
  sessionAllowByConversation.delete(conversationId);
}

/**
 * 挂起等待用户对一次工具调用作出审批决定。由 beforeToolCall 的审批门调用。
 * - AbortSignal(turn 停止)→ 落定为 cancelled。
 * - 超过窗口 → 落定为 timeout(门控按“拒绝”处理)。
 * - approve_session → 记入本会话免审集合。
 */
export function requestToolApproval(params: {
  toolCallId: string;
  toolName: string;
  summary?: string;
  conversationId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ToolApprovalSettlement> {
  const toolCallId = params.toolCallId.trim();
  const timeoutMs = params.timeoutMs ?? configuredToolApprovalTimeoutMs;
  const deadlineAt = Date.now() + timeoutMs;

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
      cancelTimeout();
      if (settlement.kind === "decided" && settlement.decision === "approve_session") {
        rememberSessionApproval(params.conversationId, params.toolName);
      }
      emitChange();
      resolve(settlement);
    };
    const onAbort = () => settle({ kind: "cancelled" });
    // 分段续期定时器：审批窗口可配到远超 setTimeout 的 32 位延迟上限，
    // 直接传大延迟会被静默截断（甚至立即触发）。见 scheduleAtDeadline。
    const cancelTimeout = scheduleAtDeadline(deadlineAt, () => settle({ kind: "timeout" }));
    const pending: PendingToolApproval = {
      conversationId: params.conversationId,
      toolName: params.toolName,
      summary: params.summary ?? "",
      deadlineAt,
      settle,
    };
    pendingByToolCallId.set(toolCallId, pending);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    emitChange();
  });
}
