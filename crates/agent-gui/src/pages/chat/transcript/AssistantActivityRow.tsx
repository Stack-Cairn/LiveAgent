import { memo } from "react";

import type { ChatFileLink } from "../../../lib/chat/chatFileLinks";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import { AssistantRenderUnit } from "./AssistantRenderUnit";
import type { AssistantActivityRow as AssistantActivityRowModel } from "./rowModel";

export const AssistantActivityRow = memo(function AssistantActivityRow(props: {
  row: AssistantActivityRowModel;
  showUsage?: boolean;
  usageContextWindow?: number;
  isAgentMode: boolean;
  isCompactionRunning: boolean;
  toolStatus: string | null;
  retryAttempts?: RetryAttemptRecord[];
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
}) {
  const {
    row,
    showUsage,
    usageContextWindow,
    isAgentMode,
    isCompactionRunning,
    toolStatus,
    retryAttempts,
    workdir,
    onOpenFileLink,
    onResendFromEdit,
    onBranchConversation,
  } = props;

  return (
    <div data-live-activity={row.live ? "true" : undefined} className="min-w-0 w-full max-w-full">
      {row.units.map((unit, index) => (
        <div key={unit.key} data-activity-key={unit.key} className="min-w-0 max-w-full">
          <AssistantRenderUnit
            row={unit}
            showUsage={showUsage}
            usageContextWindow={usageContextWindow}
            isAgentMode={isAgentMode}
            isCompactionRunning={unit.mutable ? isCompactionRunning : false}
            toolStatus={unit.mutable ? toolStatus : null}
            retryAttempts={unit.mutable && unit.unit.kind === "status" ? retryAttempts : undefined}
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
    </div>
  );
});
