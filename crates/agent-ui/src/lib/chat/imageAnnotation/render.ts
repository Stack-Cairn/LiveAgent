// Rendering and export for annotation documents. The same renderer draws
// the on-screen editor (downscaled working bitmap, zoom/pan, HiDPI) and the
// exported file (original resolution, cropped), so what is seen is what is
// sent. Blur regions pixelate the pixels already drawn below them.

import {
  type AnnotationDocument,
  type AnnotationRect,
  type AnnotationShape,
  annotationSizeScale,
  exportRegion,
  type MarkerShape,
  type TextShape,
} from "./model";

/** Pixel buffer shape shared by ImageData and test doubles. */
export type PixelBuffer = { data: Uint8ClampedArray; width: number; height: number };

/** The subset of CanvasRenderingContext2D the renderer uses. */
export type AnnotationCanvasContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "setTransform"
  | "drawImage"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "quadraticCurveTo"
  | "arc"
  | "rect"
  | "stroke"
  | "fill"
  | "fillRect"
  | "fillText"
  | "strokeText"
  | "measureText"
  | "putImageData"
> & {
  getImageData(sx: number, sy: number, sw: number, sh: number): PixelBuffer;
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
};

/** Upper bound for either side of an exported image (matches the preview
 *  decoder's limit, so the attachment thumbnail always loads). */
export const ANNOTATION_EXPORT_MAX_DIMENSION = 8192;
/** Upper bound for an exported file (the uploaded-image preview limit). */
export const ANNOTATION_EXPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Longest side of the bitmap the editor draws on; larger images are
 *  downscaled for editing and re-rendered from the original on export. */
export const ANNOTATION_WORKING_MAX_DIMENSION = 2560;

export const ANNOTATION_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/* ------------------------------------------------------------------ */
/*  Pixelation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Replaces every `block`×`block` cell of `buffer` with its average colour,
 * in place. The averages are all that remains of the original pixels.
 */
export function pixelateImageData(buffer: PixelBuffer, block: number) {
  const size = Math.max(1, Math.floor(block));
  const { data, width, height } = buffer;
  for (let top = 0; top < height; top += size) {
    const bottom = Math.min(height, top + size);
    for (let left = 0; left < width; left += size) {
      const right = Math.min(width, left + size);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const index = (y * width + x) * 4;
          r += data[index] ?? 0;
          g += data[index + 1] ?? 0;
          b += data[index + 2] ?? 0;
          a += data[index + 3] ?? 0;
          count += 1;
        }
      }
      if (count === 0) continue;
      const avg = [r / count, g / count, b / count, a / count].map(Math.round);
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const index = (y * width + x) * 4;
          data[index] = avg[0] ?? 0;
          data[index + 1] = avg[1] ?? 0;
          data[index + 2] = avg[2] ?? 0;
          data[index + 3] = avg[3] ?? 0;
        }
      }
    }
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/*  Drawing                                                            */
/* ------------------------------------------------------------------ */

export type AnnotationView = {
  /** Device pixels per image pixel. */
  scale: number;
  /** Image coordinate drawn at device (0, 0). */
  originX: number;
  originY: number;
  /** Device canvas size, for clamping pixel reads. */
  canvasWidth: number;
  canvasHeight: number;
};

export type RenderAnnotationOptions = {
  /** Base image drawn at the document's full size (any resolution). */
  image: CanvasImageSource | null;
  doc: AnnotationDocument;
  view: AnnotationView;
  /** Fill drawn under the image (JPEG export has no alpha). */
  background?: string;
  /** Shapes to skip (e.g. the text being edited in place). */
  hiddenShapeId?: string | null;
};

function applyView(ctx: AnnotationCanvasContext, view: AnnotationView) {
  ctx.setTransform(
    view.scale,
    0,
    0,
    view.scale,
    -view.originX * view.scale,
    -view.originY * view.scale,
  );
}

