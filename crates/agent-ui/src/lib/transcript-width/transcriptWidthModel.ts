// Geometry for the resizable transcript column, kept free of React and DOM
// imports: the component owns the CSS variable and the event wiring, this
// module owns the arithmetic. Being a dependency-free leaf also lets both
// frontends' test loaders exercise it directly.

// Persisted preference bounds. A stored width outside these is normalized in.
export const DEFAULT_CHAT_TRANSCRIPT_WIDTH = 768;
export const MIN_CHAT_TRANSCRIPT_WIDTH = 560;
export const MAX_CHAT_TRANSCRIPT_WIDTH = 1200;

// Space kept between the column and the stage edges so the drag handles never
// sit flush against the window frame.
export const TRANSCRIPT_HORIZONTAL_SAFE_SPACE = 64;

// Keyboard steps on the focusable handle; Shift picks the coarse one.
export const TRANSCRIPT_WIDTH_KEY_STEP = 16;
export const TRANSCRIPT_WIDTH_KEY_COARSE_STEP = 64;

// The handles are a pointer affordance: below this stage width the column
// already fills the available space, and a coarse pointer cannot hit a 12px
// target. Mirrors the media query that hides `.transcript-width-controls`, so
// the two gates cannot drift apart.
export const TRANSCRIPT_WIDTH_CONTROLS_HIDDEN_MEDIA_QUERY = "(max-width: 820px), (pointer: coarse)";

export type TranscriptResizeSide = "left" | "right";

// Rounds to whole pixels and clamps to the persisted preference bounds.
export function normalizePreferredWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_CHAT_TRANSCRIPT_WIDTH;
  return Math.min(
    MAX_CHAT_TRANSCRIPT_WIDTH,
    Math.max(MIN_CHAT_TRANSCRIPT_WIDTH, Math.round(width)),
  );
}

// The width actually rendered: the preference, further clamped by how much
// room the stage has right now. Narrowing the window shrinks what is rendered
// and never rewrites the stored preference, so widening restores it.
export function clampWidthToStage(width: number, maxWidth: number): number {
  return Math.min(maxWidth, normalizePreferredWidth(width));
}

// Largest column the stage can host. A missing or non-positive host width
// means the stage has not been measured yet — the first ResizeObserver
// delivery corrects it, so fall back to the upper bound rather than guessing
// from the window, which would also count the sidebar and the right dock.
export function resolveStageMaxWidth(hostWidth: number | null | undefined): number {
  if (hostWidth == null || !Number.isFinite(hostWidth) || hostWidth <= 0) {
    return MAX_CHAT_TRANSCRIPT_WIDTH;
  }
  return Math.max(
    MIN_CHAT_TRANSCRIPT_WIDTH,
    Math.min(MAX_CHAT_TRANSCRIPT_WIDTH, Math.floor(hostWidth - TRANSCRIPT_HORIZONTAL_SAFE_SPACE)),
  );
}

// Handles are only worth showing while the stage can host more than the
// minimum — otherwise every drag would be a no-op.
export function areWidthControlsUsable(maxWidth: number): boolean {
  return maxWidth > MIN_CHAT_TRANSCRIPT_WIDTH;
}

// The one gate that currently hides the handles, checked in this order.
// Rendered as `data-transcript-width-state` on the controls root so a runtime
// look at the DOM names the reason — a loading overlay owns the stage, the
// pointer/viewport media query hides them, or the stage cannot host more than
// the minimum — without instrumenting the component (#749).
export type TranscriptWidthControlsState = "ready" | "suspended" | "media-hidden" | "stage-narrow";

export function resolveTranscriptWidthControlsState(input: {
  suspended: boolean;
  mediaHidden: boolean;
  maxWidth: number;
}): TranscriptWidthControlsState {
  if (input.suspended) return "suspended";
  if (input.mediaHidden) return "media-hidden";
  if (!areWidthControlsUsable(input.maxWidth)) return "stage-narrow";
  return "ready";
}

// Width for a drag of `deltaX` on `side`. The column is centered, so moving
// one edge by d changes the width by 2d — that is what keeps the handle
// under the pointer.
export function resolveDragWidth(
  startWidth: number,
  deltaX: number,
  side: TranscriptResizeSide,
): number {
  return startWidth + (side === "right" ? deltaX * 2 : -deltaX * 2);
}

// Next width for a key press, or null when the key is not a resize key.
// Steps from the *rendered* width rather than the stored preference: while a
// narrow stage clamps a wider preference, stepping from the preference would
// take many presses before anything moved on screen.
export function resolveKeyboardWidth(
  key: string,
  effectiveWidth: number,
  coarseStep: boolean,
): number | null {
  if (key === "Home") return DEFAULT_CHAT_TRANSCRIPT_WIDTH;
  const step = coarseStep ? TRANSCRIPT_WIDTH_KEY_COARSE_STEP : TRANSCRIPT_WIDTH_KEY_STEP;
  if (key === "ArrowLeft") return effectiveWidth - step;
  if (key === "ArrowRight") return effectiveWidth + step;
  return null;
}
