import { ToolApprovalBar } from "@liveagent/ui/components/chat/ToolApprovalBar";
import { useCallback, useSyncExternalStore } from "react";
import {
  answerToolApproval,
  getPendingToolApprovalsSnapshot,
  type PendingToolApprovalSummary,
  subscribeToolApprovalsForConversation,
} from "../../../lib/tools/toolApproval";

type PendingToolApprovalBarProps = {
  conversationId: string;
  approvals?: PendingToolApprovalSummary[];
  /** The conversation's workspace; the card shows paths inside it relative to it. */
  workdir?: string;
};

function SubscribedPendingToolApprovalBar({
  conversationId,
  workdir,
}: {
  conversationId: string;
  workdir?: string;
}) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToolApprovalsForConversation(conversationId, listener),
    [conversationId],
  );
  const getSnapshot = useCallback(
    () => getPendingToolApprovalsSnapshot(conversationId),
    [conversationId],
  );
  const pending = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <PendingToolApprovalBarContent
      conversationId={conversationId}
      pending={pending}
      workdir={workdir}
    />
  );
}

function PendingToolApprovalBarContent(props: {
  conversationId: string;
  pending: PendingToolApprovalSummary[];
  workdir?: string;
}) {
  const { conversationId, pending, workdir } = props;
  if (pending.length === 0) return null;

  return (
    <ToolApprovalBar
      pending={pending}
      workdir={workdir}
      onDecide={(toolCallId, decision, options) =>
        Promise.resolve(answerToolApproval(toolCallId, decision, { conversationId, ...options }))
      }
      onDecideAll={async (decision) => {
        for (const item of pending) {
          answerToolApproval(item.toolCallId, decision, { conversationId });
        }
      }}
    />
  );
}

export function PendingToolApprovalBar(props: PendingToolApprovalBarProps) {
  const { conversationId, approvals, workdir } = props;
  if (approvals) {
    return (
      <PendingToolApprovalBarContent
        conversationId={conversationId}
        pending={approvals}
        workdir={workdir}
      />
    );
  }
  return <SubscribedPendingToolApprovalBar conversationId={conversationId} workdir={workdir} />;
}
