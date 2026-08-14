import { ToolApprovalBar } from "@liveagent/ui/components/chat/ToolApprovalBar";
import { useSyncExternalStore } from "react";
import {
  answerToolApproval,
  getToolApprovalVersion,
  listPendingToolApprovalsForConversation,
  subscribeToolApprovals,
} from "../../../lib/tools/toolApproval";

export function PendingToolApprovalBar({ conversationId }: { conversationId: string }) {
  useSyncExternalStore(subscribeToolApprovals, getToolApprovalVersion, getToolApprovalVersion);
  const pending = listPendingToolApprovalsForConversation(conversationId);
  if (pending.length === 0) return null;

  return (
    <ToolApprovalBar
      pending={pending}
      onDecide={(toolCallId, decision) =>
        Promise.resolve(answerToolApproval(toolCallId, decision, { conversationId }))
      }
      onDecideAll={async (decision) => {
        for (const item of pending) {
          answerToolApproval(item.toolCallId, decision, { conversationId });
        }
      }}
    />
  );
}
