import { LiveAssistantStatus } from "@liveagent/ui/components/chat/AssistantStatus";
import { AssistantWorkTrace } from "@liveagent/ui/components/chat/AssistantWorkTrace";
import type { AssistantTurnLayoutEntry } from "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils";
import {
  resolveActiveThinkingEntryKey,
  resolveActiveWorkEntry,
} from "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils";
import { RoundBlockContent } from "@liveagent/ui/components/chat/assistant-bubble/RoundContent";
import { RetryDetailsBlock } from "@liveagent/ui/components/chat/RetryDetailsBlock";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo } from "react";
import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { AssistantUnitRow } from "../transcript/rowModel";

export const AssistantBubbleUnit = memo(function AssistantBubbleUnit(props: {
  row: AssistantUnitRow;
  isCompactionRunning: boolean;
  awaitingDecision?: boolean;
  toolStatus: string | null;
  retryAttempts?: RetryAttemptRecord[];
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const {
    row,
    isCompactionRunning,
    awaitingDecision = false,
    toolStatus,
    retryAttempts,
    workdir,
    onOpenFileLink,
  } = props;
  const { unit } = row;
  if (unit.kind === "footer") return null;

  const workEntries = unit.kind === "work-trace" ? unit.entries : [];
  const activeThinkingKey =
    unit.kind === "work-trace" && row.live ? resolveActiveThinkingEntryKey(workEntries) : null;
  const collapsedTailEntry =
    unit.kind === "work-trace" && row.live ? resolveActiveWorkEntry(workEntries) : null;

  const renderWorkEntry = (entry: AssistantTurnLayoutEntry) => (
    <RoundBlockContent
      key={entry.key}
      block={entry.block}
      isLive={row.live}
      renderMode={row.renderMode}
      runningToolCallIds={entry.runningToolCallIds}
      thinkingOpen={row.live ? entry.thinkingOpen : false}
      isLatestThinking={entry.key === activeThinkingKey}
      traceKey={entry.key}
      showTurnStatus={
        row.live && unit.kind === "work-trace" && entry.key === unit.latestToolGroupKey
      }
      workdir={workdir}
      onOpenFileLink={onOpenFileLink}
    />
  );

  return (
    <div className="flex w-full max-w-full items-start gap-3">
      <div aria-hidden="true" className="h-7 w-7 shrink-0" />
      <div className={cn("min-w-0 flex-1 space-y-2", row.showAvatar ? "pt-0.5" : "")}>
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
            traceKey={row.key}
            standalone
            workdir={workdir}
            onOpenFileLink={onOpenFileLink}
          />
        ) : null}

        {unit.kind === "work-trace" ? (
          <AssistantWorkTrace
            className="mt-0"
            awaitingDecision={awaitingDecision}
            collapseAfterAnswer={unit.hasAnswer}
            collapsedTail={collapsedTailEntry ? renderWorkEntry(collapsedTailEntry) : null}
            durationMs={unit.durationMs}
            hasDetails={workEntries.length > 0 || isCompactionRunning}
            running={row.live}
          >
            {workEntries.map((entry) => renderWorkEntry(entry))}
            {isCompactionRunning ? (
              <LiveAssistantStatus status={toolStatus} isCompaction className="w-full py-1.5" />
            ) : null}
          </AssistantWorkTrace>
        ) : null}
      </div>
    </div>
  );
});