/** Device-pixel rectangle covered by an image-space rect, clamped to the canvas. */
export function deviceRect(rect: AnnotationRect, view: AnnotationView) {
  const left = Math.max(0, Math.floor((rect.x - view.originX) * view.scale));
  const top = Math.max(0, Math.floor((rect.y - view.originY) * view.scale));
  const right = Math.min(
    view.canvasWidth,
    Math.ceil((rect.x + rect.w - view.originX) * view.scale),
  );
  const bottom = Math.min(
    view.canvasHeight,
    Math.ceil((rect.y + rect.h - view.originY) * view.scale),
  );
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

function pixelateRegion(
  ctx: AnnotationCanvasContext,
  rect: AnnotationRect,
  block: number,
  view: AnnotationView,
) {
  const area = deviceRect(rect, view);
  if (area.w <= 0 || area.h <= 0) return;
  const pixels = ctx.getImageData(area.x, area.y, area.w, area.h);
  pixelateImageData(pixels, Math.max(2, Math.round(block * view.scale)));
  ctx.putImageData(pixels as ImageData, area.x, area.y);
}

function drawArrow(
  ctx: AnnotationCanvasContext,
  shape: Extract<AnnotationShape, { kind: "arrow" }>,
) {
  const { from, to, width } = shape;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const head = Math.min(Math.max(width * 4, 10), length * 0.6);
  const baseX = to.x - Math.cos(angle) * head * 0.8;
  const baseY = to.y - Math.sin(angle) * head * 0.8;
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(baseX, baseY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - head * Math.cos(angle - Math.PI / 7),
    to.y - head * Math.sin(angle - Math.PI / 7),
  );
  ctx.lineTo(
    to.x - head * Math.cos(angle + Math.PI / 7),
    to.y - head * Math.sin(angle + Math.PI / 7),
  );
  ctx.closePath();
  ctx.fill();
}

function drawPen(ctx: AnnotationCanvasContext, shape: Extract<AnnotationShape, { kind: "pen" }>) {
  const [first, ...rest] = shape.points;
  if (!first) return;
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (rest.length === 0) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, shape.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  // Midpoint quadratic smoothing keeps fast strokes from looking polygonal.
  for (let index = 0; index < rest.length - 1; index += 1) {
    const point = rest[index];
    const next = rest[index + 1];
    if (!point || !next) continue;
    ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
  }
  const last = rest[rest.length - 1];
  if (last) ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

/** Black or white, whichever reads better on `color`. */
export function contrastColor(color: string) {
  const hex = color.replace("#", "");
  const r = Number.parseInt(hex.slice(0, 2), 16) || 0;
  const g = Number.parseInt(hex.slice(2, 4), 16) || 0;
  const b = Number.parseInt(hex.slice(4, 6), 16) || 0;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#111827" : "#ffffff";
}

function textFont(size: number, weight = 600) {
  return `${weight} ${size}px ${ANNOTATION_FONT_FAMILY}`;
}

function drawText(ctx: AnnotationCanvasContext, shape: TextShape) {
  ctx.font = textFont(shape.size);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, shape.size / 5);
  ctx.strokeStyle = contrastColor(shape.color);
  ctx.fillStyle = shape.color;
  const lineHeight = shape.size * 1.25;
  shape.text.split("\n").forEach((line, index) => {
    const y = shape.y + index * lineHeight;
    ctx.strokeText(line, shape.x, y);
    ctx.fillText(line, shape.x, y);
  });
}

function roundedRectPath(
  ctx: AnnotationCanvasContext,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawMarker(ctx: AnnotationCanvasContext, shape: MarkerShape) {
  const foreground = contrastColor(shape.color);
  ctx.beginPath();
  ctx.arc(shape.x, shape.y, shape.size, 0, Math.PI * 2);
  ctx.fillStyle = shape.color;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, shape.size / 7);
  ctx.strokeStyle = foreground;
  ctx.stroke();
  ctx.fillStyle = foreground;
  ctx.font = textFont(Math.round(shape.size * 1.1), 700);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(shape.n), shape.x, shape.y + shape.size * 0.05);
  const label = shape.label.replace(/\s+/gu, " ").trim();
  if (!label) return;
  // Label tag to the right of the marker.
  const fontSize = Math.round(shape.size * 0.95);
  ctx.font = textFont(fontSize, 600);
  ctx.textAlign = "left";
  const padX = fontSize * 0.5;
  const tagHeight = fontSize * 1.6;
  const textWidth = ctx.measureText(label).width;
  const tagX = shape.x + shape.size + fontSize * 0.35;
  const tagY = shape.y - tagHeight / 2;
  roundedRectPath(ctx, tagX, tagY, textWidth + padX * 2, tagHeight, tagHeight * 0.3);
  ctx.fillStyle = shape.color;
  ctx.fill();
  ctx.fillStyle = foreground;
  ctx.fillText(label, tagX + padX, shape.y + fontSize * 0.05);
}

function drawShape(ctx: AnnotationCanvasContext, shape: AnnotationShape, view: AnnotationView) {
  switch (shape.kind) {
    case "rect":
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.rect(shape.x, shape.y, shape.w, shape.h);
      ctx.stroke();
      return;
    case "arrow":
      drawArrow(ctx, shape);
      return;
    case "pen":
      drawPen(ctx, shape);
      return;
    case "text":
      drawText(ctx, shape);
      return;
    case "marker":
      drawMarker(ctx, shape);
      return;
    case "blur":
      pixelateRegion(ctx, shape, shape.block, view);
      return;
  }
}

