import { callBackend } from "../backendClient";

export const TOOL_APPROVAL_TIMEOUT_MS = 30000;

export function getToolApprovalDeadlineAt(startedAt: number): number {
  return startedAt + TOOL_APPROVAL_TIMEOUT_MS;
}

/// 被批准的工具集合（按会话 ID）。
const approvedTools: Map<string, Set<string>> = new Map();

/// 待审批的工具集合（按会话 ID）。
const pendingTools: Map<string, Set<string>> = new Map();

/// 检查指定的工具是否已在该会话中被批准。
export function isSessionApproved(conversationId: string, toolName: string): boolean {
  const approved = approvedTools.get(conversationId);
  return approved ? approved.has(toolName) : false;
}

/// 检查会话中是否有待审批的工具。
export function hasPendingToolApproval(conversationId: string): boolean {
  const pending = pendingTools.get(conversationId);
  return pending ? pending.size > 0 : false;
}

/// 向后端请求工具批准。登记为待审批并等待用户决定。
export async function requestToolApproval(params: {
  conversationId: string;
  toolName: string;
  summary: string;
  recommended?: boolean;
}): Promise<{ approved: boolean }> {
  const { conversationId, toolName, summary, recommended } = params;

  // 登记为待审批。
  if (!pendingTools.has(conversationId)) {
    pendingTools.set(conversationId, new Set());
  }
  pendingTools.get(conversationId)!.add(toolName);

  try {
    // 向后端请求批准，直到用户决定或超时。
    const result = await callBackend<{ approved: boolean }>(
      "tool_approval_request",
      {
        conversation_id: conversationId,
        tool_name: toolName,
        summary,
        recommended: recommended ?? false,
        timeout_ms: TOOL_APPROVAL_TIMEOUT_MS,
      }
    );

    // 根据批准结果更新状态。
    const pending = pendingTools.get(conversationId);
    if (pending) {
      pending.delete(toolName);
    }

    if (result.approved) {
      if (!approvedTools.has(conversationId)) {
        approvedTools.set(conversationId, new Set());
      }
      approvedTools.get(conversationId)!.add(toolName);
    }

    return result;
  } catch (error) {
    // 批准请求失败或超时，视为被拒绝。
    const pending = pendingTools.get(conversationId);
    if (pending) {
      pending.delete(toolName);
    }

    return { approved: false };
  }
}

