export const TOOL_APPROVAL_TIMEOUT_MS = 30000;

export function getToolApprovalDeadlineAt(startedAt: number): number {
  return startedAt + TOOL_APPROVAL_TIMEOUT_MS;
}

const approvedTools: Map<string, Set<string>> = new Map();
const pendingTools: Map<string, Set<string>> = new Map();

export function isSessionApproved(_conversationId: string, _toolName: string): boolean {
  return false;
}

export function hasPendingToolApproval(_conversationId: string): boolean {
  return false;
}

/// 临时 stub：返回超时的 settlement 以通过编译。
/// 真正的审批逻辑（与 Rust 交互）需要按 P3-08 的三方约定重写。
export async function requestToolApproval(_params: {
  conversationId: string;
  toolName: string;
  summary: string;
  recommended?: boolean;
  toolCallId?: string;
  signal?: AbortSignal;
}): Promise<{ kind: "timeout" | "decided" | "cancelled"; decision?: "approve" | "deny" | "approve_session" }> {
  // 临时返回超时，让 turns 能继续编译
  return Promise.resolve({ kind: "timeout" });
}