/** Draws the image and every shape (in stacking order) through `view`. */
export function renderAnnotatedImage(
  ctx: AnnotationCanvasContext,
  options: RenderAnnotationOptions,
) {
  const { image, doc, view, background, hiddenShapeId } = options;
  ctx.save();
  applyView(ctx, view);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  if (image) ctx.drawImage(image, 0, 0, doc.width, doc.height);
  for (const shape of doc.shapes) {
    if (shape.id === hiddenShapeId) continue;
    ctx.save();
    applyView(ctx, view);
    drawShape(ctx, shape, view);
    ctx.restore();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/*  Export                                                             */
/* ------------------------------------------------------------------ */

export type AnnotationExportPlan = {
  region: AnnotationRect;
  /** Output pixels per image pixel (≤ 1: never upscaled). */
  scale: number;
  width: number;
  height: number;
};

/** Output size for the cropped region at original resolution, scaled down
 *  only as far as `maxDimension` requires. */
export function planAnnotationExport(
  doc: AnnotationDocument,
  maxDimension = ANNOTATION_EXPORT_MAX_DIMENSION,
  extraScale = 1,
): AnnotationExportPlan {
  const region = exportRegion(doc);
  const longest = Math.max(region.w, region.h);
  const scale = Math.min(1, maxDimension / longest) * Math.min(1, Math.max(0.01, extraScale));
  return {
    region,
    scale,
    width: Math.max(1, Math.round(region.w * scale)),
    height: Math.max(1, Math.round(region.h * scale)),
  };
}

export function exportView(plan: AnnotationExportPlan): AnnotationView {
  return {
    scale: plan.scale,
    originX: plan.region.x,
    originY: plan.region.y,
    canvasWidth: plan.width,
    canvasHeight: plan.height,
  };
}

export type EncodedAnnotation<TBlob extends { size: number }> = {
  blob: TBlob;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
};

export type EncodeAnnotationOptions<TCanvas, TBlob extends { size: number }> = {
  doc: AnnotationDocument;
  /** Renders the document for `plan` (JPEG passes a white background). */
  render: (plan: AnnotationExportPlan, background: string | undefined) => TCanvas;
  encode: (
    canvas: TCanvas,
    mimeType: "image/png" | "image/jpeg",
    quality?: number,
  ) => Promise<TBlob>;
  maxBytes?: number;
  maxDimension?: number;
  /** Try PNG first (lossless; right for screenshots). */
  preferPng?: boolean;
};

const JPEG_QUALITIES = [0.92, 0.85, 0.75];
const DOWNSCALE_STEP = 0.8;
const MIN_EXPORT_DIMENSION = 256;

/**
 * Encodes the annotated image within the upload limits: PNG at full size
 * when it fits, then JPEG at decreasing quality, then progressively smaller
 * JPEGs. Returns null only if even the smallest attempt is too large.
 */
export async function encodeAnnotatedImage<TCanvas, TBlob extends { size: number }>(
  options: EncodeAnnotationOptions<TCanvas, TBlob>,
): Promise<EncodedAnnotation<TBlob> | null> {
  const {
    doc,
    render,
    encode,
    maxBytes = ANNOTATION_EXPORT_MAX_BYTES,
    maxDimension = ANNOTATION_EXPORT_MAX_DIMENSION,
    preferPng = true,
  } = options;
  let plan = planAnnotationExport(doc, maxDimension);
  if (preferPng) {
    const blob = await encode(render(plan, undefined), "image/png");
    if (blob.size <= maxBytes)
      return { blob, mimeType: "image/png", width: plan.width, height: plan.height };
  }
  let canvas = render(plan, "#ffffff");
  for (const quality of JPEG_QUALITIES) {
    const blob = await encode(canvas, "image/jpeg", quality);
    if (blob.size <= maxBytes) {
      return { blob, mimeType: "image/jpeg", width: plan.width, height: plan.height };
    }
  }
  let extra = 1;
  while (Math.max(plan.width, plan.height) > MIN_EXPORT_DIMENSION) {
    extra *= DOWNSCALE_STEP;
    plan = planAnnotationExport(doc, maxDimension, extra);
    canvas = render(plan, "#ffffff");
    const blob = await encode(canvas, "image/jpeg", 0.85);
    if (blob.size <= maxBytes) {
      return { blob, mimeType: "image/jpeg", width: plan.width, height: plan.height };
    }
  }
  return null;
}

/** Working-bitmap size for an image: downscaled so the editor stays fast. */
export function workingBitmapSize(width: number, height: number) {
  const scale = Math.min(1, ANNOTATION_WORKING_MAX_DIMENSION / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/** View that fits the export region into a viewport (CSS px) at `dpr`. */
export function fitView(
  doc: Pick<AnnotationDocument, "width" | "height">,
  viewport: { width: number; height: number },
  dpr: number,
  padding = 24,
) {
  const region = { x: 0, y: 0, w: doc.width, h: doc.height };
  const fit = Math.min(
    (viewport.width - padding * 2) / region.w,
    (viewport.height - padding * 2) / region.h,
  );
  const zoom = Math.max(0.02, Math.min(fit, 8));
  return {
    zoom,
    // Pan (CSS px) that centres the image.
    panX: (viewport.width - region.w * zoom) / 2,
    panY: (viewport.height - region.h * zoom) / 2,
    dpr,
  };
}

/** Image-space hit tolerance for a pointer, in image pixels. */
export function pointerTolerance(doc: AnnotationDocument, zoom: number) {
  return Math.max(4, 6 / Math.max(zoom, 0.01)) + annotationSizeScale(doc.width, doc.height) - 1;
}
