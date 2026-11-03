type VerticalRect = Pick<DOMRectReadOnly, "top" | "bottom" | "height">;
type HorizontalRect = Pick<DOMRectReadOnly, "left" | "width">;

export type ComposerOverlayRect = VerticalRect;
export type ComposerOverlayHorizontalRect = HorizontalRect;

export type ComposerOverlayMetrics = {
  /** 输入区、队列、目标栏和任务胶囊的完整占位高度。 */
  heightPx: number;
  /** 卡片列中心相对输入区层中心的水平偏移（向右为正）。 */
  centerOffsetPx: number;
};

export function measureComposerOverlay(input: {
  layer: VerticalRect & HorizontalRect;
  /** 绝对定位在卡片列上方的任务胶囊；未渲染时高度为 0。 */
  floating: VerticalRect | null | undefined;
  column: HorizontalRect | null | undefined;
}): ComposerOverlayMetrics {
  const { layer, floating, column } = input;
  if (layer.height <= 0) return { heightPx: 0, centerOffsetPx: 0 };
  const top = floating && floating.height > 0 ? Math.min(layer.top, floating.top) : layer.top;
  const centerOffsetPx =
    column && column.width > 0
      ? Math.round(column.left + column.width / 2 - (layer.left + layer.width / 2))
      : 0;
  return {
    heightPx: Math.ceil(Math.max(0, layer.bottom - top)),
    centerOffsetPx,
  };
}
