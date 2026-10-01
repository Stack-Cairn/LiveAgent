import { TaskProgressBar } from "@liveagent/ui/components/chat/TaskProgressBar";
import {
  selectLatestTaskProgress,
  selectRoundsTaskProgress,
} from "@liveagent/ui/lib/chat/taskProgress";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { RenderTimelineItem } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";

export function CurrentTaskProgress(props: {
  historyItems: readonly RenderTimelineItem[];
  liveTranscriptStore: LiveTranscriptStore;
  isConversationRunning: boolean;
}) {
  const { historyItems, liveTranscriptStore, isConversationRunning } = props;
  const getLiveRoundsSnapshot = useCallback(
    () => liveTranscriptStore.getSnapshot().liveRounds,
    [liveTranscriptStore],
  );
  const liveRounds = useSyncExternalStore(
    liveTranscriptStore.subscribe,
    getLiveRoundsSnapshot,
    getLiveRoundsSnapshot,
  );
  // 历史基线与 live 尾部分开记忆：draft/toolStatus 的 emit 不换 liveRounds
  // 引用（useSyncExternalStore 直接 bail），LR flush 也只重扫 live 轮次，
  // 不再每帧全量遍历整个会话历史。live 选择器是三态：undefined = live 里尚无
  // 任务结果（沿用基线）；null = live 明确清空（空 TaskList），必须覆盖基线，
  // 不能回退成旧列表。
  const historyBaseline = useMemo(() => selectLatestTaskProgress(historyItems), [historyItems]);
  const liveSnapshot = useMemo(() => selectRoundsTaskProgress(liveRounds), [liveRounds]);
  const snapshot = liveSnapshot === undefined ? historyBaseline : liveSnapshot;
  return <TaskProgressBar snapshot={snapshot} isConversationRunning={isConversationRunning} />;
}
