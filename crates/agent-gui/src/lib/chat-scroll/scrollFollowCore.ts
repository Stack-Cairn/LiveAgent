// Scroll-follow core for bottom-pinned live views: the chat transcript
// viewport and the thinking-block <pre> both run on this reducer via
// useScrollFollow.
//
// This replaces the 2026-07 scrollFollowPolicy after four rounds of
// device-specific patches. Instead of refining the "was that scroll the user
// or us?" classification, the architecture removes the question:
//
// - DETACH happens only on explicit user input (wheel-up, touch drag, history
//   keys) or on away-movement during a real pointer drag — scrollbar thumb
//   drags and selection auto-scroll are the only user paths away from the
//   bottom that arrive solely as scroll events. Windows WebView2's compositor
//   keeps emitting scroll frames from a stale wheel smooth-scroll trajectory
//   after a programmatic pin (the abort lands with the next main-thread
//   commit); those frames carry no input and no drag, so they can never
//   detach.
// - ATTACH is position-driven and intent-gated: landing at the physical clamp
//   attaches while following (our own pin write echoing back) or inside an
//   active gesture latch; a gesture-latched downward arrival inside the
//   reattach zone attaches; a pointer released inside the zone after downward
//   movement attaches. Content shrinking under a detached reader (a reply
//   settling out of the row list, a collapsing block) also clamps scrollTop
//   to the bottom with no input — that arrival carries no latch, so it can
//   never re-engage follow and the next growth cannot yank the reader down.
//   The gesture latch is the only timing heuristic left and it gates attach
//   only — a false positive re-pins, it can never tear follow down.
// - While following, a scroll event that leaves a gap open is corrected by
//   re-pinning rather than classified.
// - ResizeObserver deliveries (contentGrowth) never change follow state; they
//   pin while following and keep direction bookkeeping honest otherwise.
//   Content growth widens the gap with no user input — treating it as
//   "scrolling away" tore down freshly re-engaged follows on stream flushes.
//
// Pure and DOM-free: useScrollFollow gathers the per-event facts and applies
// `pin` effects. Every behavior is unit-tested in
// test/chat/scroll-follow-core.test.mjs.

// Hard "at bottom" tolerance. Fractional devicePixelRatio displays (Windows
// 125%/150% scaling, zoomed webviews) clamp scrollTop 1-3px short of
// scrollHeight - clientHeight, and scrollHeight/clientHeight round
// independently of the fractional scrollTop — a 2px threshold sits exactly on
// that boundary and can never re-attach at the physical clamp.
export const BOTTOM_ATTACH_THRESHOLD_PX = 8;

// ChatTranscript reserves max(192, composer height + 12)px of blank space
// below the last message so content clears the floating composer. Users
// naturally stop "at the bottom" inside that band, dozens of px short of the
// physical clamp, so a clamp-only check could never re-engage them. Any
// gesture-latched downward arrival inside this zone counts as "scrolled back
// to the bottom". ChatTranscript imports this constant to keep the reserve
// band and the zone equal.
export const BOTTOM_REATTACH_ZONE_PX = 192;

// Gap wiggle inside this slop is layout noise (virtualizer measurement
// compensation, DPR rounding), not scroll direction.
export const DIRECTION_SLOP_PX = 1;

// A pointer press only becomes a drag after moving this far. Requiring a real
// drag for the scroll-driven detach means a static click plus a layout echo
// can never read as "dragged away from the bottom".
export const POINTER_DRAG_SLOP_PX = 4;

// Attach-side gesture latch. Refreshed by wheel/touch/key input and extended
// by chained downward scroll events (touchscreen momentum carries no input
// events); it can extend an active latch but never create one.
export const GESTURE_LATCH_MS = 500;

export type FollowConfig = {
  attachThresholdPx: number;
  reattachZonePx: number;
  directionSlopPx: number;
  latchMs: number;
};

