// WebUI 端工具审批桥:审批卡片位于 transcript 深处,提交动作由 GatewayApp 注册
// (经 gateway chat_queue.tool_approval 送达桌面端审批挂起表)。模块级单例避免
// 跨多层组件做 props 透传,模式同 askUserQuestionBridge。
import type { ToolApprovalDecision } from "@liveagent/ui/lib/chat/toolApprovalArgs";

export type ToolApprovalSubmitOutcome = { ok: boolean; message?: string };

type ToolApprovalDecisionHandler = (
  toolCallId: string,
  decision: ToolApprovalDecision,
  conversationId?: string,
) => Promise<ToolApprovalSubmitOutcome>;

let handler: ToolApprovalDecisionHandler | null = null;

export function registerToolApprovalDecisionHandler(next: ToolApprovalDecisionHandler | null) {
  handler = next;
}

/**
 * conversationId 缺省时按"当前展示会话"路由(主视图);多看板的背景 Pane
 * 必须显式传自己的会话 id,避免审批被误提交到焦点会话。
 */
export function submitToolApprovalDecision(
  toolCallId: string,
  decision: ToolApprovalDecision,
  conversationId?: string,
): Promise<ToolApprovalSubmitOutcome> {
  if (!handler) {
    return Promise.resolve({ ok: false, message: "Gateway connection is not ready." });
  }
  return handler(toolCallId, decision, conversationId);
}
