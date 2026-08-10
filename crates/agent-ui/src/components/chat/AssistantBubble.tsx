import type { UiRound } from "@liveagent/app/lib/chat/assistantBubbleAdapter";
import { collectChangedFiles } from "@liveagent/app/lib/chat/changedFilesAdapter";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { memo, useMemo } from "react";
import { AssistantAvatar } from "./AssistantAvatar";
import { RoundContent } from "./assistant-bubble/RoundContent";
import { ChangedFilesCard } from "./ChangedFilesCard";

export { AssistantAvatar } from "./AssistantAvatar";
export {
  AssistantStatus,
  CompactingText,
  VibingText,
} from "./AssistantStatus";
export { RetryDetailsBlock } from "./assistant-bubble/RoundContent";

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
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
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
    workdir,
    onOpenFileLink,
  } = props;
  // 回复末尾的已编辑文件卡：聚合整条回复所有 round 的 Write/Edit/Delete，
  // 只在回复结束（流停止）后出现；脱敏视图（分享页隐藏工具内容）不渲染。
  const changedFiles = useMemo(
    () => (isStreaming || redactToolContent ? null : collectChangedFiles(rounds)),
    [isStreaming, redactToolContent, rounds],
  );

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
            workdir={workdir}
            onOpenFileLink={onOpenFileLink}
          />
        ))}
        {changedFiles ? <ChangedFilesCard summary={changedFiles} /> : null}
      </div>
    </div>
  );
});
