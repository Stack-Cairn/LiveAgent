import { AssistantWorkTrace } from "@liveagent/ui/components/chat/AssistantWorkTrace";
import type { AssistantTurnLayoutEntry } from "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils";
import {
  RoundBlockContent,
  useWorkTraceModel,
  useWorkTraceRows,
} from "@liveagent/ui/components/chat/assistant-bubble/RoundContent";
import { RetryDetailsBlock } from "@liveagent/ui/components/chat/RetryDetailsBlock";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { memo } from "react";
import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { AssistantUnitRow } from "../transcript/rowModel";

const EMPTY_WORK_ENTRIES: AssistantTurnLayoutEntry[] = [];

export const AssistantBubbleUnit = memo(function AssistantBubbleUnit(props: {
  row: AssistantUnitRow;
  /**
   * Turn-level status inputs. The trace no longer renders any status of its own
   * (the activity row's single status row does), so these are ignored here.
   */
  isCompactionRunning?: boolean;
  awaitingDecision?: boolean;
  toolStatus?: string | null;
  retryAttempts?: RetryAttemptRecord[];
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const { row, retryAttempts, workdir, onOpenFileLink } = props;
  const { unit } = row;
  const workEntries = unit.kind === "work-trace" ? unit.entries : EMPTY_WORK_ENTRIES;
  const running = unit.kind === "work-trace" && row.live;
  const model = useWorkTraceModel(workEntries, running);
  const { rows, collapsedTail } = useWorkTraceRows(model, {
    running,
    renderMode: row.renderMode,
    workdir,
    onOpenFileLink,
  });
  if (unit.kind === "footer") return null;

  return (
    <div className="w-full max-w-full">
      <div className="min-w-0 space-y-2">
        {row.mutable && retryAttempts && retryAttempts.length > 0 ? (
          <RetryDetailsBlock attempts={retryAttempts} />
        ) : null}

        {unit.kind === "block" ? (
          <RoundBlockContent
            block={unit.block}
            isLive={row.live}
            revealText={row.live}
            renderMode={row.renderMode}
            runningToolCallIds={unit.runningToolCallIds}
            thinkingOpen={unit.thinkingOpen}
            isLatestThinking={unit.isLatestThinking}
            traceKey={row.key}
            workdir={workdir}
            onOpenFileLink={onOpenFileLink}
          />
        ) : null}

        {unit.kind === "work-trace" ? (
          <AssistantWorkTrace
            className="mt-0"
            collapseAfterAnswer={unit.hasAnswer}
            collapsedTail={collapsedTail}
            durationMs={unit.durationMs}
            hasDetails={workEntries.length > 0}
            running={row.live}
            startedAtMs={unit.startedAtMs}
            stats={model.stats}
          >
            {rows}
          </AssistantWorkTrace>
        ) : null}
      </div>
    </div>
  );
});
