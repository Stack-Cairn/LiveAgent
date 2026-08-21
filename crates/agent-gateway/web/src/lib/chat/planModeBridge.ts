// WebUI 端计划审批桥:计划卡片位于 transcript 深处,提交动作由 GatewayApp 注册
// (经 gateway chat_queue.plan_decision 送达桌面端计划挂起表)。模块级单例避免
// 跨多层组件做 props 透传,模式同 askUserQuestionBridge / toolApprovalBridge。
import type { PlanDecisionAnswer } from "@liveagent/ui/lib/chat/planMode";

export type PlanDecisionSubmitOutcome = { ok: boolean; message?: string };

type PlanDecisionHandler = (
  toolCallId: string,
  answer: PlanDecisionAnswer,
) => Promise<PlanDecisionSubmitOutcome>;

let handler: PlanDecisionHandler | null = null;

export function registerPlanDecisionHandler(next: PlanDecisionHandler | null) {
  handler = next;
}

export function submitPlanDecision(
  toolCallId: string,
  answer: PlanDecisionAnswer,
): Promise<PlanDecisionSubmitOutcome> {
  if (!handler) {
    return Promise.resolve({ ok: false, message: "Gateway connection is not ready." });
  }
  return handler(toolCallId, answer);
}
