import { AssistantAvatar } from "@liveagent/ui/components/chat/AssistantAvatar";
import { LiveAssistantStatus } from "@liveagent/ui/components/chat/AssistantStatus";
import { RoundBlockContent } from "@liveagent/ui/components/chat/assistant-bubble/RoundContent";
import { RetryDetailsBlock } from "@liveagent/ui/components/chat/RetryDetailsBlock";
import { UsagePanel } from "@liveagent/ui/components/chat/UsagePanel";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { memo } from "react";
import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
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

  // 只有仍在直播的状态单元才渲染转圈状态行。落定交接阶段的同一单元
  // (live:false) 若继续渲染，会在底部留下一个永远旋转的 spinner——运行早已
  // 结束，用户却以为任务还在后台跑。
  const status =
    unit.kind === "status" && row.live ? (
      <LiveAssistantStatus
        status={toolStatus}
        isCompaction={isCompactionRunning}
        className="w-full"
      />
    ) : null;

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
