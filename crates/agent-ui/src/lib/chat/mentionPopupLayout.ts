const MENTION_POPUP_VIEWPORT_MARGIN_PX = 12;

export type MentionPopupHorizontalLayout = {
  left: number;
  width: number;
};

export function resolveMentionPopupHorizontalLayout(
  anchor: { left: number; width: number },
  viewportWidth: number,
): MentionPopupHorizontalLayout {
  const safeViewportWidth = Math.max(1, Number.isFinite(viewportWidth) ? viewportWidth : 1);
  const margin = Math.min(
    MENTION_POPUP_VIEWPORT_MARGIN_PX,
    Math.max(0, (safeViewportWidth - 1) / 2),
  );
  const availableWidth = Math.max(1, safeViewportWidth - margin * 2);
  const anchorWidth = Number.isFinite(anchor.width) ? anchor.width : availableWidth;
  const width = Math.min(Math.max(1, anchorWidth), availableWidth);
  const anchorLeft = Number.isFinite(anchor.left) ? anchor.left : margin;
  const left = Math.min(
    Math.max(margin, anchorLeft),
    Math.max(margin, safeViewportWidth - margin - width),
  );
  return { left, width };
}
