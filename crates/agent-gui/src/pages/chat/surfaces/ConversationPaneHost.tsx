import { ChangedFilesActionsProvider } from "@liveagent/ui/components/chat/ChangedFilesCard";
import { FileDropOverlay } from "@liveagent/ui/components/chat/FileDropOverlay";
import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ScrollFollowHandle } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { ChatComposerBar } from "@liveagent/ui/pages/chat/ChatComposerBar";
import {
  type ForwardedRef,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PaneLoadingSkeleton } from "../../../components/app/PaneLoadingSkeleton";
import { ConversationStatsBarHost } from "../components/ConversationStatsBarHost";
import { CurrentTaskProgress } from "../components/CurrentTaskProgress";
import { DesktopCheckpointRewindProvider } from "../components/DesktopCheckpointRewindProvider";
import { PendingToolApprovalBar } from "../components/PendingToolApprovalBar";
import type { ConversationPaneHostHandle } from "../conversations/useConversationPaneHostBridge";
import { useConversationSurfaceSnapshot } from "../conversations/useConversationSurfaceSnapshot";
import { buildQueuedChatTurnPreview } from "../queue/chatTurnQueue";
import { ChatTranscript } from "../transcript/ChatTranscript";
import {
  type ConversationPaneRegistration,
  useConversationPaneRegistration,
} from "./ConversationPaneHostEnvironment";
import { ConversationSurface } from "./ConversationSurface";
import { beginPaneComposerDraftSession } from "./paneComposerDraftSession";
import { createPaneComposerSendHandler } from "./paneComposerSend";

export type ConversationPaneHostProps = {
  paneId: string;
};

export type RestorableConversationPaneHostProps = ConversationPaneHostProps & {
  title?: string;
  deferHydration?: boolean;
};

export const RestorableConversationPaneHost = forwardRef<
  ConversationPaneHostHandle,
  RestorableConversationPaneHostProps
>(function RestorableConversationPaneHost(props, forwardedRef) {
  const registration = useConversationPaneRegistration(props.paneId);
  if (!registration) {
    return <PendingConversationPaneHost />;
  }
  return (
    <RegisteredRestorableConversationPaneHost
      registration={registration}
      title={props.title}
      deferHydration={props.deferHydration ?? false}
      forwardedRef={forwardedRef}
    />
  );
});

function PendingConversationPaneHost() {
  const { t } = useLocale();
  return <PaneLoadingSkeleton label={t("chat.loadingConversation")} />;
}

