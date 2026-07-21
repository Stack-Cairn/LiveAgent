import { memo, useMemo } from "react";

import type { RetryAttemptRecord } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { UiRound } from "../../../lib/chat/messages/uiMessages";

import { AssistantAvatar } from "./assistant-bubble/AssistantAvatar";
import { RoundContent } from "./assistant-bubble/RoundContent";

export { AssistantAvatar } from "./assistant-bubble/AssistantAvatar";
export { RetryDetailsBlock } from "./assistant-bubble/RoundContent";
export { AssistantStatus, CompactingText, VibingText } from "./assistant-bubble/StatusText";

const EMPTY_RUNNING_TOOL_CALL_IDS: string[] = [];
const EMPTY_RETRY_ATTEMPTS: RetryAttemptRecord[] = [];

export const AssistantBubble = memo(function AssistantBubble(props: {
  rounds: (UiRound & {
    runningToolCallIds?: string[];
    thinkingOpen?: boolean;
  })[];
  showUsage?: boolean;
  usageContextWindow?: number;
  isLive?: boolean;
  // Pinned per row: stream-born content renders in streaming mode forever,
  // history renders static. Never flips for a given row.
  renderMode?: "streaming" | "static";
  toolStatus?: string | null;
  toolStatusVariant?: "default" | "compaction";
  retryAttempts?: RetryAttemptRecord[];
}) {
  const {
    rounds,
    showUsage,
    usageContextWindow,
    isLive,
    renderMode,
    toolStatus,
    toolStatusVariant,
    retryAttempts,
  } = props;
  const latestTodoItem = useMemo(() => {
    for (let roundIndex = rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
      const blocks = rounds[roundIndex]?.blocks ?? [];
      for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
        const block = blocks[blockIndex];
        if (block?.kind === "tool" && block.item.toolCall.name === "TodoWrite") {
          return block.item;
        }
      }
    }
    return null;
  }, [rounds]);

  return (
    <div className="flex w-full max-w-full items-start gap-3">
      <AssistantAvatar />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        {rounds.map((round, idx) => (
          <RoundContent
            key={round.key}
            round={round}
            showUsage={showUsage}
            usageContextWindow={usageContextWindow}
            isLive={isLive}
            isActive={isLive && idx === rounds.length - 1}
            renderMode={renderMode}
            toolStatus={idx === rounds.length - 1 ? toolStatus : null}
            toolStatusVariant={idx === rounds.length - 1 ? toolStatusVariant : "default"}
            retryAttempts={idx === rounds.length - 1 ? retryAttempts : EMPTY_RETRY_ATTEMPTS}
            runningToolCallIds={round.runningToolCallIds ?? EMPTY_RUNNING_TOOL_CALL_IDS}
            thinkingOpen={round.thinkingOpen}
            latestTodoItem={latestTodoItem}
          />
        ))}
      </div>
    </div>
  );
});
