// GitReview transient overlay scrollbar system.
//
// Scroll containers opt in via GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS plus the
// onScroll handler returned by useOverlayScrollbar(). The overlay thumbs are
// lazily attached to document.body on first scroll; every element that gained
// an overlay through a hook instance is destroyed again when that component
// unmounts, so no orphan DOM nodes or window listeners outlive their view.
// (As a second line of defense the hide timer also destroys overlays whose
// element left the document.)

import { type UIEvent as ReactUIEvent, useCallback, useEffect, useRef } from "react";

export const GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS = "git-review-transient-scrollbar";
const GIT_REVIEW_SCROLLBAR_HIDE_DELAY_MS = 1000;
const GIT_REVIEW_SCROLLBAR_HOVER_CHECK_MS = 140;
const GIT_REVIEW_SCROLLBAR_THUMB_SIZE_PX = 4;
const GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX = 2;
const GIT_REVIEW_SCROLLBAR_MIN_THUMB_PX = 28;

const gitReviewScrollbarTimers = new WeakMap<HTMLElement, number>();
type GitReviewScrollbarAxis = "vertical" | "horizontal";
type GitReviewScrollbarOverlay = {
  vertical: HTMLDivElement;
  horizontal: HTMLDivElement;
  remove: () => void;
};
const gitReviewScrollbarOverlays = new WeakMap<HTMLElement, GitReviewScrollbarOverlay>();

// Overlay-including scrollability check (merged from the web frontend): a
// container only counts as scrollable when its computed overflow says so,
// not merely because its content is taller/wider than its box.
export function isScrollableOverflowValue(value: string) {
  return /(auto|scroll|overlay)/.test(value);
}

function gitReviewScrollbarThumbSize(viewportSize: number, scrollSize: number, trackSize: number) {
  if (viewportSize <= 0 || scrollSize <= viewportSize || trackSize <= 0) return 0;
  return Math.min(
    trackSize,
    Math.max(GIT_REVIEW_SCROLLBAR_MIN_THUMB_PX, (viewportSize / scrollSize) * trackSize),
  );
}

function gitReviewScrollbarThumbOffset(
  scrollOffset: number,
  maxScroll: number,
  maxThumbOffset: number,
) {
  if (maxScroll <= 0 || maxThumbOffset <= 0) return 0;
  return (scrollOffset / maxScroll) * maxThumbOffset;
}

function destroyGitReviewScrollbarOverlay(element: HTMLElement) {
  const timer = gitReviewScrollbarTimers.get(element);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    gitReviewScrollbarTimers.delete(element);
  }
  delete element.dataset.scrollActive;
  delete element.dataset.scrollbarHover;
  const overlay = gitReviewScrollbarOverlays.get(element);
  if (!overlay) return;
  overlay.remove();
  gitReviewScrollbarOverlays.delete(element);
}

function setGitReviewScrollbarOverlayVisible(element: HTMLElement, visible: boolean) {
  const overlay = gitReviewScrollbarOverlays.get(element);
  if (!overlay) return;
  const nextValue = visible ? "true" : "false";
  overlay.vertical.dataset.visible = nextValue;
  overlay.horizontal.dataset.visible = nextValue;
}

