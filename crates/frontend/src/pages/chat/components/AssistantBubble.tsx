import { memo, type ReactNode } from "react";

import type { ChatFileLink } from "../../../lib/chat/chatFileLinks";
import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
import { VIBING_STATUS } from "../../../lib/chat/page/chatPageHelpers";
import type { AssistantUnitRow } from "../transcript/rowModel";
import { AssistantAvatar } from "./assistant-bubble/AssistantAvatar";
import { RetryDetailsBlock, RoundBlockContent } from "./assistant-bubble/RoundContent";
import { AssistantStatus, CompactingText, VibingText } from "./assistant-bubble/StatusText";
import { UsagePanel } from "./assistant-bubble/UsagePanel";

export { AssistantAvatar } from "./assistant-bubble/AssistantAvatar";

export const AssistantBubbleUnit = memo(function AssistantBubbleUnit(props: {
  row: AssistantUnitRow;
  showUsage?: boolean;
  usageContextWindow?: number;
  isAgentMode: boolean;
  isCompactionRunning: boolean;
  toolStatus: string | null;
  retryAttempts?: RetryAttemptRecord[];
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
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
  } = props;
  const { unit } = row;
  if (unit.kind === "footer") return null;

  const isVibingStatus = toolStatus === VIBING_STATUS;
  let status: ReactNode = null;
  if (row.mutable && unit.kind === "placeholder") {
    if (unit.showFallbackStatus) {
      status = isCompactionRunning ? (
        <CompactingText />
      ) : isVibingStatus || !toolStatus ? (
        <VibingText />
      ) : (
        <AssistantStatus>{toolStatus}</AssistantStatus>
      );
    } else if (toolStatus) {
      status = isCompactionRunning ? (
        <CompactingText />
      ) : isVibingStatus ? (
        <VibingText />
      ) : (
        <AssistantStatus>{toolStatus}</AssistantStatus>
      );
    }
  } else if (
    row.mutable &&
    unit.kind === "block" &&
    toolStatus &&
    (!unit.hasRunningToolCall || isCompactionRunning || isVibingStatus)
  ) {
    status = isCompactionRunning ? (
      <CompactingText />
    ) : isVibingStatus ? (
      <VibingText />
    ) : (
      <AssistantStatus>{toolStatus}</AssistantStatus>
    );
  }

  return (
    <div className="flex w-full max-w-full items-start gap-3">
      {row.showAvatar ? (
        <AssistantAvatar />
      ) : (
        <div aria-hidden="true" className="h-7 w-7 shrink-0" />
      )}
      <div
        className={`min-w-0 flex-1 space-y-2 ${
          unit.kind === "placeholder" && unit.showFallbackStatus && isAgentMode
            ? "pt-1"
            : row.showAvatar
              ? "pt-0.5"
              : ""
        }`}
      >
        {status ? <div className="py-1.5">{status}</div> : null}

        {row.mutable && retryAttempts && retryAttempts.length > 0 ? (
          <RetryDetailsBlock attempts={retryAttempts} />
        ) : null}

        {unit.kind === "block" ? (
          <RoundBlockContent
            block={unit.block}
            isLive={row.live}
            isMutable={row.mutable}
            renderMode={row.renderMode}
            runningToolCallIds={unit.runningToolCallIds}
            thinkingOpen={unit.thinkingOpen}
            isLatestThinking={unit.isLatestThinking}
            isAborted={row.isAborted}
            workdir={workdir}
            onOpenFileLink={onOpenFileLink}
          />
        ) : null}

        {unit.kind === "block" && unit.isRoundTail && showUsage ? (
          <UsagePanel usage={unit.roundMeta?.usage} contextWindow={usageContextWindow} />
        ) : null}
      </div>
    </div>
  );
});
