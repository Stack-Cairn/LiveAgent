type VerticalRect = Pick<DOMRectReadOnly, "top" | "bottom" | "height">;
type HorizontalRect = Pick<DOMRectReadOnly, "left" | "width">;

export type ComposerOverlayRect = VerticalRect;
export type ComposerOverlayHorizontalRect = HorizontalRect;

export type ComposerOverlayMetrics = {
  /** 输入区常规占位高度（已扣除队列面板），驱动正文底部预留。 */
  heightPx: number;
  /**
   * 预留线之上、被浮动元素额外占据的高度：队列面板从 heightPx 中扣除、
   * 任务进度药丸绝对定位在卡片列之外，两者都不推高底部预留，却会盖住同样
   * 浮在输入区上方的控件（如回到底部按钮）。这类控件要在 heightPx 之上再让出
   * 这段距离。
   */
  floatingOverhangPx: number;
  /**
   * 卡片列中心相对输入区层中心的水平偏移（向右为正）。desktop 卡片为对齐
   * 正文会整体右移，居中锚定在输入区上方的控件要跟着平移才能与卡片、药丸对齐。
   */
  centerOffsetPx: number;
};

export function measureComposerOverlay(input: {
  layer: VerticalRect & HorizontalRect;
  queueHeight: number;
  /** 任务进度药丸容器；未渲染药丸时高度为 0。 */
  floating: VerticalRect | null | undefined;
  /** 卡片列（队列面板、输入卡片、药丸的共同水平参照）。 */
  column: HorizontalRect | null | undefined;
}): ComposerOverlayMetrics {
  const { layer, queueHeight, floating, column } = input;
  const heightPx = Math.ceil(Math.max(0, layer.height - queueHeight));
  const reserveLine = layer.bottom - heightPx;
  const floatingTop =
    floating && floating.height > 0 ? Math.min(layer.top, floating.top) : layer.top;
  const centerOffsetPx =
    column && column.width > 0
      ? Math.round(column.left + column.width / 2 - (layer.left + layer.width / 2))
      : 0;
  return {
    heightPx,
    floatingOverhangPx: Math.ceil(Math.max(0, reserveLine - floatingTop)),
    centerOffsetPx,
  };
}