export const DEFAULT_FOLLOW_CONFIG: FollowConfig = {
  attachThresholdPx: BOTTOM_ATTACH_THRESHOLD_PX,
  reattachZonePx: BOTTOM_REATTACH_ZONE_PX,
  directionSlopPx: DIRECTION_SLOP_PX,
  latchMs: GESTURE_LATCH_MS,
};

export type FollowState = {
  following: boolean;
  // Physical press anywhere on the listener root (content, scrollbar thumb).
  pointerHeld: boolean;
  // The press moved past POINTER_DRAG_SLOP_PX (promoted by the hook).
  pointerDragging: boolean;
  // Scroll direction observed during the current press; release re-engages
  // only after downward movement.
  dragTowardBottom: boolean | null;
  // Gesture-latch deadline (epoch ms); attach-side only.
  latchUntil: number;
  // Last observed bottom gap, for direction detection.
  lastGap: number;
};

export function createFollowState(): FollowState {
  return {
    following: true,
    pointerHeld: false,
    pointerDragging: false,
    dragTowardBottom: null,
    latchUntil: 0,
    lastGap: 0,
  };
}

export type FollowEvent =
  | {
      type: "wheel";
      deltaX: number;
      deltaY: number;
      gap: number;
      hasOverflow: boolean;
      nestedCanConsume: boolean;
      now: number;
    }
  | {
      type: "touchMove";
      // true: finger moved down (view scrolls up, away from the bottom);
      // null: no previous sample to compare against.
      fingerMovedDown: boolean | null;
      gap: number;
      hasOverflow: boolean;
      now: number;
    }
  | { type: "scroll"; gap: number; now: number }
  | { type: "pointerDown" }
  | { type: "pointerDragStart" }
  | { type: "pointerRelease"; gap: number }
  | { type: "historyKey"; hasOverflow: boolean; now: number }
  | { type: "followKey"; now: number }
  | { type: "contentGrowth"; gap: number }
  | { type: "forceFollow" };

export type FollowStep = {
  state: FollowState;
  // Effect for the hook: write scrollTop = scrollHeight now.
  pin: boolean;
};

export function isAtBottom(gap: number, config: FollowConfig = DEFAULT_FOLLOW_CONFIG) {
  return gap <= config.attachThresholdPx;
}

// Trackpad horizontal pans (wide code blocks, tables) carry a few px of
// vertical drift per event; only a dominantly-vertical gesture may change
// follow state.
export function isDominantVerticalWheel(deltaX: number, deltaY: number) {
  return Math.abs(deltaY) > Math.abs(deltaX);
}

