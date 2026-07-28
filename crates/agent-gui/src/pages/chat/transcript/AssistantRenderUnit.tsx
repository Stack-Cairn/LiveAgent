import { memo, useMemo } from "react";

import { ChangedFilesCard } from "../../../components/chat/ChangedFilesCard";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
import { collectChangedFiles } from "../../../lib/chat/messages/changedFiles";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import { AssistantAvatar, AssistantBubbleUnit } from "../components/AssistantBubble";
import { AssistantRowFooter } from "./RowActions";
import type { AssistantFooterRenderUnit, AssistantUnitRow } from "./rowModel";

export type AssistantRenderUnitProps = {
  row: AssistantUnitRow;
  showUsage?: boolean;
  usageContextWindow?: number;
  isAgentMode: boolean;
  isCompactionRunning: boolean;
  toolStatus: string | null;
  retryAttempts?: RetryAttemptRecord[];
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
};

const AssistantFooterUnit = memo(function AssistantFooterUnit(props: {
  unit: AssistantFooterRenderUnit;
  showAvatar: boolean;
  compacted: boolean;
  onResendFromEdit: AssistantRenderUnitProps["onResendFromEdit"];
  onBranchConversation?: AssistantRenderUnitProps["onBranchConversation"];
}) {
  const { unit, showAvatar, compacted, onResendFromEdit, onBranchConversation } = props;
  const changedFiles = useMemo(
    () => (unit.hasChangedFilesCandidate ? collectChangedFiles(unit.rounds) : null),
    [unit.hasChangedFilesCandidate, unit.rounds],
  );

  return (
    <div className={`group/assistant w-full max-w-full${compacted ? " opacity-70" : ""}`}>
      {changedFiles ? (
        <div className="flex w-full max-w-full items-start gap-3">
          {showAvatar ? (
            <AssistantAvatar />
          ) : (
            <div aria-hidden="true" className="h-7 w-7 shrink-0" />
          )}
          <div className={`min-w-0 flex-1 ${showAvatar ? "pt-0.5" : ""}`}>
            <ChangedFilesCard summary={changedFiles} />
          </div>
        </div>
      ) : showAvatar ? (
        <div className="flex w-full max-w-full items-start gap-3">
          <AssistantAvatar />
          <div className="min-w-0 flex-1" />
        </div>
      ) : null}
      <AssistantRowFooter
        timestamp={unit.timestamp}
        replyText={unit.replyText}
        retryTarget={unit.retryTarget}
        onResendFromEdit={onResendFromEdit}
        onBranchConversation={onBranchConversation}
      />
    </div>
  );
});

export const AssistantRenderUnit = memo(function AssistantRenderUnit(
  props: AssistantRenderUnitProps,
) {
  const {
    row,
    showUsage,
    usageContextWindow,
    isAgentMode,
    isCompactionRunning,
    toolStatus,
    retryAttempts,
    onResendFromEdit,
    onBranchConversation,
  } = props;
  const compactedClass = row.compacted ? " opacity-70" : "";

  if (row.unit.kind === "footer") {
    return (
      <AssistantFooterUnit
        unit={row.unit}
        showAvatar={row.showAvatar}
        compacted={row.compacted}
        onResendFromEdit={onResendFromEdit}
        onBranchConversation={onBranchConversation}
      />
    );
  }

  return (
    <div className={`group/assistant w-full max-w-full${compactedClass}`}>
      <AssistantBubbleUnit
        row={row}
        showUsage={showUsage}
        usageContextWindow={usageContextWindow}
        isAgentMode={isAgentMode}
        isCompactionRunning={isCompactionRunning}
        toolStatus={toolStatus}
        retryAttempts={retryAttempts}
      />
    </div>
  );
});
