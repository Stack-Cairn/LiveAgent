import { TrajectoryView } from "@liveagent/ui/components/trajectory/TrajectoryView";
import type { TrajectoryHost } from "@liveagent/ui/contracts/trajectory";
import {
  toTrajectoryLiveAssistantMessage,
  toTrajectoryMessages,
} from "@liveagent/ui/lib/trajectory/transcriptMessages";
import { useMemo, useSyncExternalStore } from "react";
import type { RenderTimelineItem } from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import {
  desktopLiveTrajectoryEvents,
  desktopTrajectoryReloadVersion,
  subscribeDesktopLiveTrajectory,
} from "../../../lib/trajectory/liveTrajectory";

export function ConversationTrajectorySurface(props: {
  conversationId: string;
  host: TrajectoryHost;
  transcriptItems: readonly RenderTimelineItem[];
  liveTranscriptStore: LiveTranscriptStore;
  workdir?: string;
  hasMoreMessages: boolean;
  loadEarlierMessages: () => void | Promise<void>;
}) {
  const persistedMessages = useMemo(
    () => toTrajectoryMessages(props.transcriptItems),
    [props.transcriptItems],
  );
  const liveTranscriptSnapshot = useSyncExternalStore(
    props.liveTranscriptStore.subscribe,
    props.liveTranscriptStore.getSnapshot,
  );
  const liveAssistantMessage = useMemo(
    () =>
      toTrajectoryLiveAssistantMessage(
        liveTranscriptSnapshot,
        `trajectory-live-${props.conversationId}`,
      ),
    [liveTranscriptSnapshot, props.conversationId],
  );
  const messages = useMemo(
    () =>
      liveAssistantMessage === undefined
        ? persistedMessages
        : [...persistedMessages, liveAssistantMessage],
    [liveAssistantMessage, persistedMessages],
  );
  const liveEvents = useSyncExternalStore(subscribeDesktopLiveTrajectory, () =>
    desktopLiveTrajectoryEvents(props.conversationId),
  );
  const authoritativeRevision = useSyncExternalStore(subscribeDesktopLiveTrajectory, () =>
    desktopTrajectoryReloadVersion(props.conversationId),
  );

  return (
    <TrajectoryView
      conversationId={props.conversationId}
      host={props.host}
      messages={messages}
      workdir={props.workdir}
      hasMoreMessages={props.hasMoreMessages}
      loadEarlierMessages={props.loadEarlierMessages}
      liveEvents={liveEvents}
      liveOwnership="authoritative"
      authoritativeRevision={authoritativeRevision}
    />
  );
}
