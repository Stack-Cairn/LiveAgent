// 工具审批桥接(Node 侧薄壳):决策 4 指定审批状态机(pending 表、先到先得原子 CAS、
// 超时、推荐项自动选)全在 Rust。Node 只在 beforeToolCall 处调用 Rust 接口并 await 其结果。

import { callBackend } from "../backendClient";

/** 审批窗口毫秒数:复用 AskUserQuestion 的时长常量,行为口径一致。 */
export const TOOL_APPROVAL_TIMEOUT_MS = 60_000; // 由 Rust 侧兜底,此处为参考值

/** approve:本次放行;deny:本次拒绝;approve_session:本会话内该工具后续免审。 */
export type ToolApprovalDecision = "approve" | "deny" | "approve_session";

export type ToolApprovalSettlement =
  | { kind: "decided"; decision: ToolApprovalDecision }
  | { kind: "timeout" }
  | { kind: "cancelled" };

/**
 * 请求工具审批。由 beforeToolCall 的审批门调用,向 Rust 发起审批请求并等待结果。
 * Rust 维护 pending 表、超时、推荐项自动选等逻辑(决策 4)。
 */
export async function requestToolApproval(params: {
  toolCallId: string;
  toolName: string;
  summary?: string;
  conversationId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ToolApprovalSettlement> {
  try {
    const response = await callBackend<ToolApprovalSettlement>(
      "request_tool_approval",
      {
        toolCallId: params.toolCallId.trim(),
        toolName: params.toolName,
        summary: params.summary ?? "",
        conversationId: params.conversationId,
        timeoutMs: params.timeoutMs ?? TOOL_APPROVAL_TIMEOUT_MS,
      },
      params.signal
    );
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { kind: "cancelled" };
    }
    throw error;
  }
}

export type AnswerToolApprovalOutcome = { ok: boolean; message?: string };

/**
 * 应答一个挂起的审批。由前端审批卡片调用,转发用户决定给 Rust。
 * (此函数作为前端导入兼容层保留;实际接线由前端/Rust 协调完成。)
 */
export function answerToolApproval(
  _toolCallId: string,
  _decision: ToolApprovalDecision,
  _options?: { conversationId?: string }
): AnswerToolApprovalOutcome {
  // 占位:实际应答应由前端直接打 Rust 的 answer_tool_approval 接口
  return {
    ok: false,
    message: "answerToolApproval is not implemented on Node side; route through Rust",
  };
}
