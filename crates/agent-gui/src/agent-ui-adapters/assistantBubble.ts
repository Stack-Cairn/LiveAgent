import type { AskUserQuestionAnswer } from "@liveagent/ui/lib/chat/askUserQuestion";
import type { PlanDecisionAnswer } from "@liveagent/ui/lib/chat/planMode";
import { useSyncExternalStore } from "react";
import {
  answerAskUserQuestion,
  getAskUserQuestionDeadlineAt,
  getAskUserQuestionVersion,
  hasPendingAskUserQuestion,
  subscribeAskUserQuestions,
} from "../lib/tools/askUserQuestionTools";
import {
  getPermissionAutoResolved,
  getPermissionAutoResolvedVersion,
  subscribePermissionAutoResolved,
} from "../lib/tools/permissionAutoResolved";
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

export function usePermissionAutoResolved(
  toolCallId: string,
  _toolArguments: Record<string, unknown>,
) {
  useSyncExternalStore(
    subscribePermissionAutoResolved,
    getPermissionAutoResolvedVersion,
    getPermissionAutoResolvedVersion,
  );
  return getPermissionAutoResolved(toolCallId);
}

// The card is answerable only while the question is registered: the tool call arrives
// first, and K-brain may still be reviewing or waiting for approval before it asks.
export function useAskUserQuestionPending(
  toolCallId: string,
  _toolArguments: Record<string, unknown>,
) {
  useSyncExternalStore(
    subscribeAskUserQuestions,
    getAskUserQuestionVersion,
    getAskUserQuestionVersion,
  );
  return hasPendingAskUserQuestion(toolCallId);
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
