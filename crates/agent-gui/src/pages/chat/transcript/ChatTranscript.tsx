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
import { createPortal } from "react-dom";

import { ChevronDown, Copy } from "../../../components/icons";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { useLocale } from "../../../i18n";
import { buildFloorEntries } from "../../../lib/chat-floor-nav/floorModel";
import { BOTTOM_REATTACH_ZONE_PX } from "../../../lib/chat-scroll/scrollFollowCore";
import { useScrollFollow } from "../../../lib/chat-scroll/useScrollFollow";
import { useMenuExitPresence } from "../../../lib/shared/menuMotion";
import { cn } from "../../../lib/shared/utils";
import { ChatEmptyState } from "./ChatEmptyState";
import { FloorNavRail } from "./FloorNavRail";
import { RowInteractionProvider, useRowInteractionStore } from "./rowInteraction";
import { TranscriptList, type TranscriptNavHandle } from "./TranscriptList";
import { HistorySwitchLoadingOverlay } from "./TranscriptLoadingStates";
import type { ChatTranscriptProps } from "./transcriptTypes";
import {
  clampTranscriptContextMenuPosition,
  resolveTranscriptSelectionText,
  type TranscriptContextMenuState,
  writeTextToClipboard,
} from "./transcriptUtils";

export type { ChatTranscriptProps } from "./transcriptTypes";

