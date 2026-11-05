import { useLayoutEffect, useState } from "react";

export type ViewportClientSize = { width: number; height: number };

/**
 * The viewport's client size, read once per element and then kept current by
 * a ResizeObserver. Render paths read this instead of `clientWidth` /
 * `clientHeight`: during streaming the previous commit has just changed the
 * DOM, so every such read in render forces a full synchronous layout that the
 * browser then throws away and redoes before paint.
 *
 * The returned object is mutated in place on resize (no re-render): callers
 * that only feed virtualizer options pick the new size up on their next render,
 * exactly like the per-render reads did.
 */
export function useViewportClientSize(viewport: HTMLElement | null): ViewportClientSize {
  const [sizes] = useState(() => new WeakMap<HTMLElement, ViewportClientSize>());
  let size: ViewportClientSize = { width: 0, height: 0 };
  if (viewport) {
    const known = sizes.get(viewport);
    if (known) size = known;
    else {
      size = { width: viewport.clientWidth, height: viewport.clientHeight };
      sizes.set(viewport, size);
    }
  }

  useLayoutEffect(() => {
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const current = sizes.get(viewport);
    if (!current) return;
    const observer = new ResizeObserver(() => {
      current.width = viewport.clientWidth;
      current.height = viewport.clientHeight;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport, sizes]);

  return size;
}
