import { Markdown } from "@liveagent/ui/components/Markdown";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import {
  advanceBoundary,
  createSplitState,
  GUARD_SAMPLE_CHARS,
  type SplitState,
} from "@liveagent/ui/lib/chat/streamingSplit";
import { useRef } from "react";

// A streaming text block hands its whole accumulated text to Streamdown on
// every flush; the remend/lexer passes are O(text), so one long answer costs
// O(N) per frame and O(N²) over the stream. This wrapper freezes completed
// paragraphs into static segments — each parsed once, then reference-stable —
// and keeps only a small live tail in streaming mode, making the per-flush
// markdown cost O(tail) instead of O(total). Boundary rules live in
// lib/chat/streamingSplit.ts (unit-tested).
//
// The text is append-only while streaming; text_end reconciliation may
// rewrite it wholesale, which the sampled guard detects and answers with a
// full reset (one-off O(N), same as today's every-frame cost).
export function StreamingSplitMarkdown(props: {
  content: string;
  className?: string;
  readOnly?: boolean;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const { content, className, readOnly, workdir, onOpenFileLink } = props;
  const stateRef = useRef<SplitState | null>(null);
  if (stateRef.current === null) {
    stateRef.current = createSplitState();
  }
  const state = stateRef.current;

  // The stream is append-only; a shrink or a mismatched sample right before
  // the boundary means the text was rewritten (final reconciliation) — drop
  // the frozen prefix and re-derive from scratch once.
  if (
    state.boundary > content.length ||
    (state.boundary > 0 &&
      content.slice(state.boundary - GUARD_SAMPLE_CHARS, state.boundary) !== state.guard)
  ) {
    stateRef.current = createSplitState();
    advanceBoundary(stateRef.current, content);
  } else {
    advanceBoundary(state, content);
  }
  const { segments, boundary } = stateRef.current;
  const tail = boundary === 0 ? content : content.slice(boundary);

  if (segments.length === 0) {
    return (
      <Markdown
        content={content}
        className={className}
        renderMode="streaming"
        readOnly={readOnly}
        workdir={workdir}
        onOpenFileLink={onOpenFileLink}
      />
    );
  }

  return (
    <div data-streaming-split-markdown="" className="[&>div+div]:mt-2.5">
      {segments.map((segment, index) => (
        <div
          // Frozen segments are append-only: index identity is stable.
          // biome-ignore lint/suspicious/noArrayIndexKey: segments never reorder
          key={index}
          // Off-viewport frozen segments skip layout/paint entirely. The `auto`
          // keyword keeps the browser's last-rendered exact size once a segment
          // has been on screen (it froze at the visible tail), so scrolling back
          // up does not jump; 800px is only the pre-first-render placeholder.
          className="[contain-intrinsic-size:auto_800px] [content-visibility:auto]"
        >
          <Markdown
            content={segment}
            className={className}
            renderMode="static"
            readOnly={readOnly}
            workdir={workdir}
            onOpenFileLink={onOpenFileLink}
          />
        </div>
      ))}
      <Markdown
        content={tail}
        className={className}
        renderMode="streaming"
        readOnly={readOnly}
        workdir={workdir}
        onOpenFileLink={onOpenFileLink}
      />
    </div>
  );
}
