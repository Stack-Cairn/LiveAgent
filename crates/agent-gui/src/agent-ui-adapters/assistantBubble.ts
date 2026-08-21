import type { AskUserQuestionAnswer } from "@liveagent/ui/lib/chat/askUserQuestion";
import type { PlanDecisionAnswer } from "@liveagent/ui/lib/chat/planMode";
import { useSyncExternalStore } from "react";
import {
  answerAskUserQuestion,
  getAskUserQuestionDeadlineAt,
} from "../lib/tools/askUserQuestionTools";
import {
  answerPlanDecision,
  getPlanDecisionVersion,
  isPlanApprovalToolCall,
  isPlanDecisionPending,
  subscribePlanDecisions,
} from "../lib/tools/planModeTools";
import {
  getPendingToolApproval,
  getToolApprovalVersion,
  subscribeToolApprovals,
} from "../lib/tools/toolApproval";

export const deferLargeToolImages = false;
export const retainRunningToolContent = true;

export function usePendingToolApproval(
  toolCallId: string,
  _toolArguments: Record<string, unknown>,
) {
  useSyncExternalStore(subscribeToolApprovals, getToolApprovalVersion, getToolApprovalVersion);
  return Boolean(getPendingToolApproval(toolCallId));
}

export function readAskUserQuestionDeadline(
  toolCallId: string,
  _toolArguments: Record<string, unknown>,
) {
  return getAskUserQuestionDeadlineAt(toolCallId) ?? undefined;
}

export function submitAskUserQuestionAnswers(toolCallId: string, answers: AskUserQuestionAnswer[]) {
  return Promise.resolve(answerAskUserQuestion(toolCallId, answers));
}

export function usePlanDecisionState(toolCallId: string, _toolArguments: Record<string, unknown>) {
  useSyncExternalStore(subscribePlanDecisions, getPlanDecisionVersion, getPlanDecisionVersion);
  return {
    pending: isPlanDecisionPending(toolCallId),
    approved: isPlanApprovalToolCall(toolCallId),
  };
}

export function submitPlanDecision(toolCallId: string, answer: PlanDecisionAnswer) {
  return Promise.resolve(answerPlanDecision(toolCallId, answer));
}
