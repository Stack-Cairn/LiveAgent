// WebUI 端计划审批桥:计划卡片位于 transcript 深处,提交动作由 GatewayApp 注册
// (经 gateway chat_queue.plan_decision 送达桌面端计划挂起表)。模块级单例避免
// 跨多层组件做 props 透传,模式同 askUserQuestionBridge / toolApprovalBridge。
import type { PlanDecisionAnswer } from "@liveagent/ui/lib/chat/planMode";

export type PlanDecisionSubmitOutcome = {
  ok: boolean;
  message?: string;
  /** 桌面端结构化错误码直通(not_found = 计划已决定/被覆盖)。 */
  errorCode?: string;
};

type PlanDecisionHandler = (
  toolCallId: string,
  answer: PlanDecisionAnswer,
) => Promise<PlanDecisionSubmitOutcome>;

let handler: PlanDecisionHandler | null = null;

export function registerPlanDecisionHandler(next: PlanDecisionHandler | null) {
  handler = next;
}

// 本地决定态 overlay:参数标记(__exitPlanModePending/Approved)只随桌面端补发
// 的事件/快照更新,而计划提交即终止 run——审批发生在 run 结束后,没有后续事件
// 翻转标记,持久化投影里的卡片会永远保持可点。overlay 记录"本端已知的落定
// 事实"(批准成功/退回成功/桌面回报已失效),与标记合并后驱动卡片落定。
// 不落盘:刷新后 overlay 清空,点击陈旧按钮会再次得到 not_found 并重新落定。
const decidedOverlay = new Map<string, "approved" | "settled">();
const listeners = new Set<() => void>();
let overlayVersion = 0;

function markDecided(toolCallId: string, state: "approved" | "settled") {
  const key = toolCallId.trim();
  if (!key || decidedOverlay.get(key) === state) return;
  decidedOverlay.set(key, state);
  overlayVersion += 1;
  for (const listener of listeners) listener();
}

export function subscribePlanDecisionOverlay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPlanDecisionOverlayVersion(): number {
  return overlayVersion;
}

export function readPlanDecisionOverlay(toolCallId: string): "approved" | "settled" | undefined {
  return decidedOverlay.get(toolCallId.trim());
}

export async function submitPlanDecision(
  toolCallId: string,
  answer: PlanDecisionAnswer,
): Promise<PlanDecisionSubmitOutcome> {
  if (!handler) {
    return { ok: false, message: "Gateway connection is not ready." };
  }
  const outcome = await handler(toolCallId, answer);
  if (outcome.ok) {
    markDecided(toolCallId, answer.decision === "approve" ? "approved" : "settled");
  } else if (outcome.errorCode === "not_found") {
    // 计划已在别处决定或被新提交覆盖:卡片应落定,而非留着一个永远报错的按钮。
    markDecided(toolCallId, "settled");
  }
  return outcome;
}