export const ChatTranscript = memo(function ChatTranscript(props: ChatTranscriptProps) {
  const {
    conversationId,
    workspaceRoot,
    gitClient,
    followRef,
    hasModels,
    historyItems,
    isHistorySwitching,
    isSending,
    isAgentMode,
    showUsage,
    usageContextWindow,
    liveTranscriptStore,
    isCompactionRunning,
    bottomReservePx = 0,
    onResendFromEdit,
    onBranchConversation,
    branchPendingMessageId,
    onOpenSettings,
    onSuggestionSelect,
    suggestionsDisabled = false,
    workMode,
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
  // Both elements arrive via callback refs → state so the scroll-follow hook
  // re-binds on element identity change and can never keep listeners on a
  // dead node (the old querySelector retry loop's silent failure mode).
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null);
  const [scrollAreaRoot, setScrollAreaRoot] = useState<HTMLDivElement | null>(null);
  const transcriptRootRef = useRef<HTMLDivElement | null>(null);
  const transcriptContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [transcriptContextMenu, setTranscriptContextMenu] =
    useState<TranscriptContextMenuState | null>(null);

  const closeTranscriptContextMenu = useCallback(() => {
    setTranscriptContextMenu(null);
  }, []);

  const { handle: scrollFollowHandle, following } = useScrollFollow({
    viewport: scrollViewport,
    listenerRoot: scrollAreaRoot,
    trackKeys: true,
    config: { reattachZonePx: BOTTOM_REATTACH_ZONE_PX },
  });

  // 楼层导航：从时间线派生用户消息楼层；当前楼层由 TranscriptList 上报。
  // 不在此处按 conversationId 重置——TranscriptList 按会话重挂载后其挂载
  // effect 会先于本组件的 effect 执行并上报新会话锚点，这里再置 null 会把
  // 刚上报的值清掉且被子组件的去重永久抑制。行 key 含 segmentId，跨会话
  // 不会误匹配，等待子组件上报即可。
  const floors = useMemo(() => buildFloorEntries(historyItems), [historyItems]);
  const [activeFloorKey, setActiveFloorKey] = useState<string | null>(null);
  const transcriptNavRef = useRef<TranscriptNavHandle | null>(null);
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

  // A freshly opened conversation stays behind the loading overlay until its
  // first layout settles (TranscriptList reports convergence), then reveals
  // in one shot — estimate→measure corrections never show as jumps.
  const [settledConversationId, setSettledConversationId] = useState<string | null>(null);
  const handleFirstLayoutSettled = useCallback(() => {
    setSettledConversationId(conversationId);
  }, [conversationId]);
  const isTranscriptSettling =
    shouldReserveTranscriptBottomSpace && settledConversationId !== conversationId;

  useLayoutEffect(() => {
    followRef.current = scrollFollowHandle;
    return () => {
      if (followRef.current === scrollFollowHandle) {
        followRef.current = null;
      }
    };
  }, [followRef, scrollFollowHandle]);

  // Conversation switches always land pinned to the latest message.
  useLayoutEffect(() => {
    scrollFollowHandle.stickToBottom();
  }, [conversationId, scrollFollowHandle]);

  useEffect(() => {
    closeTranscriptContextMenu();
  }, [closeTranscriptContextMenu, conversationId]);

  useEffect(() => {
    if (!transcriptContextMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        closeTranscriptContextMenu();
        return;
      }
      if (transcriptContextMenuRef.current?.contains(target)) {
        return;
      }
      closeTranscriptContextMenu();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeTranscriptContextMenu();
      }
    };

    const handleSelectionChange = () => {
      if (!resolveTranscriptSelectionText(transcriptRootRef.current)) {
        closeTranscriptContextMenu();
      }
    };

    const handleScroll = () => {
      closeTranscriptContextMenu();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    window.addEventListener("blur", handleScroll);
    document.addEventListener("selectionchange", handleSelectionChange);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
      window.removeEventListener("blur", handleScroll);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [closeTranscriptContextMenu, transcriptContextMenu]);

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

  // Closing keeps the last snapshot mounted (inert) while the exit animation
  // plays; only the live snapshot drives the dismiss listeners above.
  const { rendered: renderedContextMenu, isExiting: isContextMenuExiting } =
    useMenuExitPresence(transcriptContextMenu);
  const transcriptContextMenuPosition = renderedContextMenu
    ? clampTranscriptContextMenuPosition(renderedContextMenu.x, renderedContextMenu.y)
    : null;
  const copySelectedTextLabel = locale === "en-US" ? "Copy selected text" : "复制选中文本";
  const jumpToBottomLabel = locale === "en-US" ? "Scroll to bottom" : "回到底部";

  return (
    <div
      ref={transcriptRootRef}
      className="relative min-h-0 flex-1"
      onContextMenu={handleTranscriptContextMenu}
    >
      <ScrollArea ref={setScrollAreaRoot} viewportRef={setScrollViewport} className="h-full">
        <div className="mx-auto w-full max-w-[768px] px-5 py-4">
          {showNoModelsState || showStartChatState ? (
            <div className="flex min-h-[calc(100vh-220px)] flex-col items-center justify-center">
              {/* Keyed per conversation so the hero entrance replays when
                  switching between empty conversations, not just on mount. */}
              <ChatEmptyState
                key={conversationId ?? "empty"}
                variant={showNoModelsState ? "no-models" : "start-chat"}
                onOpenSettings={onOpenSettings}
                onSuggestionSelect={onSuggestionSelect}
                suggestionsDisabled={suggestionsDisabled}
                workMode={workMode}
              />
            </div>
          ) : null}

          <div
            className={`select-text transition-opacity duration-150 ${isTranscriptSettling ? "opacity-0" : "opacity-100"}`}
          >
            <RowInteractionProvider value={rowInteractionStore}>
              {/* Keyed remount per conversation: per-conversation state
                  (row model, entrance registry, virtualizer measurements)
                  initializes fresh, and row keys can never collide across
                  conversations in the virtualizer's itemSizeCache. */}
              <TranscriptList
                key={conversationId}
                conversationId={conversationId}
                historyItems={historyItems}
                liveTranscriptStore={liveTranscriptStore}
                scrollViewport={scrollViewport}
                isViewportFollowing={scrollFollowHandle.isFollowing}
                isSending={isSending}
                isAgentMode={isAgentMode}
                isCompactionRunning={isCompactionRunning}
                showUsage={showUsage}
                usageContextWindow={usageContextWindow}
                workspaceRoot={workspaceRoot}
                gitClient={gitClient}
                navRef={transcriptNavRef}
                onAnchorUserRowChange={setActiveFloorKey}
                onResendFromEdit={onResendFromEdit}
                onBranchConversation={onBranchConversation}
                onFirstLayoutSettled={handleFirstLayoutSettled}
              />
            </RowInteractionProvider>
          </div>

          <div style={{ height: transcriptBottomReservePx }} />
        </div>
      </ScrollArea>
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
          className="chat-jump-to-bottom absolute left-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
          style={{ bottom: Math.ceil(bottomReservePx) + 16 }}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      ) : null}
      {renderedContextMenu && transcriptContextMenuPosition
        ? createPortal(
            <div
              ref={transcriptContextMenuRef}
              role="menu"
              className={cn(
                "editor-context-menu fixed z-[120] w-max min-w-[9.5rem] max-w-[calc(100vw-1.5rem)] select-none overflow-hidden rounded-lg border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-[0_20px_60px_-20px_rgba(15,23,42,0.35)]",
                isContextMenuExiting && "editor-context-menu-exit",
              )}
              style={{
                left: transcriptContextMenuPosition.left,
                top: transcriptContextMenuPosition.top,
              }}
              onContextMenu={(event) => {
                event.preventDefault();
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] text-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  writeTextToClipboard(renderedContextMenu.selectedText);
                  closeTranscriptContextMenu();
                }}
              >
                <Copy className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{copySelectedTextLabel}</span>
              </button>
            </div>,
            document.body,
          )
        : null}
      {isHistorySwitching || isTranscriptSettling ? <HistorySwitchLoadingOverlay /> : null}
    </div>
  );
});
