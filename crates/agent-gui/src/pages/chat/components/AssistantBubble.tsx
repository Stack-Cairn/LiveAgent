import { AssistantAvatar } from "@liveagent/ui/components/chat/AssistantAvatar";
import {
  AssistantStatus,
  CompactingText,
  VibingText,
} from "@liveagent/ui/components/chat/AssistantStatus";
import {
  RetryDetailsBlock,
  RoundBlockContent,
} from "@liveagent/ui/components/chat/assistant-bubble/RoundContent";
import { UsagePanel } from "@liveagent/ui/components/chat/UsagePanel";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { memo, type ReactNode } from "react";
import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
import { VIBING_STATUS } from "../../../lib/chat/page/chatPageHelpers";
import type { AssistantUnitRow } from "../transcript/rowModel";

export { AssistantAvatar } from "@liveagent/ui/components/chat/AssistantAvatar";

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
  if (unit.kind === "status") {
    status = isCompactionRunning ? (
      <CompactingText className="w-full" />
    ) : isVibingStatus || !toolStatus ? (
      <VibingText className="w-full" />
    ) : (
      <AssistantStatus className="w-full">{toolStatus}</AssistantStatus>
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
          unit.kind === "status" && isAgentMode ? "pt-1" : row.showAvatar ? "pt-0.5" : ""
        }`}
      >
        {status ? <div className="min-w-0 max-w-full overflow-hidden py-1.5">{status}</div> : null}

        {row.mutable && retryAttempts && retryAttempts.length > 0 ? (
          <RetryDetailsBlock attempts={retryAttempts} />
        ) : null}

        {unit.kind === "block" ? (
          <RoundBlockContent
            block={unit.block}
            isLive={row.live}
            renderMode={row.renderMode}
            runningToolCallIds={unit.runningToolCallIds}
            thinkingOpen={unit.thinkingOpen}
            isLatestThinking={unit.isLatestThinking}
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
