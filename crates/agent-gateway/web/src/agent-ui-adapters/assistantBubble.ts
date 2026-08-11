import type { AskUserQuestionAnswer } from "@liveagent/ui/lib/chat/askUserQuestion";
import { readAskUserQuestionDeadlineAt } from "@liveagent/ui/lib/chat/askUserQuestion";
import { readToolApprovalPending } from "@liveagent/ui/lib/chat/toolApprovalArgs";
import { submitAskUserQuestionAnswer } from "../lib/chat/askUserQuestionBridge";

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
