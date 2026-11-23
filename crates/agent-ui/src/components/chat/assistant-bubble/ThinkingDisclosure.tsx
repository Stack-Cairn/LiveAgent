import { formatElapsedTime } from "@liveagent/ui/components/chat/AssistantWorkTrace";
import { LazyCollapse } from "@liveagent/ui/components/chat/LazyCollapse";
import { useLiveProcessDisclosure } from "@liveagent/ui/components/chat/processDisclosure";
import { Markdown } from "@liveagent/ui/components/Markdown";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { sliceStreamingMarkdownTail } from "@liveagent/ui/lib/chat/streamingRenderPolicy";
import { useStreamingReveal } from "@liveagent/ui/lib/chat/streamingReveal";
import { resolveThinkingDurationMs } from "@liveagent/ui/lib/chat/thinkingDurations";
import { useScrollFollow } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";
import { Brain, ChevronRight } from "../../IconSet";

export type ReasoningSegment = {
  /** Transcript-stable identity used to time the segment across remounts. */
  key: string;
  text: string;
};

/**
 * Total settled reasoning time of a stretch of segments, advancing each
 * segment's clock as a side effect (see resolveThinkingDurationMs; safe to
 * call during render). Null when no segment has a measured duration yet.
 */
export function resolveReasoningDurationMs(
  segments: readonly ReasoningSegment[],
  activeKey: string | null,
): number | null {
  let total: number | null = null;
  for (const segment of segments) {
    const duration = resolveThinkingDurationMs(
      segment.key,
      segment.key === activeKey,
      Date.now(),
      segment.text,
    );
    if (duration !== null) total = (total ?? 0) + duration;
  }
  return total;
}

/**
 * The reasoning of a turn in the processing trace: all segments fold into a
 * single "Thought for Xs" row, so a model that reasons before every tool call
 * does not stack one row per burst. The row never carries a
 * spinner — the turn's single status row says the model is thinking — and its
 * body stays unmounted until the user expands it, so the reasoning text is
 * never dropped from the transcript, only folded. With detailed progress on,
 * a stretch that is still streaming opens to show the reasoning live.
 */
export function ThinkingDisclosure(props: {
  segments: readonly ReasoningSegment[];
  /** Key of the segment currently receiving reasoning deltas, if any. */
  activeKey?: string | null;
  renderMode?: "streaming" | "static";
  readOnly?: boolean;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const {
    segments,
    activeKey = null,
    renderMode = "static",
    readOnly = false,
    workdir,
    onOpenFileLink,
  } = props;
  const { t } = useLocale();
  const active = activeKey !== null && segments.some((segment) => segment.key === activeKey);
  const text = segments.map((segment) => segment.text.trim()).join("\n\n");
  // Quiet view: folded unless the user opens it. Detailed progress: open while
  // it streams, folded once settled — unless the user toggled it, after which
  // disclosure ownership stays with them. With "expand process by default" on,
  // every stretch starts open and stays open after it settles.
  const [open, toggleOpen] = useLiveProcessDisclosure({ live: active });

  // Callback ref → state so the follow engine re-binds whenever LazyCollapse
  // mounts a fresh body (the element identity changes on every reopen).
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null);
  const [scrollContent, setScrollContent] = useState<HTMLDivElement | null>(null);

  // Same reducer engine as the transcript viewport, minus the reattach zone
  // (there is no reserve band inside the scroller). A pure-CSS pin via
  // `flex-direction: column-reverse` was tried first, but WebKit does not keep
  // a reverse scroller anchored at the bottom while content streams in, and a
  // reverse scroller's scrollTop is always <= 0, so the transcript's
  // nested-wheel detection (scrollTop > 0) never let it consume wheel-up and
  // the block read as unscrollable. The ResizeObserver target must be the
  // inner content wrapper: once max-h clamps the scroller its border box stops
  // resizing while scrollHeight keeps growing. Follow only runs while the
  // segment streams; a settled segment reads top-down.
  useScrollFollow({
    viewport: scrollViewport,
    content: scrollContent,
    enabled: active && open,
    config: { reattachZonePx: 0 },
  });

  const durationMs = resolveReasoningDurationMs(segments, activeKey);

  // 流式中只把尾部窗口交给 Markdown：视口 max-h-320px 本来只看得到尾部，
  // 而全文重排是 O(累计思考长度)/帧。落定（active=false）后展开渲染全文。
  const streaming = active && renderMode === "streaming";
  const revealedText = useStreamingReveal(text, streaming);
  const displayText = streaming ? sliceStreamingMarkdownTail(revealedText) : text;
  // The settled total so far: a turn's merged row keeps its "Thought for Xs"
  // while a later segment streams instead of flipping back to the untimed label.
  const durationLabel = durationMs !== null ? formatElapsedTime(durationMs) : "";
  const label = durationLabel
    ? t("chat.thoughtDuration").replace("{duration}", durationLabel)
    : t("chat.thinkingProcess");

  return (
    <div
      className="group/thinking min-w-0 max-w-full"
      data-thinking-disclosure=""
      data-thinking-active={active ? "" : undefined}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("chat.thinkingProcess")}
        className={cn(
          "-mx-1.5 flex w-fit max-w-bleed-0p75rem cursor-pointer select-none items-center gap-1.5",
          "rounded-lg px-1.5 py-1",
          "text-left text-sm font-book text-foreground/60 transition-colors duration-150 hover:bg-foreground/[0.04] hover:text-foreground/75",
        )}
        onClick={toggleOpen}
      >
        <Brain className="size-3 shrink-0 text-foreground/45" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-foreground/40 opacity-0",
            "transition-[opacity,transform] duration-150 ease-out group-hover/thinking:opacity-100 group-focus-within/thinking:opacity-100",
            open ? "rotate-90" : "",
          )}
        />
      </button>

      <LazyCollapse open={open}>
        {() => (
          <div className="-mx-3 overflow-hidden px-3 pb-1 pt-1">
            <div
              ref={setScrollViewport}
              data-thinking-scroll=""
              className="max-h-320px overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]"
            >
              <div ref={setScrollContent} className="border-l border-border/55 pl-3">
                <Markdown
                  content={displayText}
                  className="font-chat thinking-markdown"
                  renderMode={renderMode}
                  readOnly={readOnly}
                  workdir={workdir}
                  onOpenFileLink={onOpenFileLink}
                />
              </div>
            </div>
          </div>
        )}
      </LazyCollapse>
    </div>
  );
}
