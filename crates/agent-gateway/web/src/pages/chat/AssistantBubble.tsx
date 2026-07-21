import { memo, useMemo } from "react";
import type { UiRound } from "../../lib/chat/uiMessages";
import { AssistantAvatar } from "./assistant-bubble/AssistantAvatar";
import { RoundContent } from "./assistant-bubble/RoundContent";

export { AssistantAvatar } from "./assistant-bubble/AssistantAvatar";
export { RetryDetailsBlock } from "./assistant-bubble/RoundContent";
export { AssistantStatus, CompactingText, VibingText } from "./assistant-bubble/StatusText";

const EMPTY_RUNNING_TOOL_CALL_IDS: string[] = [];

export const AssistantBubble = memo(function AssistantBubble(props: {
  rounds: (UiRound & {
    key?: string;
    runningToolCallIds?: string[];
    thinkingOpen?: boolean;
  })[];
  showUsage?: boolean;
  usageContextWindow?: number;
  isLive?: boolean;
  // Whether the stream is actively receiving tokens. Defaults to `isLive` —
  // when the article is in the live snapshot after `done`, set this to `false`
  // so the caret hides while the structural live state (thinking expansion,
  // tool indicators, streaming mode) stays intact and the article does not
  // re-render in static mode.
  isStreaming?: boolean;
  // Fixed Streamdown render mode for every round in this bubble: live-born
  // entries keep "streaming" forever (even after they fold into committed
  // history), history-born entries render "static". Never flips per entry.
  renderMode?: "streaming" | "static";
  toolStatus?: string | null;
  toolStatusVariant?: "default" | "compaction";
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const {
    rounds,
    showUsage,
    usageContextWindow,
    isLive,
    isStreaming = isLive,
    renderMode,
    toolStatus,
    toolStatusVariant,
    readOnly = false,
    redactToolContent = false,
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
    <div className="assistant-bubble-shell flex w-full max-w-full items-start gap-3">
      <AssistantAvatar className="assistant-bubble-avatar" />
      <div className="assistant-bubble-content min-w-0 flex-1 space-y-2 pt-0.5">
        {rounds.map((round, idx) => (
          <RoundContent
            key={"key" in round && round.key ? round.key : `round-${round.round}`}
            round={round}
            showUsage={showUsage}
            usageContextWindow={usageContextWindow}
            isLive={isLive}
            isStreaming={isStreaming}
            isActive={isLive && idx === rounds.length - 1}
            renderMode={renderMode}
            toolStatus={idx === rounds.length - 1 ? toolStatus : null}
            toolStatusVariant={idx === rounds.length - 1 ? toolStatusVariant : "default"}
            runningToolCallIds={round.runningToolCallIds ?? EMPTY_RUNNING_TOOL_CALL_IDS}
            thinkingOpen={round.thinkingOpen}
            readOnly={readOnly}
            redactToolContent={redactToolContent}
            latestTodoItem={latestTodoItem}
          />
        ))}
      </div>
    </div>
  );
});
