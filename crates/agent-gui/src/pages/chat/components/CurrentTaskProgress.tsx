import { TaskProgressBar } from "@liveagent/ui/components/chat/TaskProgressBar";
import { selectLatestTaskProgress } from "@liveagent/ui/lib/chat/taskProgress";
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
  const snapshot = useMemo(
    () => selectLatestTaskProgress(historyItems, liveRounds),
    [historyItems, liveRounds],
  );
  return <TaskProgressBar snapshot={snapshot} isConversationRunning={isConversationRunning} />;
}
