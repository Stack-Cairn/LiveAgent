export type MermaidViewBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MermaidPoint = { x: number; y: number };
export type MermaidViewport = { width: number; height: number };

export function parseMermaidViewBox(value: string | null): MermaidViewBox | null {
  if (!value) return null;
  const values = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    values.length !== 4 ||
    values.some((part) => !Number.isFinite(part)) ||
    values[2] <= 0 ||
    values[3] <= 0
  ) {
    return null;
  }
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

export function zoomMermaidViewBox(viewBox: MermaidViewBox, factor: number): MermaidViewBox {
  if (!Number.isFinite(factor) || factor <= 0) return viewBox;
  const width = viewBox.width / factor;
  const height = viewBox.height / factor;
  return {
    x: viewBox.x + (viewBox.width - width) / 2,
    y: viewBox.y + (viewBox.height - height) / 2,
    width,
    height,
  };
}

export function panMermaidViewBox(
  viewBox: MermaidViewBox,
  delta: MermaidPoint,
  viewport: MermaidViewport,
): MermaidViewBox {
  const scale = Math.min(viewport.width / viewBox.width, viewport.height / viewBox.height);
  if (!Number.isFinite(scale) || scale <= 0) return viewBox;
  return {
    ...viewBox,
    x: viewBox.x - delta.x / scale,
    y: viewBox.y - delta.y / scale,
  };
}

export function formatMermaidViewBox(viewBox: MermaidViewBox): string {
  return `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`;
}
