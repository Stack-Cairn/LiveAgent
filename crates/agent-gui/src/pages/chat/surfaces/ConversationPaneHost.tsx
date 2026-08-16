import { ChangedFilesActionsProvider } from "@liveagent/ui/components/chat/ChangedFilesCard";
import { FileDropOverlay } from "@liveagent/ui/components/chat/FileDropOverlay";
import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import type { ScrollFollowHandle } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import type { ProjectRef } from "@liveagent/ui/lib/workbench/types";
import { ChatComposerBar } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { CurrentTaskProgress } from "../components/CurrentTaskProgress";
import { PendingToolApprovalBar } from "../components/PendingToolApprovalBar";
import type { ConversationPaneHostHandle } from "../conversations/useConversationPaneHostBridge";
import { buildQueuedChatTurnPreview } from "../queue/chatTurnQueue";
import { ChatTranscript } from "../transcript/ChatTranscript";
import { useConversationPaneBinding } from "./ConversationPaneHostEnvironment";
import { ConversationSurface } from "./ConversationSurface";

export type ConversationPaneHostProps = {
  paneId: string;
  conversationId: string;
  project: ProjectRef;
};

export const ConversationPaneHost = forwardRef<
  ConversationPaneHostHandle,
  ConversationPaneHostProps
>(function ConversationPaneHost(props, forwardedRef) {
  const { paneId, conversationId, project } = props;
  const { controller, transcript, composer, changedFilesActions, isConversationRunning, fileDrop } =
    useConversationPaneBinding({ paneId, conversationId, project });
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const scrollFollowRef = useRef<ScrollFollowHandle | null>(null);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);

  useImperativeHandle(
    forwardedRef,
    () => ({
      getComposer: () => composerRef.current,
      getScrollFollow: () => scrollFollowRef.current,
    }),
    [],
  );

  useLayoutEffect(() => {
    const composer = composerRef.current;
    const draft = controller.getSnapshot().draft;
    if (draft) {
      composer?.setDraft(draft);
    } else {
      composer?.clear();
    }

    return () => {
      // Save only non-empty drafts. The page pipeline may already have
      // cleared this composer mid-switch (legacy reset semantics), so an
      // empty composer must not delete the draft cached in the registry —
      // deliberate clears propagate through the page-level draft cache.
      const nextDraft = composer?.getDraft();
      if (!nextDraft || nextDraft.isEmpty || !nextDraft.text.trim()) {
        return;
      }
      controller.setDraft(nextDraft);
    };
  }, [controller]);

  return (
    <ConversationSurface
      paneId={paneId}
      controller={controller}
      renderContent={(snapshot) => {
        const runtime = snapshot.runtime;
        const historyItems = runtime?.state.transcript.items ?? [];
        const isSending = runtime?.isSending ?? false;
        const isCompactionRunning = snapshot.compaction.phase === "running";
        const queuedTurns = snapshot.queue.map((item) => ({
          id: item.id,
          previewText: buildQueuedChatTurnPreview(item.draft),
          fileCount: item.uploadedFiles.length,
        }));

        return {
          transcript: (
            <ChangedFilesActionsProvider value={changedFilesActions}>
              <ChatTranscript
                {...transcript}
                conversationId={snapshot.conversationId}
                followRef={scrollFollowRef}
                historyItems={historyItems}
                hasMoreHistory={runtime?.state.transcript.hasMoreBefore ?? false}
                isSending={isSending}
                isCompactionRunning={isCompactionRunning}
                bottomReservePx={composerOverlayHeight}
              />
            </ChangedFilesActionsProvider>
          ),
          composer: (
            <ChatComposerBar
              {...composer}
              composerRef={composerRef}
              isSending={isSending}
              pendingUploadedFiles={snapshot.uploads}
              queuedTurns={queuedTurns}
              onStop={controller.stop}
              onManualCompactConfirm={controller.compact}
              manualCompactBlocked={isCompactionRunning}
              onHeightChange={setComposerOverlayHeight}
              taskProgressBar={
                <CurrentTaskProgress
                  key={snapshot.conversationId}
                  historyItems={historyItems}
                  liveTranscriptStore={transcript.liveTranscriptStore}
                  isConversationRunning={isSending || isConversationRunning}
                />
              }
              approvalBar={
                <PendingToolApprovalBar
                  conversationId={snapshot.conversationId}
                  approvals={snapshot.approvals}
                />
              }
              fileDropOverlay={
                fileDrop.active ? (
                  <FileDropOverlay
                    variant="composer"
                    canDropUpload={fileDrop.canDropUpload}
                    title={fileDrop.title}
                    description={fileDrop.description}
                    limitHint={fileDrop.limitHint}
                  />
                ) : null
              }
            />
          ),
        };
      }}
    />
  );
});
