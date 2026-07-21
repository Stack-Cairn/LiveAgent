import { memo } from "react";

import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import { VIBING_STATUS } from "../../../lib/chat/page/chatPageHelpers";
import {
  AssistantAvatar,
  AssistantBubble,
  AssistantStatus,
  CompactingText,
  RetryDetailsBlock,
  VibingText,
} from "../components/AssistantBubble";
import { AssistantRowFooter } from "./RowActions";
import type { AssistantRow as AssistantRowData } from "./rowModel";

export type AssistantRowProps = {
  row: AssistantRowData;
  showUsage?: boolean;
  usageContextWindow?: number;
  // Live-row status inputs; settled rows receive the idle values so memo
  // comparisons stay cheap and stable.
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

// One body for the streaming reply and the settled reply. The live row and
// its committed twin share the row key, the round keys and the block ids, so
// when a run settles React reconciles this same tree in place — Streamdown
// state, shiki output and thinking-block scroll positions all survive.
// Run-scoped state (sending flag, branch spinner) lives in the row
// interaction store read by the footer, so settled-row props never change
// across run boundaries.
export const AssistantRow = memo(function AssistantRow(props: AssistantRowProps) {
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

  return (
    <div className={`group/assistant w-full max-w-full ${row.compacted ? "opacity-70" : ""}`}>
      {row.rounds.length > 0 ? (
        <AssistantBubble
          rounds={row.rounds}
          showUsage={showUsage}
          usageContextWindow={usageContextWindow}
          isLive={row.live}
          renderMode={row.renderMode}
          toolStatus={row.live ? toolStatus : null}
          toolStatusVariant={row.live && isCompactionRunning ? "compaction" : "default"}
          retryAttempts={row.live ? retryAttempts : undefined}
        />
      ) : row.live ? (
        <div className="flex w-full max-w-full items-start gap-3">
          <AssistantAvatar />
          <div className={`min-w-0 flex-1 space-y-2 ${isAgentMode ? "pt-1" : "pt-0.5"}`}>
            {isCompactionRunning ? (
              <div className="flex items-center py-1">
                <CompactingText />
              </div>
            ) : toolStatus === VIBING_STATUS ? (
              <div className="flex items-center py-1">
                <VibingText />
              </div>
            ) : toolStatus ? (
              <div className="py-1">
                <AssistantStatus>{toolStatus}</AssistantStatus>
              </div>
            ) : (
              <div className="py-1">
                <VibingText />
              </div>
            )}
            {retryAttempts && retryAttempts.length > 0 ? (
              <RetryDetailsBlock attempts={retryAttempts} />
            ) : null}
          </div>
        </div>
      ) : null}
      {row.live ? null : (
        <AssistantRowFooter
          timestamp={row.timestamp}
          replyText={row.replyText}
          retryTarget={row.retryTarget}
          onResendFromEdit={onResendFromEdit}
          onBranchConversation={onBranchConversation}
        />
      )}
    </div>
  );
});
