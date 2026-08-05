import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createFollowState,
  DEFAULT_FOLLOW_CONFIG,
  type FollowConfig,
  type FollowEvent,
  type FollowState,
  isDominantVerticalWheel,
  POINTER_DRAG_SLOP_PX,
  reduceFollowEvent,
  SCROLL_FOLLOW_IGNORE_KEYS_ATTRIBUTE,
} from "./scrollFollowCore";

// Below this the element cannot meaningfully scroll; wheel/touch on it must
// not change follow state, and nested elements under it don't consume wheels.
const SCROLLABLE_OVERFLOW_MIN_PX = 4;

function shouldIgnoreScrollKeyTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.closest(`[${SCROLL_FOLLOW_IGNORE_KEYS_ATTRIBUTE}]`) !== null
  );
}

function isHistoryScrollKey(event: KeyboardEvent) {
  if (shouldIgnoreScrollKeyTarget(event.target)) {
    return false;
  }
  return (
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    (event.key === " " && event.shiftKey)
  );
}

function isFollowScrollKey(event: KeyboardEvent) {
  if (shouldIgnoreScrollKeyTarget(event.target)) {
    return false;
  }
  return (
    event.key === "ArrowDown" ||
    event.key === "PageDown" ||
    event.key === "End" ||
    (event.key === " " && !event.shiftKey)
  );
}

export type ScrollFollowHandle = {
  // Force follow mode and pin now (or on viewport arrival if not bound yet).
  stickToBottom: () => void;
  // Animate to the bottom, then force follow. For user-facing affordances
  // (the jump button); programmatic pins (conversation switch, run start)
  // stay instant via stickToBottom.
  jumpToBottom: () => void;
  // Detach follow mode for a programmatic jump into history (floor
  // navigation, search results): reuses the historyKey semantics so the
  // engine treats it exactly like a user-initiated jump away from the
  // bottom, instead of re-pinning over the new scroll position.
  breakFollow: () => void;
  isFollowing: () => boolean;
};

// Base duration plus a mild distance term, capped — long transcripts glide
// fast instead of crawling for seconds.
const JUMP_BASE_DURATION_MS = 260;
const JUMP_MAX_DURATION_MS = 600;
const JUMP_DISTANCE_DURATION_DIVISOR = 8;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export type UseScrollFollowArgs = {
  // The scrolling element, delivered via callback ref → state so listeners
  // re-bind on element identity change and can never survive on a dead node.
  viewport: HTMLElement | null;
  // ResizeObserver growth target. Must be the element whose border box grows
  // with the content — for a max-height-clamped scroller pass an inner
  // wrapper, not the scroller itself. Defaults to viewport.firstElementChild.
  content?: Element | null;
  // Where wheel/touch/pointer listeners bind. The transcript passes the
  // ScrollArea root so gestures over the custom scrollbar (a sibling of the
  // viewport) count too. Defaults to the viewport.
  listenerRoot?: HTMLElement | null;
  enabled?: boolean;
  // Window-level scroll keys (ArrowUp/PageDown/...) participate in follow
  // state. Only the transcript wants this.
  trackKeys?: boolean;
  config?: Partial<FollowConfig>;
};

