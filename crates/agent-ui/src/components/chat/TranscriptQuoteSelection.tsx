import { ComposerCommentEditor } from "@liveagent/ui/components/chat/ComposerCommentEditor";
import { MessageSquareText, TextQuote } from "@liveagent/ui/components/IconSet";
import { floatingSurfaceClassName } from "@liveagent/ui/components/ui/menu-surface";
import { Popover, PopoverContent } from "@liveagent/ui/components/ui/popover";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ComposerCommentInput } from "@liveagent/ui/lib/chat/composerComments";
import {
  resolveQuoteButtonPosition,
  resolveTranscriptQuoteSelection,
  type TranscriptQuoteSelection as TranscriptQuoteSelectionState,
} from "@liveagent/ui/lib/chat/transcriptQuote";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type TranscriptQuoteSelectionProps = {
  /** Transcript root; selections must start and end inside one quote source under it. */
  rootRef: RefObject<HTMLElement | null>;
  /** Changing this (e.g. the conversation id) drops any open button. */
  scopeKey?: unknown;
  enabled?: boolean;
  onQuote: (text: string) => void;
  /**
   * Adds a pending composer comment on the selection. When set, a "Comment"
   * action sits next to "Quote" and opens a comment form anchored on the
   * selection. Return false when the composer rejected the comment (it then
   * stays open).
   */
  onComment?: (comment: ComposerCommentInput) => boolean | undefined;
};

/** Build the comment payload for a resolved transcript selection. */
export function transcriptSelectionToComment(
  selection: Pick<TranscriptQuoteSelectionState, "text" | "source" | "code">,
  comment: string,
): ComposerCommentInput {
  return {
    quote: selection.text,
    comment,
    ...(selection.code ? { code: true } : {}),
    source: {
      kind: selection.source,
      ...(selection.code?.language ? { language: selection.code.language } : {}),
    },
  };
}

const actionButtonClassName = cn(
  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
  "outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
);

/**
 * Floating "Quote" / "Comment" actions for text selected inside a transcript
 * message. Hidden on scroll, resize, Escape, click-away and whenever the
 * selection collapses or leaves the quotable regions. Once "Comment" is
 * chosen the selection may collapse (focus moves into the form); the form
 * stays until it is submitted, cancelled or dismissed.
 */
