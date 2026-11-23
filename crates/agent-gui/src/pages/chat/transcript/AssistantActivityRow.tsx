import { LiveAssistantStatus } from "@liveagent/ui/components/chat/AssistantStatus";
import { isPendingUserInteractionBlock } from "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils";
import { useRunningToolActivity } from "@liveagent/ui/components/chat/assistant-bubble/RoundContent";
import { trailingReplyTextLength } from "@liveagent/ui/components/chat/assistant-bubble/workTraceDisplay";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { memo, useMemo } from "react";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
import { AssistantRenderUnit } from "./AssistantRenderUnit";
import type {
  AssistantActivityRow as AssistantActivityRowModel,
  AssistantUnitRow,
} from "./rowModel";

function hasPendingInteractionCard(units: AssistantUnitRow[]) {
  return units.some(
    (unit) => unit.unit.kind === "block" && isPendingUserInteractionBlock(unit.unit.block),
  );
}

export const AssistantActivityRow = memo(function AssistantActivityRow(props: {
  row: AssistantActivityRowModel;
  showUsage?: boolean;
  usageContextWindow?: number;
  isCompactionRunning: boolean;
  /** 本对话有工具卡在审批门上（审批发生在执行前，不体现为运行中的工具）。 */
  hasPendingToolApproval?: boolean;
  toolStatus: string | null;
  retryAttempts?: RetryAttemptRecord[];
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
}) {
  const {
    row,
    showUsage,
    usageContextWindow,
    isCompactionRunning,
    hasPendingToolApproval = false,
    toolStatus,
    retryAttempts,
    workdir,
    onOpenFileLink,
    onResendFromEdit,
    onBranchConversation,
  } = props;

  // 回合停在用户身上（未应答的提问 / 计划卡，或卡在审批门上的工具）时没有任何
  // 东西在跑：进度指示改为静态，闪烁会把「等你决策」误报成「正在处理」。
  const awaitingDecision = useMemo(
    () => row.live && (hasPendingToolApproval || hasPendingInteractionCard(row.units)),
    [hasPendingToolApproval, row.live, row.units],
  );
  const workTrace = useMemo(() => {
    for (const unit of row.units) {
      if (unit.unit.kind === "work-trace") return unit.unit;
    }
    return null;
  }, [row.units]);
  const toolActivity = useRunningToolActivity(row.live ? workTrace?.entries : undefined);

  return (
    <div data-live-activity={row.live ? "true" : undefined} className="min-w-0 w-full max-w-full">
      {row.units.map((unit, index) => (
        <div key={unit.key} data-activity-key={unit.key} className="min-w-0 max-w-full">
          <AssistantRenderUnit
            row={unit}
            showUsage={showUsage}
            usageContextWindow={usageContextWindow}
            isCompactionRunning={unit.mutable ? isCompactionRunning : false}
            awaitingDecision={awaitingDecision}
            toolStatus={unit.mutable ? toolStatus : null}
            retryAttempts={unit.mutable ? retryAttempts : undefined}
            workdir={workdir}
            onOpenFileLink={onOpenFileLink}
            onResendFromEdit={onResendFromEdit}
            onBranchConversation={onBranchConversation}
          />
          {unit.gapAfter > 0 && index < row.units.length - 1 ? (
            <div aria-hidden="true" style={{ height: unit.gapAfter }} />
          ) : null}
        </div>
      ))}
      {/* The turn's single live status row, present for the whole turn: the
          current phase in plain words plus elapsed time (compaction shows its
          band here). Nothing above it carries a spinner; it disappears once
          the turn settles (live=false). */}
      {row.live ? (
        <LiveAssistantStatus
          className="pt-1"
          status={toolStatus}
          isCompaction={isCompactionRunning}
          awaitingDecision={awaitingDecision}
          startedAtMs={workTrace?.startedAtMs}
          toolActivity={toolActivity}
          replyTextLength={workTrace ? trailingReplyTextLength(workTrace.entries) : 0}
        />
      ) : null}
    </div>
  );
});
