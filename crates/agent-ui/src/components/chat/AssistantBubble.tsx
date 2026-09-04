import type { UiRound } from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import { collectChangedFiles } from "@liveagent/ui/lib/chat/changedFiles";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { memo, useMemo } from "react";
import { AssistantAvatar } from "./AssistantAvatar";
import { AssistantTurnContent } from "./assistant-bubble/RoundContent";
import { ChangedFilesCard } from "./ChangedFilesCard";

export { AssistantAvatar } from "./AssistantAvatar";
export {
  AssistantStatus,
  CompactingText,
  LiveAssistantStatus,
  VibingText,
} from "./AssistantStatus";
export { RetryDetailsBlock } from "./RetryDetailsBlock";

export const AssistantBubble = memo(function AssistantBubble(props: {
  rounds: (UiRound & {
    key?: string;
    runningToolCallIds?: string[];
    thinkingOpen?: boolean;
  })[];
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
  durationMs?: number;
  readOnly?: boolean;
  redactToolContent?: boolean;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const {
    rounds,
    isLive,
    isStreaming = isLive,
    renderMode,
    toolStatus,
    toolStatusVariant,
    durationMs,
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
        <AssistantTurnContent
          rounds={rounds}
          isLive={isLive}
          isStreaming={isStreaming}
          renderMode={renderMode}
          toolStatus={toolStatus}
          toolStatusVariant={toolStatusVariant}
          durationMs={durationMs}
          readOnly={readOnly}
          redactToolContent={redactToolContent}
          workdir={workdir}
          onOpenFileLink={onOpenFileLink}
        />
        {changedFiles ? <ChangedFilesCard summary={changedFiles} /> : null}
      </div>
    </div>
  );
});
