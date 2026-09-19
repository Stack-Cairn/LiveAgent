import { ChatEmptyState } from "@liveagent/ui/components/chat/ChatEmptyState";
import { ChevronDown, Copy } from "@liveagent/ui/components/IconSet";
import { ContextMenuItem, ContextMenuPopup } from "@liveagent/ui/components/ui/context-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { buildFloorEntries } from "@liveagent/ui/lib/chat-floor-nav/floorModel";
import { BOTTOM_REATTACH_ZONE_PX } from "@liveagent/ui/lib/chat-scroll/scrollFollowCore";
import { useScrollFollow } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { FloorNavRail } from "@liveagent/ui/pages/chat/transcript/FloorNavRail";
import { TranscriptWidthControls } from "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RowInteractionProvider, useRowInteractionStore } from "./rowInteraction";
import { TranscriptList, type TranscriptNavHandle } from "./TranscriptList";
import { HistorySwitchLoadingOverlay } from "./TranscriptLoadingStates";
import type { ChatTranscriptProps } from "./transcriptTypes";
import {
  resolveTranscriptSelectionText,
  type TranscriptContextMenuState,
  writeTextToClipboard,
} from "./transcriptUtils";

export type { ChatTranscriptProps } from "./transcriptTypes";

// Short and medium conversations paint directly. Only large transcripts keep
// the convergence gate that prevents a visible estimate-to-measure jump.
const DEFER_REVEAL_HISTORY_ITEM_THRESHOLD = 120;