export function reduceFollowEvent(
  state: FollowState,
  event: FollowEvent,
  config: FollowConfig = DEFAULT_FOLLOW_CONFIG,
): FollowStep {
  switch (event.type) {
    case "wheel": {
      const next = { ...state, latchUntil: event.now + config.latchMs };
      if (!isDominantVerticalWheel(event.deltaX, event.deltaY)) {
        return { state: next, pin: false };
      }
      if (event.deltaY < 0) {
        // Wheel-up consumed by a nested scroller (thinking <pre>, tool output)
        // never moves the viewport; detaching there would strand follow "off"
        // while visually pinned at the bottom.
        if (event.hasOverflow && !event.nestedCanConsume) {
          next.following = false;
        }
        return { state: next, pin: false };
      }
      // Wheeling down while already clamped at the bottom produces no scroll
      // event (scrollTop can't change), so a detached-at-bottom state must
      // re-engage here explicitly.
      if (!state.following && isAtBottom(event.gap, config)) {
        next.following = true;
        return { state: next, pin: true };
      }
      return { state: next, pin: false };
    }

    case "touchMove": {
      const next = { ...state, latchUntil: event.now + config.latchMs };
      // Any touch drag off the clamp detaches; downward re-engagement flows
      // through the scroll/zone/release paths.
      if (
        event.hasOverflow &&
        (event.fingerMovedDown !== false || event.gap > config.attachThresholdPx)
      ) {
        next.following = false;
      }
      return { state: next, pin: false };
    }

    case "scroll": {
      const { gap, now } = event;
      const previousGap = state.lastGap;
      const next = { ...state, lastGap: gap };

      if (isAtBottom(gap, config)) {
        // At the physical clamp. Counts as downward movement for the
        // pointer-release re-check, but attaching needs evidence of intent:
        // our own pin write echoing back (still following) or an arrival
        // inside an active gesture latch. Content shrinking under a detached
        // reader (a reply settling out of the row list, a collapsing block)
        // also clamps scrollTop here with no input — attaching on that would
        // let the next growth yank the reader to the bottom.
        next.dragTowardBottom = true;
        if (state.following || now <= state.latchUntil) {
          next.following = true;
        }
        return { state: next, pin: false };
      }

      const movedAway = gap > previousGap + config.directionSlopPx;
      const movedTowardBottom = gap < previousGap - config.directionSlopPx;

      if (state.pointerDragging && movedAway) {
        // The only scroll-driven detach: thumb drags and selection
        // auto-scroll arrive solely as scroll events, gated on a real drag.
        next.following = false;
        next.dragTowardBottom = false;
        return { state: next, pin: false };
      }

      if (state.following) {
        // Corrector: anything that opened a gap without detaching above
        // (WebView2 stale smooth-scroll frames, focus scrolls) is undone by
        // re-pinning. Self-terminating — the pin write echoes back into the
        // attach branch.
        return { state: next, pin: true };
      }

      if (movedTowardBottom) {
        next.dragTowardBottom = true;
        if (now <= state.latchUntil) {
          next.latchUntil = now + config.latchMs;
          // Attaching mid-press would pin the viewport out from under a thumb
          // drag or selection; the release handler re-evaluates.
          if (!state.pointerHeld && gap <= config.reattachZonePx) {
            next.following = true;
            return { state: next, pin: true };
          }
        }
      } else if (movedAway) {
        next.dragTowardBottom = false;
      }
      return { state: next, pin: false };
    }

    case "pointerDown": {
      return { state: { ...state, pointerHeld: true, dragTowardBottom: null }, pin: false };
    }

    case "pointerDragStart": {
      if (!state.pointerHeld) {
        return { state, pin: false };
      }
      return { state: { ...state, pointerDragging: true }, pin: false };
    }

    case "pointerRelease": {
      if (!state.pointerHeld) {
        return { state, pin: false };
      }
      const next = {
        ...state,
        pointerHeld: false,
        pointerDragging: false,
        dragTowardBottom: null,
      };
      // A drag can end "at the bottom" without a final scroll event (thumb or
      // finger released inside the reserve band), so the release itself must
      // be able to re-engage.
      const releaseZonePx = Math.max(config.reattachZonePx, config.attachThresholdPx);
      if (state.dragTowardBottom === true && event.gap <= releaseZonePx) {
        next.following = true;
        return { state: next, pin: true };
      }
      return { state: next, pin: false };
    }

    case "historyKey": {
      const next = { ...state, latchUntil: event.now + config.latchMs };
      if (event.hasOverflow) {
        next.following = false;
      }
      return { state: next, pin: false };
    }

    case "followKey": {
      // Downward keys only arm the latch — their scroll events then attach
      // through the clamp/zone checks.
      return { state: { ...state, latchUntil: event.now + config.latchMs }, pin: false };
    }

    case "contentGrowth": {
      // Recording the gap keeps the next scroll event's direction detection
      // honest: without it, growth since the last scroll event makes the
      // user's next downward wheel read as "moving away".
      return { state: { ...state, lastGap: event.gap }, pin: state.following };
    }

    case "forceFollow": {
      return {
        state: {
          ...state,
          following: true,
          pointerDragging: false,
          dragTowardBottom: null,
          latchUntil: 0,
        },
        pin: true,
      };
    }
  }
}
