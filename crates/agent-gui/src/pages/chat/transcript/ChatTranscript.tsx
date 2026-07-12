import {
  memo,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { ChevronDown, Copy } from "../../../components/icons";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { useLocale } from "../../../i18n";
import { useScrollFollow } from "../hooks/useScrollFollow";
import { BOTTOM_REATTACH_ZONE_PX } from "../utils/scrollFollowCore";
import { ChatEmptyState } from "./ChatEmptyState";
import { TranscriptHistory } from "./TranscriptHistory";
import { TranscriptLiveState } from "./TranscriptLiveState";
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
    copiedMessageKey,
    setCopiedMessageKey,
    onResendFromEdit,
    onOpenSettings,
    onSuggestionSelect,
    suggestionsDisabled = false,
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

  const transcriptContextMenuPosition = transcriptContextMenu
    ? clampTranscriptContextMenuPosition(transcriptContextMenu.x, transcriptContextMenu.y)
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
              <ChatEmptyState
                variant={showNoModelsState ? "no-models" : "start-chat"}
                onOpenSettings={onOpenSettings}
                onSuggestionSelect={onSuggestionSelect}
                suggestionsDisabled={suggestionsDisabled}
              />
            </div>
          ) : null}

          <div className="space-y-6 select-text">
            <TranscriptHistory
              conversationId={conversationId}
              workspaceRoot={workspaceRoot}
              gitClient={gitClient}
              scrollViewport={scrollViewport}
              historyItems={historyItems}
              showUsage={showUsage}
              usageContextWindow={usageContextWindow}
              copiedMessageKey={copiedMessageKey}
              setCopiedMessageKey={setCopiedMessageKey}
              onResendFromEdit={onResendFromEdit}
              isSending={isSending}
            />

            <TranscriptLiveState
              isSending={isSending}
              isAgentMode={isAgentMode}
              showUsage={showUsage}
              usageContextWindow={usageContextWindow}
              liveTranscriptStore={liveTranscriptStore}
              isCompactionRunning={isCompactionRunning}
            />
          </div>

          <div style={{ height: transcriptBottomReservePx }} />
        </div>
      </ScrollArea>
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
      {transcriptContextMenu && transcriptContextMenuPosition
        ? createPortal(
            <div
              ref={transcriptContextMenuRef}
              role="menu"
              className="fixed z-[120] w-max min-w-[9.5rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-[0_20px_60px_-20px_rgba(15,23,42,0.35)]"
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
                  writeTextToClipboard(transcriptContextMenu.selectedText);
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
      {isHistorySwitching ? <HistorySwitchLoadingOverlay /> : null}
    </div>
  );
});
