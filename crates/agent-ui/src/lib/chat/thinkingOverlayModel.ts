export type ThinkingOverlayRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export type ThinkingOverlayViewport = { width: number; height: number };

export type ThinkingOverlayPlacement = {
  side: "above" | "below";
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

const VIEWPORT_MARGIN_PX = 12;
const OVERLAY_GAP_PX = 8;
const MAX_OVERLAY_WIDTH_PX = 640;
const MIN_PREFERRED_HEIGHT_PX = 180;

export function resolveThinkingOverlayPlacement(
  trigger: ThinkingOverlayRect,
  viewport: ThinkingOverlayViewport,
): ThinkingOverlayPlacement {
  const viewportWidth = Math.max(1, viewport.width);
  const horizontalMargin = Math.min(VIEWPORT_MARGIN_PX, Math.max(0, (viewportWidth - 1) / 2));
  const availableWidth = Math.max(1, viewportWidth - horizontalMargin * 2);
  const width = Math.min(MAX_OVERLAY_WIDTH_PX, availableWidth);
  const centeredLeft = trigger.left + (trigger.width - width) / 2;
  const left = Math.min(
    Math.max(horizontalMargin, centeredLeft),
    Math.max(horizontalMargin, viewportWidth - horizontalMargin - width),
  );
  const above = Math.max(0, trigger.top - OVERLAY_GAP_PX - VIEWPORT_MARGIN_PX);
  const below = Math.max(0, viewport.height - trigger.bottom - OVERLAY_GAP_PX - VIEWPORT_MARGIN_PX);
  const side = above >= MIN_PREFERRED_HEIGHT_PX || above >= below ? "above" : "below";

  if (side === "above") {
    return {
      side,
      left,
      width,
      maxHeight: above,
      bottom: viewport.height - trigger.top + OVERLAY_GAP_PX,
    };
  }
  return {
    side,
    left,
    width,
    maxHeight: below,
    top: trigger.bottom + OVERLAY_GAP_PX,
  };
}
