import type { AskUserQuestionAnswer } from "@liveagent/ui/lib/chat/askUserQuestion";
import { readAskUserQuestionDeadlineAt } from "@liveagent/ui/lib/chat/askUserQuestion";
import type { PlanDecisionAnswer } from "@liveagent/ui/lib/chat/planMode";
import { readPlanApprovedMarker, readPlanPendingMarker } from "@liveagent/ui/lib/chat/planMode";
import { readToolApprovalPending } from "@liveagent/ui/lib/chat/toolApprovalArgs";
import { useSyncExternalStore } from "react";
import { submitAskUserQuestionAnswer } from "../lib/chat/askUserQuestionBridge";
import {
  getPlanDecisionOverlayVersion,
  readPlanDecisionOverlay,
  submitPlanDecision as submitPlanDecisionViaGateway,
  subscribePlanDecisionOverlay,
} from "../lib/chat/planModeBridge";

export const deferLargeToolImages = true;
export const retainRunningToolContent = false;

export function usePendingToolApproval(
  _toolCallId: string,
  toolArguments: Record<string, unknown>,
) {
  return readToolApprovalPending(toolArguments);
}

export function readAskUserQuestionDeadline(
  _toolCallId: string,
  toolArguments: Record<string, unknown>,
) {
  return readAskUserQuestionDeadlineAt(toolArguments) ?? undefined;
}

export function submitAskUserQuestionAnswers(toolCallId: string, answers: AskUserQuestionAnswer[]) {
  return submitAskUserQuestionAnswer(toolCallId, answers);
}

export function usePlanDecisionState(toolCallId: string, toolArguments: Record<string, unknown>) {
  // 参数标记只随桌面端补发的事件/快照更新,而审批发生在规划 run 终止之后——
  // 没有后续事件翻转标记。本端 overlay 记录已知的落定事实(批准/退回/已失效),
  // 与标记合并:overlay 一旦落定,pending 立即熄灭,卡片不再保持可点的假象。
  useSyncExternalStore(
    subscribePlanDecisionOverlay,
    getPlanDecisionOverlayVersion,
    getPlanDecisionOverlayVersion,
  );
  const overlay = readPlanDecisionOverlay(toolCallId);
  return {
    pending: overlay === undefined && readPlanPendingMarker(toolArguments),
    approved: overlay === "approved" || readPlanApprovedMarker(toolArguments),
  };
}

export function submitPlanDecision(toolCallId: string, answer: PlanDecisionAnswer) {
  return submitPlanDecisionViaGateway(toolCallId, answer);
}