export function useScrollFollow(args: UseScrollFollowArgs): {
  handle: ScrollFollowHandle;
  following: boolean;
} {
  const { viewport, content = null, listenerRoot = null, enabled = true, trackKeys = false } = args;

  const stateRef = useRef<FollowState>(createFollowState());
  const boundViewportRef = useRef<HTMLElement | null>(null);
  const configRef = useRef<FollowConfig>(DEFAULT_FOLLOW_CONFIG);
  configRef.current = { ...DEFAULT_FOLLOW_CONFIG, ...args.config };
  const [following, setFollowing] = useState(true);
  const jumpRafRef = useRef<number | null>(null);

  const cancelJumpAnimation = useCallback(() => {
    if (jumpRafRef.current !== null) {
      cancelAnimationFrame(jumpRafRef.current);
      jumpRafRef.current = null;
    }
  }, []);

  const pinToBottom = useCallback(() => {
    // An instant pin supersedes any in-flight jump animation.
    cancelJumpAnimation();
    const el = boundViewportRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [cancelJumpAnimation]);

  const dispatch = useCallback(
    (event: FollowEvent) => {
      const wasFollowing = stateRef.current.following;
      const step = reduceFollowEvent(stateRef.current, event, configRef.current);
      stateRef.current = step.state;
      if (step.pin) {
        pinToBottom();
      }
      if (step.state.following !== wasFollowing) {
        setFollowing(step.state.following);
      }
    },
    [pinToBottom],
  );

  const stickToBottom = useCallback(() => {
    dispatch({ type: "forceFollow" });
  }, [dispatch]);

  // Ease toward the bottom without engaging follow mode: with following still
  // false the corrector can't snap the animation to the end, and CSS smooth
  // scrolling stays out of the picture (streaming pins must remain instant).
  // The target is re-read every frame so streaming growth can't leave the
  // jump stranded short of the bottom; arrival hands off to forceFollow.
  const jumpToBottom = useCallback(() => {
    const el = boundViewportRef.current;
    const distance = el ? Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop) : 0;
    if (!el || distance < 2 || prefersReducedMotion()) {
      stickToBottom();
      return;
    }
    cancelJumpAnimation();
    const startTop = el.scrollTop;
    const duration = Math.min(
      JUMP_MAX_DURATION_MS,
      JUMP_BASE_DURATION_MS + distance / JUMP_DISTANCE_DURATION_DIVISOR,
    );
    let startTs: number | null = null;
    const tick = (ts: number) => {
      const viewportEl = boundViewportRef.current;
      if (!viewportEl) {
        jumpRafRef.current = null;
        return;
      }
      if (startTs === null) {
        startTs = ts;
      }
      const t = Math.min(1, (ts - startTs) / duration);
      const eased = 1 - (1 - t) ** 3;
      const target = viewportEl.scrollHeight - viewportEl.clientHeight;
      viewportEl.scrollTop = startTop + (target - startTop) * eased;
      if (t >= 1) {
        jumpRafRef.current = null;
        stickToBottom();
        return;
      }
      jumpRafRef.current = requestAnimationFrame(tick);
    };
    jumpRafRef.current = requestAnimationFrame(tick);
  }, [cancelJumpAnimation, stickToBottom]);

  useEffect(() => {
    if (!enabled || !viewport) {
      return;
    }
    const root = listenerRoot ?? viewport;
    const growthTarget = content ?? viewport.firstElementChild;

    // Fresh binds always follow: a new mount, a re-created viewport, or a
    // re-enabled thinking block starts pinned, and a forceFollow dispatched
    // before the element arrived is honored by the same reset.
    boundViewportRef.current = viewport;
    stateRef.current = createFollowState();
    setFollowing(true);
    pinToBottom();

    const getGap = () =>
      Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
    const hasOverflow = () =>
      viewport.scrollHeight - viewport.clientHeight > SCROLLABLE_OVERFLOW_MIN_PX;

    // Walk from the wheel target up to (excluding) the viewport/root: a nested
    // scroller that is mid-scroll consumes the upward delta itself.
    const nestedCanConsumeWheelUp = (target: EventTarget | null) => {
      let node = target instanceof Element ? target : null;
      while (node && node !== viewport && node !== root) {
        if (
          node instanceof HTMLElement &&
          node.scrollTop > 0 &&
          node.scrollHeight - node.clientHeight > SCROLLABLE_OVERFLOW_MIN_PX
        ) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    const handleScroll = () => {
      dispatch({ type: "scroll", gap: getGap(), now: Date.now() });
    };

    const handleWheel = (event: WheelEvent) => {
      // A vertical wheel mid-jump means the user is taking over.
      if (isDominantVerticalWheel(event.deltaX, event.deltaY)) {
        cancelJumpAnimation();
      }
      dispatch({
        type: "wheel",
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        gap: getGap(),
        hasOverflow: hasOverflow(),
        nestedCanConsume: event.deltaY < 0 && nestedCanConsumeWheelUp(event.target),
        now: Date.now(),
      });
    };

    let touchY: number | null = null;
    const handleTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      cancelJumpAnimation();
      const nextY = event.touches[0]?.clientY ?? null;
      const previousY = touchY;
      touchY = nextY;
      dispatch({
        type: "touchMove",
        fingerMovedDown: previousY === null || nextY === null ? null : nextY > previousY + 1,
        gap: getGap(),
        hasOverflow: hasOverflow(),
        now: Date.now(),
      });
    };

    // Secondary-button presses are excluded because the native context menu
    // can swallow the matching pointerup.
    let pointerDownX = 0;
    let pointerDownY = 0;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button === 2) {
        return;
      }
      pointerDownX = event.clientX;
      pointerDownY = event.clientY;
      dispatch({ type: "pointerDown" });
      // A press on the custom scrollbar is unambiguous scroll intent, and a
      // track click jumps scrollTop synchronously on pointerdown with zero
      // pointer movement — the movement-slop promotion below would never fire
      // and the corrector would undo the jump. Content clicks keep the slop
      // gate (static click + layout echo must not read as a drag).
      if (event.target instanceof Element && event.target.closest("[data-scroll-area-scrollbar]")) {
        cancelJumpAnimation();
        dispatch({ type: "pointerDragStart" });
      }
    };
    const handlePointerRelease = () => {
      dispatch({ type: "pointerRelease", gap: getGap() });
    };
    const handlePointerMove = (event: PointerEvent) => {
      const state = stateRef.current;
      if (!state.pointerHeld) {
        return;
      }
      // A pointerup can get lost (released outside the window, native menus);
      // movement with no buttons down proves the press ended.
      if (event.buttons === 0) {
        handlePointerRelease();
        return;
      }
      if (!state.pointerDragging) {
        const dx = event.clientX - pointerDownX;
        const dy = event.clientY - pointerDownY;
        if (dx * dx + dy * dy >= POINTER_DRAG_SLOP_PX * POINTER_DRAG_SLOP_PX) {
          cancelJumpAnimation();
          dispatch({ type: "pointerDragStart" });
        }
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isHistoryScrollKey(event)) {
        cancelJumpAnimation();
        dispatch({ type: "historyKey", hasOverflow: hasOverflow(), now: Date.now() });
      } else if (isFollowScrollKey(event)) {
        dispatch({ type: "followKey", now: Date.now() });
      }
    };

    // Belt for WebView2 occlusion throttling: whatever rendering work was
    // suspended, a visible window that should follow must show the bottom.
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && stateRef.current.following) {
        pinToBottom();
      }
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    root.addEventListener("wheel", handleWheel, { passive: true });
    root.addEventListener("touchstart", handleTouchStart, { passive: true });
    root.addEventListener("touchmove", handleTouchMove, { passive: true });
    root.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointerup", handlePointerRelease, { passive: true });
    window.addEventListener("pointercancel", handlePointerRelease, { passive: true });
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("blur", handlePointerRelease);
    if (trackKeys) {
      window.addEventListener("keydown", handleKeyDown, { capture: true });
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Fires post-layout, pre-paint on every content/viewport size change —
    // this IS the streaming pin driver (its cadence is already coalesced to
    // ≤1/frame by the live-store flush). The initial delivery on observe()
    // doubles as the mount pin.
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            dispatch({ type: "contentGrowth", gap: getGap() });
          });
    resizeObserver?.observe(viewport);
    if (growthTarget instanceof Element) {
      resizeObserver?.observe(growthTarget);
    }

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      root.removeEventListener("wheel", handleWheel);
      root.removeEventListener("touchstart", handleTouchStart);
      root.removeEventListener("touchmove", handleTouchMove);
      root.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerRelease);
      window.removeEventListener("pointercancel", handlePointerRelease);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("blur", handlePointerRelease);
      if (trackKeys) {
        window.removeEventListener("keydown", handleKeyDown, { capture: true });
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resizeObserver?.disconnect();
      cancelJumpAnimation();
      boundViewportRef.current = null;
    };
  }, [
    cancelJumpAnimation,
    content,
    dispatch,
    enabled,
    listenerRoot,
    pinToBottom,
    trackKeys,
    viewport,
  ]);

  const breakFollow = useCallback(() => {
    cancelJumpAnimation();
    // 与键盘 historyKey 路径同构：溢出与否取实测值（无溢出时 reducer 不解除
    // 跟随，避免「视觉在底部却被搁浅为 off」），时间基与其余事件一致用 Date.now()。
    const el = boundViewportRef.current;
    const hasOverflow =
      el !== null && el.scrollHeight - el.clientHeight > SCROLLABLE_OVERFLOW_MIN_PX;
    dispatch({ type: "historyKey", hasOverflow, now: Date.now() });
  }, [cancelJumpAnimation, dispatch]);

  const handle = useMemo<ScrollFollowHandle>(
    () => ({
      stickToBottom,
      jumpToBottom,
      breakFollow,
      isFollowing: () => stateRef.current.following,
    }),
    [breakFollow, jumpToBottom, stickToBottom],
  );

  return { handle, following };
}
