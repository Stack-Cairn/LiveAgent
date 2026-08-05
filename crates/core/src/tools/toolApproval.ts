// 工具审批(Node 引擎侧):审批状态机的权威在 Rust(backend approval.rs)——
// pending 表、先到先得 CAS、超时兜底都在那边。引擎这里只做两件事:
//   1. 会话内免审记忆(approve_session):纯引擎内存态,不值得一次网络往返
//   2. 把「需要人工」的审批变成一次对后端的长挂起 HTTP 调用,拿回三态决定
// 本地 pending 表只为 gatewayToolPreview 的审批标记服务(卡片渲染要同步读到
// pending 的出现/消失),不参与裁决。

import { callBackend } from "../backendClient";
import { ASK_USER_QUESTION_TIMEOUT_MS } from "../chat/askUserQuestion";

/** 审批窗口毫秒数:复用 AskUserQuestion 的时长常量,行为口径一致。
 *  作为 timeout_ms 传给后端;超时裁决发生在 Rust,这里不再起本地计时器。 */
export const TOOL_APPROVAL_TIMEOUT_MS = ASK_USER_QUESTION_TIMEOUT_MS;

/** approve:本次放行;deny:本次拒绝;approve_session:本会话内该工具后续免审。 */
export type ToolApprovalDecision = "approve" | "deny" | "approve_session";

export type ToolApprovalSettlement =
  | { kind: "decided"; decision: ToolApprovalDecision }
  | { kind: "timeout" }
  | { kind: "cancelled" };

type PendingToolApproval = {
  conversationId: string;
  toolName: string;
  /** 展示用截止时间;权威超时在 Rust,这里只喂给审批标记做倒计时。 */
  deadlineAt: number;
};

const pendingByToolCallId = new Map<string, PendingToolApproval>();

// 本会话内“记住(approve_session)”的工具名集合,按 conversationId 分区。
// 只存内存、随会话生命周期存在;持久化的策略走 settings.system.toolPolicies。
const sessionAllowByConversation = new Map<string, Set<string>>();

export function hasPendingToolApproval(toolCallId: string): boolean {
  return pendingByToolCallId.has(toolCallId.trim());
}

export function getToolApprovalDeadlineAt(toolCallId: string): number | null {
  return pendingByToolCallId.get(toolCallId.trim())?.deadlineAt ?? null;
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

/** 会话销毁兜底:清掉免审记忆与残留 pending 标记。裁决中的请求由其
 *  AbortSignal 终止,不在这里干预。 */
export function cancelPendingToolApprovalsForConversation(conversationId: string) {
  for (const [toolCallId, pending] of pendingByToolCallId) {
    if (pending.conversationId === conversationId) {
      pendingByToolCallId.delete(toolCallId);
    }
  }
  sessionAllowByConversation.delete(conversationId);
}

/**
 * 挂起等待审批决定。由 beforeToolCall 的审批门调用。
 * 与桌面版的契约一致:返回 Promise 前已同步登记 pending(调用方靠这一点
 * 在紧接着的补发里读到审批标记)。
 * - AbortSignal(turn 停止)→ cancelled。
 * - 后端超时兜底会以 decided(默认 deny)返回;传输层失败按 timeout 处理
 *   ——语义上都是「窗口内没拿到用户确认」,门控一律按拒绝。
 */
export async function requestToolApproval(params: {
  toolCallId: string;
  toolName: string;
  summary?: string;
  conversationId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ToolApprovalSettlement> {
  const toolCallId = params.toolCallId.trim();
  const timeoutMs = params.timeoutMs ?? TOOL_APPROVAL_TIMEOUT_MS;

  if (params.signal?.aborted) {
    return { kind: "cancelled" };
  }

  pendingByToolCallId.set(toolCallId, {
    conversationId: params.conversationId,
    toolName: params.toolName,
    deadlineAt: Date.now() + timeoutMs,
  });

  try {
    const response = await callBackend<{ decision: string }>(
      "tool_approval_request",
      {
        conversation_id: params.conversationId,
        tool_call_id: toolCallId,
        tool_name: params.toolName,
        summary: params.summary ?? "",
        recommended: null,
        timeout_ms: timeoutMs,
      },
      params.signal,
    );
    const decision = response.decision;
    if (decision !== "approve" && decision !== "deny" && decision !== "approve_session") {
      return { kind: "timeout" };
    }
    if (decision === "approve_session") {
      rememberSessionApproval(params.conversationId, params.toolName);
    }
    return { kind: "decided", decision };
  } catch (error) {
    if (params.signal?.aborted) {
      return { kind: "cancelled" };
    }
    return { kind: "timeout" };
  } finally {
    pendingByToolCallId.delete(toolCallId);
  }
}
