import { useEffect, useReducer, useRef } from "react";

// Model deltas arrive as multi-character tokens, so a reply drawn the moment each
// one lands pops in word by word. The reveal walks a display cursor over the text
// that has already arrived, one character after another, at least this fast…
export const STREAMING_REVEAL_MIN_CHARS_PER_SECOND = 40;
// …and speeds up with the backlog so the cursor never trails the data by much more
// than this: a fast model or a reconnect burst catches up instead of queueing.
export const STREAMING_REVEAL_MAX_LAG_MS = 300;
// A frame that comes late (a busy main thread, a background tab) must not leave
// the cursor stuck behind: the step is computed from the real elapsed time.
const MAX_FRAME_MS = 250;
// Cheap append-only check: a rewrite (final reconciliation) changes the text
// right before the old end; compare only that tail instead of the whole prefix.
const GUARD_SAMPLE_CHARS = 32;

/** Where the cursor stands after `elapsedMs` when `target` characters have arrived. */
export function nextStreamingRevealPosition(
  position: number,
  target: number,
  elapsedMs: number,
): number {
  if (position >= target) return target;
  const backlog = target - position;
  const charsPerSecond = Math.max(
    STREAMING_REVEAL_MIN_CHARS_PER_SECOND,
    (backlog * 1000) / STREAMING_REVEAL_MAX_LAG_MS,
  );
  const step = (charsPerSecond * Math.min(Math.max(elapsedMs, 0), MAX_FRAME_MS)) / 1000;
  return Math.min(target, position + step);
}

/** Cut point for a cursor position; never splits a surrogate pair. */
export function streamingRevealCut(text: string, position: number): number {
  let cut = Math.min(text.length, Math.max(0, Math.floor(position)));
  if (cut > 0 && cut < text.length) {
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut += 1;
  }
  return cut;
}

/** Whether `next` continues `previous` (append-only growth). */
export function isStreamingAppend(previous: string, next: string): boolean {
  if (next.length < previous.length) return false;
  const start = Math.max(0, previous.length - GUARD_SAMPLE_CHARS);
  return next.startsWith(previous.slice(start), start);
}

function prefersReducedMotion(): boolean {
  return (
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type RevealState = {
  text: string;
  position: number;
  /** Pending frame of the reveal loop, or null while the loop is not running. */
  frame: number | null;
  /** Timestamp of the previous tick. */
  last: number;
};

/**
 * The part of a streaming text to draw now. Text present when the reveal starts
 * (a mounted history row, a reopened running conversation) shows at once; only
 * what arrives afterwards is typed out. Disabled — the turn settled, the text was
 * rewritten, or the user asked for reduced motion — it returns the full text.
 */
export function useStreamingReveal(text: string, enabled: boolean): string {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const stateRef = useRef<RevealState | null>(null);
  const active = enabled && !prefersReducedMotion();

  const previous = stateRef.current;
  if (!active || previous === null || !isStreamingAppend(previous.text, text)) {
    // A replaced state also retires its loop: the pending tick sees it is stale.
    stateRef.current = { text, position: text.length, frame: null, last: 0 };
  } else {
    previous.text = text;
  }
  const state = stateRef.current as RevealState;
  const cut = streamingRevealCut(text, state.position);
  const behind = cut < text.length;

  // Runs after every commit, not on a dependency change: the loop stops once the
  // cursor catches up, and new text committed in that same frame must restart it.
  useEffect(() => {
    const current = stateRef.current;
    if (!active || !current || current.frame !== null) return;
    if (streamingRevealCut(current.text, current.position) >= current.text.length) return;
    if (typeof globalThis.requestAnimationFrame !== "function") return;
    const tick = (now: number) => {
      if (stateRef.current !== current) return;
      current.frame = null;
      const before = streamingRevealCut(current.text, current.position);
      current.position = nextStreamingRevealPosition(
        current.position,
        current.text.length,
        now - current.last,
      );
      current.last = now;
      if (current.position < current.text.length) current.frame = requestAnimationFrame(tick);
      // Re-render only when another character becomes visible.
      if (streamingRevealCut(current.text, current.position) !== before) rerender();
    };
    current.last = performance.now();
    current.frame = requestAnimationFrame(tick);
  });

  useEffect(
    () => () => {
      const current = stateRef.current;
      if (current?.frame != null) cancelAnimationFrame(current.frame);
      if (current) current.frame = null;
    },
    [],
  );

  return behind ? text.slice(0, cut) : text;
}
