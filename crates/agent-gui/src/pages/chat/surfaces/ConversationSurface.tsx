import type { ReactNode } from "react";
import type {
  ConversationSurfaceController,
  ConversationSurfaceSnapshot,
} from "../conversations/conversationControllerTypes";
import { useConversationSurfaceSnapshot } from "../conversations/useConversationSurfaceSnapshot";

type ConversationSurfaceContent = {
  transcript: ReactNode;
  composer: ReactNode;
};

type ConversationSurfaceProps = {
  paneId: string;
  controller: ConversationSurfaceController;
  renderContent(snapshot: ConversationSurfaceSnapshot): ConversationSurfaceContent;
};

export function ConversationSurface(props: ConversationSurfaceProps) {
  const { paneId, controller, renderContent } = props;
  const snapshot = useConversationSurfaceSnapshot(controller);
  const { transcript, composer } = renderContent(snapshot);

  return (
    <div
      data-workbench-pane-id={paneId}
      data-workbench-surface="conversation"
      data-workbench-surface-id={`conversation:${snapshot.conversationId}`}
      data-conversation-compaction-phase={snapshot.compaction.phase}
      data-conversation-approval-count={snapshot.approvals.length}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div data-conversation-transcript="" className="contents">
        {transcript}
      </div>
      <div data-conversation-composer="" className="contents">
        {composer}
      </div>
    </div>
  );
}
