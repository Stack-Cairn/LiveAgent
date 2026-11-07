import type { SubagentCardBinding } from "@liveagent/ui/contracts/subagentPane";
import type { AskUserQuestionAnswer } from "@liveagent/ui/lib/chat/askUserQuestion";
import type {
  McpElicitationAction,
  McpElicitationContent,
  McpElicitationSubmitOutcome,
} from "@liveagent/ui/lib/chat/mcpElicitation";
import type { PlanDecisionAnswer } from "@liveagent/ui/lib/chat/planMode";
import { useMemo, useSyncExternalStore } from "react";
import {
  getKBrainSubagentForToolCall,
  openKBrainSubagent,
  subscribeKBrainSubagents,
} from "../lib/subagents/kbrainSubagentStore";
import { kbrainSubagentView } from "../lib/subagents/kbrainSubagentView";
import {
  answerAskUserQuestion,
  getAskUserQuestionDeadlineAt,
  getAskUserQuestionVersion,
  hasPendingAskUserQuestion,
  subscribeAskUserQuestions,
} from "../lib/tools/askUserQuestionTools";
import {
  answerMcpElicitation,
  getMcpElicitationVersion,
  hasPendingMcpElicitationRequest,
  subscribeMcpElicitations,
} from "../lib/tools/mcpElicitations";
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

// An MCP elicitation form is answerable while the turn runner holds it in the pending store.
export function useMcpElicitationAnswerable(
  toolCallId: string,
  elicitationId: string,
  _toolArguments: Record<string, unknown> | undefined,
) {
  useSyncExternalStore(
    subscribeMcpElicitations,
    getMcpElicitationVersion,
    getMcpElicitationVersion,
  );
  return hasPendingMcpElicitationRequest(toolCallId, elicitationId);
}

export function submitMcpElicitation(
  toolCallId: string,
  elicitationId: string,
  action: McpElicitationAction,
  content?: McpElicitationContent,
): Promise<McpElicitationSubmitOutcome> {
  return answerMcpElicitation(toolCallId, elicitationId, action, content);
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

// The K-brain subagent the parent's `subagent` call started. Null until the backend
// links the two (older K-brain never does), and the plain tool row renders instead.
export function useSubagentCard(toolCallId: string): SubagentCardBinding | null {
  // Each snapshot must be stable between store changes, so read the entry and its
  // conversation separately rather than as a fresh pair.
  const entry = useSyncExternalStore(
    subscribeKBrainSubagents,
    () => getKBrainSubagentForToolCall(toolCallId)?.entry,
  );
  const conversationId = useSyncExternalStore(
    subscribeKBrainSubagents,
    () => getKBrainSubagentForToolCall(toolCallId)?.conversationId,
  );
  return useMemo(() => {
    if (!entry || !conversationId) return null;
    return {
      view: kbrainSubagentView(entry),
      open: () => openKBrainSubagent(conversationId, entry.subagent.id),
    };
  }, [conversationId, entry]);
}