export const ChatTranscript = memo(function ChatTranscript(props: ChatTranscriptProps) {
  const {
    conversationId,
    workspaceRoot,
    gitClient,
    followRef,
    hasModels,
    historyItems,
    hasMoreHistory,
    onLoadEarlierHistory,
    isHistorySwitching,
    isSending,
    showUsage,
    usageContextWindow,
    liveTranscriptStore,
    isCompactionRunning,
    bottomReservePx = 0,
    floatingOverhangPx = 0,
    composerCenterOffsetPx = 0,
    contentWidth,
    onContentWidthChange,
    onOpenFileLink,
    onResendFromEdit,
    onBranchConversation,
    branchPendingMessageId,
    onOpenSettings,
    onSuggestionSelect,
  } = props;
  const { locale } = useLocale();
  const showNoModelsState = !hasModels;
  const showStartChatState = hasModels && historyItems.length === 0 && !isSending;
  const shouldReserveTranscriptBottomSpace = !(showNoModelsState || showStartChatState);
  // The reserve minimum doubles as the scroll-follow reattach zone: stopping
  // anywhere inside the reserve looks like "the bottom" to the user, so the
  // zone must stay >= this minimum for scroll-back-to-bottom to re-stick.
  const transcriptBottomReservePx = shouldReserveTranscriptBottomSpace
    ? Math.max(BOTTOM_REATTACH_ZONE_PX, Math.ceil(bottomReservePx) + 12)
    : 0;
  // The native viewport arrives via a callback ref → state so scroll-follow
  // and the virtualizer re-bind on identity changes. Keeping the transcript
  // off Base UI's custom ScrollArea also removes its per-scroll geometry,
  // computed-style and inherited CSS-variable work from WebKit's hot path.
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null);
  const transcriptRootRef = useRef<HTMLDivElement | null>(null);

  const [transcriptContextMenu, setTranscriptContextMenu] =
    useState<TranscriptContextMenuState | null>(null);

  const closeTranscriptContextMenu = useCallback(() => {
    setTranscriptContextMenu(null);
  }, []);

  const { handle: scrollFollowHandle, following } = useScrollFollow({
    viewport: scrollViewport,
    listenerRoot: scrollViewport,
    trackKeys: true,
    config: { reattachZonePx: BOTTOM_REATTACH_ZONE_PX },
  });

  // Earlier-history paging lives in TranscriptList next to the virtualizer:
  // a prepended page is anchored by the virtualizer's origin (the row under
  // the viewport keeps its position with no scrollTop write from here), and
  // the "near the top" trigger has to read the virtualizer's settled offset
  // rather than the parked DOM scrollTop.

  // 楼层导航：从时间线派生用户消息楼层；当前楼层由 TranscriptList 上报。
  // 不在此处按 conversationId 重置——TranscriptList 按会话重挂载后其挂载
  // effect 会先于本组件的 effect 执行并上报新会话锚点，这里再置 null 会把
  // 刚上报的值清掉且被子组件的去重永久抑制。行 key 含 segmentId，跨会话
  // 不会误匹配，等待子组件上报即可。
  const floors = useMemo(() => buildFloorEntries(historyItems), [historyItems]);
  const [activeFloorKey, setActiveFloorKey] = useState<string | null>(null);
  const transcriptNavRef = useRef<TranscriptNavHandle | null>(null);
  const saveReadingPositionRef = useRef<(() => void) | null>(null);
  const handleFloorJump = useCallback(
    (rowKey: string) => {
      // 粘底跟随激活时程序化滚动会被立即拽回底部——先按「跳入历史」语义解除
      // 跟随，再执行跳转。
      scrollFollowHandle.breakFollow();
      transcriptNavRef.current?.scrollToRowKey(rowKey);
    },
    [scrollFollowHandle],
  );

  // Run-scoped state reaches row action bars through this store instead of
  // row props, so settled rows stay memo-stable across run start/settle.
  const rowInteractionStore = useRowInteractionStore({
    isSending,
    branchPendingMessageId: branchPendingMessageId ?? null,
  });

  // Large conversations stay behind the loading overlay until their first
  // layout settles. Ordinary conversations paint immediately instead of
  // paying a second loading-state transition after history is already ready.
  const shouldDeferTranscriptReveal =
    !isSending && historyItems.length >= DEFER_REVEAL_HISTORY_ITEM_THRESHOLD;
  const [settledConversationId, setSettledConversationId] = useState<string | null>(null);
  const handleFirstLayoutSettled = useCallback(() => {
    setSettledConversationId(conversationId);
  }, [conversationId]);
  const isTranscriptSettling =
    shouldReserveTranscriptBottomSpace &&
    shouldDeferTranscriptReveal &&
    settledConversationId !== conversationId;
  // Loading overlays own the stage while mounted. The width handles suspend
  // behind them (an opaque skeleton leaves nothing to grab, and a focusable
  // separator must not hide under a blocking layer) and come back in the very
  // commit the overlay leaves, re-measured against the pane as it is then —
  // no unrelated layout change is needed to wake them (#749).
  const isTranscriptBusy = isHistorySwitching || isTranscriptSettling;

  useLayoutEffect(() => {
    const handle = {
      ...scrollFollowHandle,
      saveReadingPosition: () => saveReadingPositionRef.current?.(),
    };
    followRef.current = handle;
    return () => {
      if (followRef.current === handle) {
        followRef.current = null;
      }
    };
  }, [followRef, scrollFollowHandle]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId intentionally closes any menu left open by the previous transcript.
  useEffect(() => {
    closeTranscriptContextMenu();
  }, [closeTranscriptContextMenu, conversationId]);

  const handleTranscriptContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const selectedText = resolveTranscriptSelectionText(transcriptRootRef.current);
      if (!selectedText) {
        closeTranscriptContextMenu();
        return;
      }
      setTranscriptContextMenu({
        x: event.clientX,
        y: event.clientY,
        selectedText,
      });
    },
    [closeTranscriptContextMenu],
  );

  const copySelectedTextLabel = locale === "en-US" ? "Copy selected text" : "复制选中文本";
  const jumpToBottomLabel = locale === "en-US" ? "Scroll to bottom" : "回到底部";
  const resizeTranscriptLabel =
    locale === "en-US" ? "Resize conversation content" : "调整对话正文宽度";
  const resetTranscriptWidthLabel =
    locale === "en-US" ? "Double-click to reset" : "双击恢复默认宽度";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The transcript surface exposes a pointer context menu; transcript content and menu items retain their own keyboard semantics.
    <div
      ref={transcriptRootRef}
      // `@container`: transcript overlays (FloorNavRail 等) size against the
      // pane, not the viewport — a narrow pane in a wide split window must
      // degrade like a narrow window.
      className="@container relative min-h-0 flex-1"
      onContextMenu={handleTranscriptContextMenu}
    >
      <div
        ref={setScrollViewport}
        data-scroll-viewport
        className="chat-transcript-scrollbar mx-1.5 h-full overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
      >
        <div
          className={cn(
            // The assistant rows no longer reserve a 40px avatar column, so the
            // transcript column gives that width back instead of widening the
            // reading measure. Keeps assistant text at its original width and
            // aligned with the composer, which is tuned off the same variable.
            "mx-auto w-full max-w-transcript-web px-5 py-4 [overflow-anchor:none]",
            // Empty states center against the scroll viewport (the pane), not
            // the window: a viewport-height min-height overflows half-height
            // panes in vertical splits and shifts the hero content.
            (showNoModelsState || showStartChatState) && "flex min-h-full flex-col",
          )}
        >
          {showNoModelsState || showStartChatState ? (
            <div className="flex flex-1 flex-col items-center justify-center pb-24">
              {/* Keyed per conversation so the hero entrance replays when
                  switching between empty conversations, not just on mount. */}
              <ChatEmptyState
                key={conversationId ?? "empty"}
                variant={showNoModelsState ? "no-models" : "start-chat"}
                onOpenSettings={onOpenSettings}
                onSuggestionSelect={onSuggestionSelect}
              />
            </div>
          ) : null}

          <div className={cn("select-text", isTranscriptSettling && "invisible")}>
            <RowInteractionProvider value={rowInteractionStore}>
              {/* Keyed remount per conversation: per-conversation state
                  (row model, entrance registry, virtualizer measurements)
                  initializes fresh, and row keys can never collide across
                  conversations in the virtualizer's itemSizeCache. */}
              <TranscriptList
                key={conversationId}
                conversationId={conversationId}
                historyItems={historyItems}
                hasMoreHistory={hasMoreHistory}
                onLoadEarlierHistory={onLoadEarlierHistory}
                isHistorySwitching={isHistorySwitching}
                liveTranscriptStore={liveTranscriptStore}
                scrollViewport={scrollViewport}
                layoutWidth={contentWidth}
                isViewportFollowing={scrollFollowHandle.isFollowing}
                viewportFollowing={following}
                onRestoreFollowing={scrollFollowHandle.restoreFollowing}
                isSending={isSending}
                isCompactionRunning={isCompactionRunning}
                showUsage={showUsage}
                usageContextWindow={usageContextWindow}
                workspaceRoot={workspaceRoot}
                onOpenFileLink={onOpenFileLink}
                gitClient={gitClient}
                navRef={transcriptNavRef}
                saveReadingPositionRef={saveReadingPositionRef}
                onAnchorUserRowChange={setActiveFloorKey}
                onResendFromEdit={onResendFromEdit}
                onBranchConversation={onBranchConversation}
                onFirstLayoutSettled={
                  shouldDeferTranscriptReveal ? handleFirstLayoutSettled : undefined
                }
              />
            </RowInteractionProvider>
          </div>

          <div style={{ height: transcriptBottomReservePx }} />
        </div>
      </div>
      <TranscriptWidthControls
        hostRef={transcriptRootRef}
        width={contentWidth}
        onWidthChange={onContentWidthChange}
        resizeLabel={resizeTranscriptLabel}
        resetLabel={resetTranscriptWidthLabel}
        suspended={isTranscriptBusy}
      />
      {!showNoModelsState && !showStartChatState && !isTranscriptSettling ? (
        <FloorNavRail
          conversationId={conversationId}
          floors={floors}
          activeRowKey={activeFloorKey}
          bottomOffset={`${Math.ceil(transcriptBottomReservePx) + 8}px`}
          scrollViewport={scrollViewport}
          onJump={handleFloorJump}
        />
      ) : null}
      {!following ? (
        <button
          type="button"
          aria-label={jumpToBottomLabel}
          title={jumpToBottomLabel}
          onClick={() => scrollFollowHandle.jumpToBottom()}
          className={cn(
            "chat-jump-to-bottom absolute z-10 flex size-8 -translate-x-1/2 items-center justify-center",
            "rounded-full border border-border/55 bg-background/45 text-muted-foreground shadow-[inset_0_var(--spacing-1px)_0_color-mix(in_oklab,_var(--color-white)_45%,_transparent),0_var(--spacing-8px)_var(--spacing-24px)_var(--spacing-minus-14px)_color-mix(in_oklab,_var(--color-black)_35%,_transparent)] backdrop-blur-18px backdrop-saturate-[180%]",
            "transition-colors hover:bg-background/65 hover:text-foreground dark:border-white/[0.12] dark:bg-white/[0.06] dark:shadow-[inset_0_var(--spacing-1px)_0_color-mix(in_oklab,_var(--color-white)_8%,_transparent),0_var(--spacing-8px)_var(--spacing-24px)_var(--spacing-minus-14px)_color-mix(in_oklab,_var(--color-black)_60%,_transparent)] dark:hover:bg-white/[0.11]",
          )}
          // Centered on the composer card (not the pane) and stacked above
          // the task-progress pill / queue panel: the composer layer paints
          // over the transcript, so any overlap would hide the button.
          style={{
            left: `calc(50% + ${Math.round(composerCenterOffsetPx)}px)`,
            bottom: Math.ceil(bottomReservePx) + Math.ceil(floatingOverhangPx) + 16,
          }}
        >
          <ChevronDown className="size-4" />
        </button>
      ) : null}
      {typeof document !== "undefined" && transcriptContextMenu ? (
        <ContextMenuPopup
          point={transcriptContextMenu}
          onClose={closeTranscriptContextMenu}
          className="min-w-38"
        >
          {transcriptContextMenu ? (
            <ContextMenuItem
              onClick={() => {
                writeTextToClipboard(transcriptContextMenu.selectedText);
                closeTranscriptContextMenu();
              }}
            >
              <Copy className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{copySelectedTextLabel}</span>
            </ContextMenuItem>
          ) : null}
        </ContextMenuPopup>
      ) : null}
      {isTranscriptBusy ? <HistorySwitchLoadingOverlay /> : null}
    </div>
  );
});
