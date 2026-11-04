import { TextQuote } from "@liveagent/ui/components/IconSet";
import { floatingSurfaceClassName } from "@liveagent/ui/components/ui/menu-surface";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  resolveQuoteButtonPosition,
  resolveTranscriptQuoteSelection,
  type TranscriptQuoteSelection as TranscriptQuoteSelectionState,
} from "@liveagent/ui/lib/chat/transcriptQuote";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type TranscriptQuoteSelectionProps = {
  /** Transcript root; selections must start and end inside one quote source under it. */
  rootRef: RefObject<HTMLElement | null>;
  /** Changing this (e.g. the conversation id) drops any open button. */
  scopeKey?: unknown;
  enabled?: boolean;
  onQuote: (text: string) => void;
};

/**
 * Floating "Quote" button for text selected inside a transcript message.
 * Hidden on scroll, resize, Escape, click-away and whenever the selection
 * collapses or leaves the quotable regions.
 */
export function TranscriptQuoteSelection(props: TranscriptQuoteSelectionProps) {
  const { rootRef, scopeKey, enabled = true, onQuote } = props;
  const { t } = useLocale();
  const [state, setState] = useState<TranscriptQuoteSelectionState | null>(null);
  const frameRef = useRef(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const onQuoteRef = useRef(onQuote);
  onQuoteRef.current = onQuote;

  const close = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    setState(null);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey intentionally resets the listener scope (and closes the button) when the transcript switches conversations.
  useEffect(() => {
    close();
    const root = rootRef.current;
    if (!root || !enabled || typeof document === "undefined") return;
    const inspect = () => {
      setState(resolveTranscriptQuoteSelection(root, window.getSelection()));
    };
    const schedule = () => {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(inspect);
    };
    const isButtonTarget = (target: EventTarget | null) =>
      target instanceof Node && Boolean(buttonRef.current?.contains(target));
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      else if (event.shiftKey || event.key === "Shift") schedule();
    };
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) close();
    };
    const onPointerDown = (event: Event) => {
      if (!isButtonTarget(event.target)) close();
    };
    const onScroll = (event: Event) => {
      if (!isButtonTarget(event.target)) close();
    };
    document.addEventListener("mouseup", schedule);
    document.addEventListener("touchend", schedule, { passive: true });
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      cancelAnimationFrame(frameRef.current);
      document.removeEventListener("mouseup", schedule);
      document.removeEventListener("touchend", schedule);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [close, enabled, rootRef, scopeKey]);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (!button || !state) return;
    const box = button.getBoundingClientRect();
    const position = resolveQuoteButtonPosition(
      state.rect,
      { width: box.width, height: box.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    button.style.left = `${Math.round(position.left)}px`;
    button.style.top = `${Math.round(position.top)}px`;
  }, [state]);

  if (!enabled || !state || typeof document === "undefined") return null;
  const label = t("chat.quoteSelection");
  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      data-transcript-quote-button=""
      aria-label={t("chat.quoteSelectionHint")}
      title={t("chat.quoteSelectionHint")}
      className={cn(
        "layer-popover fixed inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium",
        floatingSurfaceClassName,
        "shadow-md transition-colors hover:bg-muted",
      )}
      style={{ left: 0, top: 0 }}
      // Keep the transcript selection alive until the click lands.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const text = state.text;
        window.getSelection()?.removeAllRanges();
        close();
        onQuoteRef.current(text);
      }}
    >
      <TextQuote className="size-3.5 shrink-0" />
      <span>{label}</span>
    </button>,
    document.body,
  );
}
