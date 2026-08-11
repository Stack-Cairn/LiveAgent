// WebUI 端工具审批桥:审批卡片位于 transcript 深处,提交动作由 GatewayApp 注册
// (经 gateway chat_queue.tool_approval 送达桌面端审批挂起表)。模块级单例避免
// 跨多层组件做 props 透传,模式同 askUserQuestionBridge。
import type { ToolApprovalDecision } from "@liveagent/ui/lib/chat/toolApprovalArgs";

export type ToolApprovalSubmitOutcome = { ok: boolean; message?: string };

type ToolApprovalDecisionHandler = (
  toolCallId: string,
  decision: ToolApprovalDecision,
) => Promise<ToolApprovalSubmitOutcome>;

let handler: ToolApprovalDecisionHandler | null = null;

export function registerToolApprovalDecisionHandler(next: ToolApprovalDecisionHandler | null) {
  handler = next;
}

export function submitToolApprovalDecision(
  toolCallId: string,
  decision: ToolApprovalDecision,
): Promise<ToolApprovalSubmitOutcome> {
  if (!handler) {
    return Promise.resolve({ ok: false, message: "Gateway connection is not ready." });
  }
  return handler(toolCallId, decision);
}