export function TranscriptQuoteSelection(props: TranscriptQuoteSelectionProps) {
  const { rootRef, scopeKey, enabled = true, onQuote, onComment } = props;
  const { t } = useLocale();
  const [state, setState] = useState<TranscriptQuoteSelectionState | null>(null);
  const [commenting, setCommenting] = useState<TranscriptQuoteSelectionState | null>(null);
  const commentingRef = useRef(false);
  commentingRef.current = commenting !== null;
  const frameRef = useRef(0);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const onQuoteRef = useRef(onQuote);
  onQuoteRef.current = onQuote;
  const onCommentRef = useRef(onComment);
  onCommentRef.current = onComment;

  const close = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    setState(null);
  }, []);

  const closeAll = useCallback(() => {
    close();
    setCommenting(null);
  }, [close]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey intentionally resets the listener scope (and closes the button) when the transcript switches conversations.
  useEffect(() => {
    closeAll();
    const root = rootRef.current;
    if (!root || !enabled || typeof document === "undefined") return;
    const inspect = () => {
      if (commentingRef.current) return;
      setState(resolveTranscriptQuoteSelection(root, window.getSelection()));
    };
    const schedule = () => {
      if (commentingRef.current) return;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(inspect);
    };
    const isActionsTarget = (target: EventTarget | null) =>
      target instanceof Node && Boolean(actionsRef.current?.contains(target));
    const onKeyUp = (event: KeyboardEvent) => {
      if (commentingRef.current) return;
      if (event.key === "Escape") close();
      else if (event.shiftKey || event.key === "Shift") schedule();
    };
    const onSelectionChange = () => {
      if (commentingRef.current) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) close();
    };
    const onPointerDown = (event: Event) => {
      if (!commentingRef.current && !isActionsTarget(event.target)) close();
    };
    const onScroll = (event: Event) => {
      if (!commentingRef.current && !isActionsTarget(event.target)) close();
    };
    const onViewportChange = () => {
      if (!commentingRef.current) close();
    };
    document.addEventListener("mouseup", schedule);
    document.addEventListener("touchend", schedule, { passive: true });
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("blur", onViewportChange);
    return () => {
      cancelAnimationFrame(frameRef.current);
      document.removeEventListener("mouseup", schedule);
      document.removeEventListener("touchend", schedule);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("blur", onViewportChange);
    };
  }, [close, closeAll, enabled, rootRef, scopeKey]);

  useLayoutEffect(() => {
    const actions = actionsRef.current;
    if (!actions || !state) return;
    const box = actions.getBoundingClientRect();
    const position = resolveQuoteButtonPosition(
      state.rect,
      { width: box.width, height: box.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    actions.style.left = `${Math.round(position.left)}px`;
    actions.style.top = `${Math.round(position.top)}px`;
  }, [state]);

  // Virtual anchor: the selection rectangle captured when "Comment" was chosen.
  const commentAnchor = useMemo(() => {
    if (!commenting) return null;
    const { rect } = commenting;
    return {
      getBoundingClientRect: () =>
        typeof DOMRect === "function"
          ? new DOMRect(rect.left, rect.top, rect.width, rect.height)
          : ({ ...rect, x: rect.left, y: rect.top, toJSON: () => rect } as DOMRect),
    };
  }, [commenting]);

  if (!enabled || typeof document === "undefined") return null;

  if (commenting && commentAnchor) {
    const sourceLabel = commenting.code
      ? t("chat.comment.source.codeBlock")
      : commenting.source === "user"
        ? t("chat.comment.source.user")
        : t("chat.comment.source.assistant");
    return (
      <Popover
        open
        onOpenChange={(open) => {
          if (!open) setCommenting(null);
        }}
      >
        <PopoverContent
          anchor={commentAnchor}
          positionMethod="fixed"
          side="bottom"
          align="center"
          sideOffset={8}
          data-transcript-comment-popover=""
          aria-label={t("chat.comment.dialogTitle")}
          className="w-80 max-w-[calc(100vw-2rem)] p-3"
        >
          <ComposerCommentEditor
            quote={commenting.text}
            code={Boolean(commenting.code)}
            sourceLabel={sourceLabel}
            submitLabel={t("chat.comment.add")}
            onSubmit={(comment) => {
              const accepted = onCommentRef.current?.(
                transcriptSelectionToComment(commenting, comment),
              );
              if (accepted !== false) setCommenting(null);
            }}
            onCancel={() => setCommenting(null)}
          />
        </PopoverContent>
      </Popover>
    );
  }

  if (!state) return null;
  const quoteButton = (
    <button
      type="button"
      data-transcript-quote-button=""
      aria-label={t("chat.quoteSelectionHint")}
      title={t("chat.quoteSelectionHint")}
      className={actionButtonClassName}
      onClick={() => {
        const text = state.text;
        window.getSelection()?.removeAllRanges();
        close();
        onQuoteRef.current(text);
      }}
    >
      <TextQuote className="size-3.5 shrink-0" />
      <span>{t("chat.quoteSelection")}</span>
    </button>
  );
  return createPortal(
    // biome-ignore lint/a11y/useSemanticElements: a floating cluster of two action buttons, not a set of form fields.
    <div
      ref={actionsRef}
      data-transcript-selection-actions=""
      role="group"
      aria-label={t("chat.selectionActions")}
      className={cn(
        "layer-popover fixed inline-flex items-center gap-0.5 p-0.5",
        floatingSurfaceClassName,
        "shadow-md",
      )}
      style={{ left: 0, top: 0 }}
      // Keep the transcript selection alive until the click lands.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {quoteButton}
      {onComment ? (
        <button
          type="button"
          data-transcript-comment-button=""
          aria-label={t("chat.comment.actionHint")}
          title={t("chat.comment.actionHint")}
          className={actionButtonClassName}
          onClick={() => {
            const snapshot = state;
            close();
            setCommenting(snapshot);
          }}
        >
          <MessageSquareText className="size-3.5 shrink-0" />
          <span>{t("chat.comment.action")}</span>
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