function RegisteredRestorableConversationPaneHost(props: {
  registration: ConversationPaneRegistration;
  title?: string;
  deferHydration: boolean;
  forwardedRef: ForwardedRef<ConversationPaneHostHandle>;
}) {
  const { registration, title, deferHydration, forwardedRef } = props;
  const { t } = useLocale();
  const { controller } = registration.binding;
  const snapshot = useConversationSurfaceSnapshot(controller);

  useEffect(() => {
    if (snapshot.runtime || snapshot.lifecycle.hydrating || snapshot.lifecycle.hydrationFailed) {
      return;
    }
    let cancelled = false;
    const hydrate = () => {
      if (!cancelled) void controller.hydrate().catch(() => undefined);
    };
    if (!deferHydration) {
      hydrate();
      return;
    }
    if (typeof window.requestIdleCallback === "function") {
      const idleCallback = window.requestIdleCallback(hydrate, { timeout: 800 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idleCallback);
      };
    }
    const timeout = window.setTimeout(hydrate, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [
    controller,
    deferHydration,
    snapshot.lifecycle.hydrating,
    snapshot.lifecycle.hydrationFailed,
    snapshot.runtime,
  ]);

  if (!snapshot.runtime) {
    const loading = snapshot.lifecycle.hydrating;
    if (loading) {
      return <PaneLoadingSkeleton label={t("chat.loadingConversation")} />;
    }
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">{title || t("chat.pendingTitle")}</p>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
          onClick={() => void controller.retry().catch(() => undefined)}
        >
          {t("workbench.loadConversation")}
        </button>
      </div>
    );
  }

  return <RegisteredConversationPaneHost ref={forwardedRef} registration={registration} />;
}

export const ConversationPaneHost = forwardRef<
  ConversationPaneHostHandle,
  ConversationPaneHostProps
>(function ConversationPaneHost(props, forwardedRef) {
  const registration = useConversationPaneRegistration(props.paneId);
  if (!registration) {
    return <PendingConversationPaneHost />;
  }
  return <RegisteredConversationPaneHost ref={forwardedRef} registration={registration} />;
});

const RegisteredConversationPaneHost = forwardRef<
  ConversationPaneHostHandle,
  { registration: ConversationPaneRegistration }
>(function RegisteredConversationPaneHost(props, forwardedRef) {
  const { identity, binding } = props.registration;
  const { paneId, conversationId } = identity;
  const {
    controller,
    transcript,
    composer,
    changedFilesActions,
    checkpointRewind,
    isConversationRunning,
    fileDrop,
    trajectory,
    sendDraft,
  } = binding;
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const scrollFollowRef = useRef<ScrollFollowHandle | null>(null);
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const [composerFloatingOverhang, setComposerFloatingOverhang] = useState(0);
  const [composerCenterOffset, setComposerCenterOffset] = useState(0);
  // Background panes send through their own conversation-scoped pipeline; the
  // handler owns clear-on-send/restore-on-failure for this pane's composer.
  const paneSendHandler = useMemo(
    () =>
      sendDraft
        ? createPaneComposerSendHandler({
            composerRef,
            clearConversationDraft: () => controller.clearDraft(),
            restoreConversationDraft: (draft) => controller.setDraft(draft),
            hasPendingUploads: () => controller.getSnapshot().uploads.length > 0,
            sendDraft,
          })
        : null,
    [controller, sendDraft],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      getComposer: () => composerRef.current,
      getScrollFollow: () => scrollFollowRef.current,
    }),
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on conversationId so primary↔background controller swaps for the same conversation never clear a composer mid-typing.
  useLayoutEffect(() => {
    const composer = composerRef.current;
    return beginPaneComposerDraftSession(composer, {
      getDraft: () => controller.getSnapshot().draft,
      setDraft: (draft) => controller.setDraft(draft),
    });
  }, [conversationId]);

  return (
    <ConversationSurface
      paneId={paneId}
      contentWidth={transcript.contentWidth}
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
        const trajectoryActive = Boolean(trajectory?.active);

        return {
          transcript: trajectoryActive ? (
            trajectory?.renderContent(snapshot)
          ) : (
            <ChangedFilesActionsProvider value={changedFilesActions}>
              <DesktopCheckpointRewindProvider
                conversationId={snapshot.conversationId}
                workspaceRoot={transcript.workspaceRoot}
                project={checkpointRewind.project}
                disabled={checkpointRewind.disabled}
                onRewound={checkpointRewind.onRewound}
              >
                <ChatTranscript
                  {...transcript}
                  conversationId={snapshot.conversationId}
                  followRef={scrollFollowRef}
                  historyItems={historyItems}
                  hasMoreHistory={runtime?.state.transcript.hasMoreBefore ?? false}
                  isSending={isSending}
                  isCompactionRunning={isCompactionRunning}
                  bottomReservePx={composerOverlayHeight}
                  floatingOverhangPx={composerFloatingOverhang}
                  composerCenterOffsetPx={composerCenterOffset}
                />
              </DesktopCheckpointRewindProvider>
            </ChangedFilesActionsProvider>
          ),
          composer: (
            <ChatComposerBar
              {...composer}
              {...(paneSendHandler ? { onSend: paneSendHandler } : {})}
              conversationId={snapshot.conversationId}
              // 轨迹页是只读分析视图：挂起输入区（保持挂载，草稿不丢）。
              hidden={trajectoryActive}
              composerRef={composerRef}
              isSending={isSending}
              pendingUploadedFiles={snapshot.uploads}
              queuedTurns={queuedTurns}
              onStop={controller.stop}
              onManualCompactConfirm={controller.compact}
              manualCompactBlocked={isCompactionRunning}
              onHeightChange={setComposerOverlayHeight}
              onFloatingOverhangChange={setComposerFloatingOverhang}
              onCenterOffsetChange={setComposerCenterOffset}
              taskProgressBar={
                <CurrentTaskProgress
                  key={snapshot.conversationId}
                  historyItems={historyItems}
                  liveTranscriptStore={transcript.liveTranscriptStore}
                  isConversationRunning={isSending || isConversationRunning}
                />
              }
              approvalBar={
                snapshot.approvals.length > 0 ? (
                  <PendingToolApprovalBar
                    conversationId={snapshot.conversationId}
                    approvals={snapshot.approvals}
                  />
                ) : null
              }
              statsBar={
                <ConversationStatsBarHost
                  // 前缀防与同级 taskProgressBar 的 key（裸会话 id）碰撞：React 对同键
                  // 兄弟的 keyed diff 会让旧 fiber 逃过删除，DOM 残留逐次累积。
                  key={`stats-${snapshot.conversationId}`}
                  conversationId={snapshot.conversationId}
                  // 轨迹页挂起输入区时状态栏随之隐藏，无需重复拉取。
                  enabled={!trajectoryActive}
                  contextUsageTokensSource={composer.contextUsageTokensSource}
                  contextWindow={composer.contextWindow}
                  onManualCompactConfirm={controller.compact}
                  manualCompactBlocked={isCompactionRunning}
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