function updateGitReviewScrollbarOverlay(element: HTMLElement) {
  if (!element.isConnected) {
    destroyGitReviewScrollbarOverlay(element);
    return;
  }
  const overlay = ensureGitReviewScrollbarOverlay(element);
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const canScrollVertically =
    isScrollableOverflowValue(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
  const canScrollHorizontally =
    isScrollableOverflowValue(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
  const visible =
    element.dataset.scrollActive === "true" || element.dataset.scrollbarHover === "true";
  const cornerOffset = GIT_REVIEW_SCROLLBAR_THUMB_SIZE_PX + GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX;

  if (canScrollVertically && rect.width > 0 && rect.height > 0) {
    const trackSize = Math.max(
      0,
      rect.height -
        GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX * 2 -
        (canScrollHorizontally ? cornerOffset : 0),
    );
    const thumbSize = gitReviewScrollbarThumbSize(
      element.clientHeight,
      element.scrollHeight,
      trackSize,
    );
    const thumbOffset = gitReviewScrollbarThumbOffset(
      element.scrollTop,
      element.scrollHeight - element.clientHeight,
      trackSize - thumbSize,
    );
    overlay.vertical.style.display = "";
    overlay.vertical.style.left = `${Math.round(
      rect.right - GIT_REVIEW_SCROLLBAR_THUMB_SIZE_PX - GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX,
    )}px`;
    overlay.vertical.style.top = `${Math.round(
      rect.top + GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX + thumbOffset,
    )}px`;
    overlay.vertical.style.height = `${Math.max(0, thumbSize)}px`;
  } else {
    overlay.vertical.style.display = "none";
  }

  if (canScrollHorizontally && rect.width > 0 && rect.height > 0) {
    const trackSize = Math.max(
      0,
      rect.width -
        GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX * 2 -
        (canScrollVertically ? cornerOffset : 0),
    );
    const thumbSize = gitReviewScrollbarThumbSize(
      element.clientWidth,
      element.scrollWidth,
      trackSize,
    );
    const thumbOffset = gitReviewScrollbarThumbOffset(
      element.scrollLeft,
      element.scrollWidth - element.clientWidth,
      trackSize - thumbSize,
    );
    overlay.horizontal.style.display = "";
    overlay.horizontal.style.left = `${Math.round(
      rect.left + GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX + thumbOffset,
    )}px`;
    overlay.horizontal.style.top = `${Math.round(
      rect.bottom - GIT_REVIEW_SCROLLBAR_THUMB_SIZE_PX - GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX,
    )}px`;
    overlay.horizontal.style.width = `${Math.max(0, thumbSize)}px`;
  } else {
    overlay.horizontal.style.display = "none";
  }

  setGitReviewScrollbarOverlayVisible(element, visible);
}

function startGitReviewScrollbarDrag(
  element: HTMLElement,
  overlay: GitReviewScrollbarOverlay,
  axis: GitReviewScrollbarAxis,
  event: PointerEvent,
) {
  event.preventDefault();
  event.stopPropagation();
  const thumb = axis === "vertical" ? overlay.vertical : overlay.horizontal;
  const rect = element.getBoundingClientRect();
  const hasCrossAxisScrollbar =
    axis === "vertical"
      ? element.scrollWidth > element.clientWidth + 1
      : element.scrollHeight > element.clientHeight + 1;
  const trackSize = Math.max(
    0,
    (axis === "vertical" ? rect.height : rect.width) -
      GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX * 2 -
      (hasCrossAxisScrollbar
        ? GIT_REVIEW_SCROLLBAR_THUMB_SIZE_PX + GIT_REVIEW_SCROLLBAR_EDGE_OFFSET_PX
        : 0),
  );
  const thumbSize =
    axis === "vertical"
      ? Number.parseFloat(thumb.style.height) || 0
      : Number.parseFloat(thumb.style.width) || 0;
  const maxThumbOffset = Math.max(1, trackSize - thumbSize);
  const maxScroll =
    axis === "vertical"
      ? element.scrollHeight - element.clientHeight
      : element.scrollWidth - element.clientWidth;
  const startPointer = axis === "vertical" ? event.clientY : event.clientX;
  const startScroll = axis === "vertical" ? element.scrollTop : element.scrollLeft;
  const pointerId = event.pointerId;

  element.dataset.scrollActive = "true";
  element.dataset.scrollbarHover = "true";
  thumb.dataset.dragging = "true";
  updateGitReviewScrollbarOverlay(element);
  thumb.setPointerCapture(pointerId);

  const handleMove = (moveEvent: PointerEvent) => {
    const currentPointer = axis === "vertical" ? moveEvent.clientY : moveEvent.clientX;
    const nextScroll = startScroll + ((currentPointer - startPointer) / maxThumbOffset) * maxScroll;
    if (axis === "vertical") {
      element.scrollTop = nextScroll;
    } else {
      element.scrollLeft = nextScroll;
    }
    element.dataset.scrollActive = "true";
    updateGitReviewScrollbarOverlay(element);
  };
  const handleUp = () => {
    thumb.releasePointerCapture(pointerId);
    delete thumb.dataset.dragging;
    delete element.dataset.scrollbarHover;
    thumb.removeEventListener("pointermove", handleMove);
    thumb.removeEventListener("pointerup", handleUp);
    thumb.removeEventListener("pointercancel", handleUp);
    scheduleGitReviewScrollbarHide(element);
  };

  thumb.addEventListener("pointermove", handleMove);
  thumb.addEventListener("pointerup", handleUp);
  thumb.addEventListener("pointercancel", handleUp);
}

function ensureGitReviewScrollbarOverlay(element: HTMLElement) {
  const currentOverlay = gitReviewScrollbarOverlays.get(element);
  if (currentOverlay) return currentOverlay;
  const vertical = document.createElement("div");
  const horizontal = document.createElement("div");
  const overlay: GitReviewScrollbarOverlay = {
    vertical,
    horizontal,
    remove: () => {
      window.removeEventListener("resize", handleWindowResize);
      vertical.remove();
      horizontal.remove();
    },
  };
  const handleWindowResize = () => updateGitReviewScrollbarOverlay(element);
  const handleEnter = () => {
    element.dataset.scrollActive = "true";
    element.dataset.scrollbarHover = "true";
    updateGitReviewScrollbarOverlay(element);
  };
  const handleLeave = () => {
    delete element.dataset.scrollbarHover;
    scheduleGitReviewScrollbarHide(element, GIT_REVIEW_SCROLLBAR_HOVER_CHECK_MS);
  };
  vertical.className = "git-review-floating-scrollbar git-review-floating-scrollbar-vertical";
  horizontal.className = "git-review-floating-scrollbar git-review-floating-scrollbar-horizontal";
  vertical.dataset.visible = "false";
  horizontal.dataset.visible = "false";
  vertical.addEventListener("pointerenter", handleEnter);
  horizontal.addEventListener("pointerenter", handleEnter);
  vertical.addEventListener("pointerleave", handleLeave);
  horizontal.addEventListener("pointerleave", handleLeave);
  vertical.addEventListener("pointerdown", (event) =>
    startGitReviewScrollbarDrag(element, overlay, "vertical", event),
  );
  horizontal.addEventListener("pointerdown", (event) =>
    startGitReviewScrollbarDrag(element, overlay, "horizontal", event),
  );
  window.addEventListener("resize", handleWindowResize);
  document.body.append(vertical, horizontal);
  gitReviewScrollbarOverlays.set(element, overlay);
  return overlay;
}

function scheduleGitReviewScrollbarHide(
  element: HTMLElement,
  delay = GIT_REVIEW_SCROLLBAR_HIDE_DELAY_MS,
) {
  const currentTimer = gitReviewScrollbarTimers.get(element);
  if (currentTimer !== undefined) {
    window.clearTimeout(currentTimer);
  }
  const nextTimer = window.setTimeout(() => {
    if (!element.isConnected) {
      destroyGitReviewScrollbarOverlay(element);
      return;
    }
    if (element.dataset.scrollbarHover === "true") {
      scheduleGitReviewScrollbarHide(element, GIT_REVIEW_SCROLLBAR_HOVER_CHECK_MS);
      return;
    }
    delete element.dataset.scrollActive;
    setGitReviewScrollbarOverlayVisible(element, false);
    gitReviewScrollbarTimers.delete(element);
  }, delay);
  gitReviewScrollbarTimers.set(element, nextTimer);
}

// Selection autoscroll (pointer-drag selection inside diff viewports) drives
// the same overlay so the thumb follows programmatic scrolling too. Only
// elements that already opted in via the transient-scrollbar class react.
export function syncGitReviewAutoscrollScrollbar(viewport: HTMLElement) {
  if (!viewport.classList.contains(GIT_REVIEW_TRANSIENT_SCROLLBAR_CLASS)) return;
  viewport.dataset.scrollActive = "true";
  updateGitReviewScrollbarOverlay(viewport);
  scheduleGitReviewScrollbarHide(viewport);
}

// Per-component overlay scrollbar lifecycle: returns the onScroll handler for
// transient-scrollbar containers and destroys every overlay this component
// created when it unmounts.
export function useOverlayScrollbar() {
  const elementsRef = useRef<Set<HTMLElement>>(new Set());

  const handleScroll = useCallback((event: ReactUIEvent<HTMLElement>) => {
    const element = event.currentTarget;
    elementsRef.current.add(element);
    element.dataset.scrollActive = "true";
    updateGitReviewScrollbarOverlay(element);
    scheduleGitReviewScrollbarHide(element);
  }, []);

  useEffect(() => {
    const elements = elementsRef.current;
    return () => {
      for (const element of elements) {
        destroyGitReviewScrollbarOverlay(element);
      }
      elements.clear();
    };
  }, []);

  return handleScroll;
}
