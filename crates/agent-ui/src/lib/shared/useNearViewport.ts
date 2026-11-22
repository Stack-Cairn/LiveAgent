import { type RefObject, useEffect, useRef, useState } from "react";

/** Closest ancestor that scrolls vertically (the transcript or a diff pane). */
export function findScrollParent(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

export type NearViewportOptions = {
  /** Becomes near once within this distance of the visible area. */
  enterMarginPx?: number;
  /** Becomes far again only beyond this distance (hysteresis against flicker). */
  leaveMarginPx?: number;
  /**
   * Called before the element is reported far; returning false keeps it near
   * (focus or a text selection inside it, an open editor). Also the place to
   * measure the content that is about to be replaced by a placeholder.
   */
  beforeLeave?: () => boolean;
};

/**
 * Whether an element is near its scroll container's visible area. Observes
 * against the closest scrolling ancestor, not the window, so the margins work
 * inside nested scroll panes (an IntersectionObserver rooted at the window
 * clips at the pane edge before any margin applies). Without
 * IntersectionObserver everything counts as near.
 */
export function useNearViewport(
  ref: RefObject<Element | null>,
  { enterMarginPx = 600, leaveMarginPx = 1600, beforeLeave }: NearViewportOptions = {},
) {
  const [near, setNear] = useState(false);
  const beforeLeaveRef = useRef(beforeLeave);
  beforeLeaveRef.current = beforeLeave;

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return undefined;
    }
    const root = findScrollParent(element);
    const enter = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root, rootMargin: `${enterMarginPx}px 0px` },
    );
    const leave = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (!last || last.isIntersecting) return;
        if (beforeLeaveRef.current?.() === false) return;
        setNear(false);
      },
      { root, rootMargin: `${leaveMarginPx}px 0px` },
    );
    enter.observe(element);
    leave.observe(element);
    return () => {
      enter.disconnect();
      leave.disconnect();
    };
  }, [enterMarginPx, leaveMarginPx, ref]);

  return near;
}

/**
 * Whether unmounting `element` would lose something the user is doing in it:
 * keyboard focus or a text selection that touches it.
 */
export function isElementInUse(element: Element) {
  const active = element.ownerDocument.activeElement;
  if (active && active !== element.ownerDocument.body && element.contains(active)) return true;
  const selection = element.ownerDocument.defaultView?.getSelection?.();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
    return selection.containsNode(element, true);
  }
  return false;
}
