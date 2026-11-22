// Image annotation document: shapes drawn over an attached image before it
// is sent. Coordinates are in the ORIGINAL image's pixel space, so the
// editor can work on a downscaled copy while the export renders at full
// resolution with the same numbers.

export type AnnotationPoint = { x: number; y: number };
export type AnnotationRect = { x: number; y: number; w: number; h: number };

export type AnnotationTool =
  | "select"
  | "rect"
  | "arrow"
  | "pen"
  | "text"
  | "marker"
  | "blur"
  | "crop";

type ShapeBase = { id: string };

export type RectShape = ShapeBase & AnnotationRect & { kind: "rect"; color: string; width: number };
export type ArrowShape = ShapeBase & {
  kind: "arrow";
  from: AnnotationPoint;
  to: AnnotationPoint;
  color: string;
  width: number;
};
export type PenShape = ShapeBase & {
  kind: "pen";
  points: AnnotationPoint[];
  color: string;
  width: number;
};
export type TextShape = ShapeBase & {
  kind: "text";
  x: number;
  y: number;
  text: string;
  color: string;
  /** Font size in image pixels. */
  size: number;
};
export type MarkerShape = ShapeBase & {
  kind: "marker";
  x: number;
  y: number;
  /** 1-based, kept contiguous in creation order. */
  n: number;
  label: string;
  color: string;
  /** Circle radius in image pixels. */
  size: number;
};
/** Pixelated region: everything under it at that point in the stack is
 *  replaced by block averages, so the original pixels do not survive. */
export type BlurShape = ShapeBase & AnnotationRect & { kind: "blur"; block: number };

export type AnnotationShape =
  | RectShape
  | ArrowShape
  | PenShape
  | TextShape
  | MarkerShape
  | BlurShape;
export type AnnotationShapeKind = AnnotationShape["kind"];

export type AnnotationDocument = {
  version: 1;
  /** Original image size in pixels. */
  width: number;
  height: number;
  /** Crop applied on export, in image pixels; null keeps the whole image. */
  crop: AnnotationRect | null;
  shapes: AnnotationShape[];
};

export const ANNOTATION_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#111827",
  "#ffffff",
] as const;

/** Stroke width presets, in "reference pixels" (scaled to the image size). */
export const ANNOTATION_STROKE_WIDTHS = [2, 4, 8] as const;

export const ANNOTATION_MAX_SHAPES = 500;
export const ANNOTATION_MAX_PEN_POINTS = 4000;
export const ANNOTATION_MAX_TEXT_CHARS = 500;
export const ANNOTATION_HISTORY_LIMIT = 100;
/** Smallest crop / rect / blur edge that is kept, in image pixels. */
export const ANNOTATION_MIN_REGION = 4;

/** Scale for sizes chosen in the toolbar: 1 at a 1000px long side, so a
 *  "medium" stroke looks the same on a phone screenshot and a 5K capture. */
export function annotationSizeScale(width: number, height: number) {
  return Math.max(1, Math.max(width, height) / 1000);
}

export function strokeWidthForImage(preset: number, width: number, height: number) {
  return Math.max(1, Math.round(preset * annotationSizeScale(width, height) * 10) / 10);
}

export function textSizeForImage(preset: number, width: number, height: number) {
  return Math.round((14 + preset * 3) * annotationSizeScale(width, height));
}

export function markerSizeForImage(preset: number, width: number, height: number) {
  return Math.round((11 + preset * 1.5) * annotationSizeScale(width, height));
}

/** Pixelation block: coarse enough that text under it is unreadable. */
export function blurBlockForImage(width: number, height: number) {
  return Math.max(8, Math.round(Math.max(width, height) / 100));
}

export function createAnnotationDocument(width: number, height: number): AnnotationDocument {
  return {
    version: 1,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    crop: null,
    shapes: [],
  };
}

let shapeCounter = 0;
export function nextAnnotationShapeId(kind: AnnotationShapeKind) {
  shapeCounter += 1;
  return `${kind}-${Date.now().toString(36)}-${shapeCounter.toString(36)}`;
}

/** Normalizes a drag (any direction) into a positive rect clamped to the image. */
export function rectFromPoints(
  a: AnnotationPoint,
  b: AnnotationPoint,
  bounds: { width: number; height: number },
): AnnotationRect {
  const x1 = clamp(Math.min(a.x, b.x), 0, bounds.width);
  const y1 = clamp(Math.min(a.y, b.y), 0, bounds.height);
  const x2 = clamp(Math.max(a.x, b.x), 0, bounds.width);
  const y2 = clamp(Math.max(a.y, b.y), 0, bounds.height);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function isUsableRegion(rect: AnnotationRect) {
  return rect.w >= ANNOTATION_MIN_REGION && rect.h >= ANNOTATION_MIN_REGION;
}

export function nextMarkerNumber(doc: AnnotationDocument) {
  let max = 0;
  for (const shape of doc.shapes) if (shape.kind === "marker" && shape.n > max) max = shape.n;
  return max + 1;
}

/** Markers numbered 1..N in stacking (creation) order. */
function renumberMarkers(shapes: AnnotationShape[]) {
  let n = 0;
  return shapes.map((shape) => {
    if (shape.kind !== "marker") return shape;
    n += 1;
    return shape.n === n ? shape : { ...shape, n };
  });
}

export function addShape(doc: AnnotationDocument, shape: AnnotationShape): AnnotationDocument {
  if (doc.shapes.length >= ANNOTATION_MAX_SHAPES) return doc;
  const shapes = renumberMarkers([...doc.shapes, shape]);
  return { ...doc, shapes };
}

export function updateShape(
  doc: AnnotationDocument,
  id: string,
  patch: (shape: AnnotationShape) => AnnotationShape,
): AnnotationDocument {
  let changed = false;
  const shapes = doc.shapes.map((shape) => {
    if (shape.id !== id) return shape;
    const next = patch(shape);
    if (next !== shape) changed = true;
    return next;
  });
  return changed ? { ...doc, shapes: renumberMarkers(shapes) } : doc;
}

export function removeShape(doc: AnnotationDocument, id: string): AnnotationDocument {
  const shapes = doc.shapes.filter((shape) => shape.id !== id);
  return shapes.length === doc.shapes.length ? doc : { ...doc, shapes: renumberMarkers(shapes) };
}

export function setCrop(doc: AnnotationDocument, crop: AnnotationRect | null): AnnotationDocument {
  const next = crop && isUsableRegion(crop) ? roundRect(crop, doc) : null;
  if (sameRect(next, doc.crop)) return doc;
  return { ...doc, crop: next };
}

/** The exported region (crop or the whole image). */
export function exportRegion(doc: AnnotationDocument): AnnotationRect {
  return doc.crop ?? { x: 0, y: 0, w: doc.width, h: doc.height };
}

export function isDocumentEmpty(doc: AnnotationDocument) {
  return doc.shapes.length === 0 && doc.crop === null;
}

/* ------------------------------------------------------------------ */
/*  History                                                            */
/* ------------------------------------------------------------------ */

export type AnnotationHistory = {
  past: AnnotationDocument[];
  present: AnnotationDocument;
  future: AnnotationDocument[];
};

export function createHistory(present: AnnotationDocument): AnnotationHistory {
  return { past: [], present, future: [] };
}

/** Records `next` as a new step; a no-op change records nothing. */
export function commit(history: AnnotationHistory, next: AnnotationDocument): AnnotationHistory {
  if (next === history.present) return history;
  const past = [...history.past, history.present];
  if (past.length > ANNOTATION_HISTORY_LIMIT)
    past.splice(0, past.length - ANNOTATION_HISTORY_LIMIT);
  return { past, present: next, future: [] };
}

export function undo(history: AnnotationHistory): AnnotationHistory {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: AnnotationHistory): AnnotationHistory {
  const [next, ...future] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future };
}

export const canUndo = (history: AnnotationHistory) => history.past.length > 0;
export const canRedo = (history: AnnotationHistory) => history.future.length > 0;

/* ------------------------------------------------------------------ */
/*  Marker note                                                        */
/* ------------------------------------------------------------------ */

/** "1: label" per labeled marker (in number order) and quoted free text, or
 *  "" when nothing on the image carries words. */
export function buildAnnotationNote(doc: AnnotationDocument) {
  const lines: string[] = [];
  const markers = doc.shapes
    .filter((shape): shape is MarkerShape => shape.kind === "marker")
    .sort((a, b) => a.n - b.n);
  for (const marker of markers) {
    const label = singleLine(marker.label);
    if (label) lines.push(`${marker.n}: ${label}`);
  }
  for (const shape of doc.shapes) {
    if (shape.kind !== "text") continue;
    const text = singleLine(shape.text);
    if (text) lines.push(`Text on image: "${text}"`);
  }
  return lines.join("\n");
}

function singleLine(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

/* ------------------------------------------------------------------ */
/*  Serialization                                                      */
/* ------------------------------------------------------------------ */

export function serializeAnnotationDocument(doc: AnnotationDocument) {
  return JSON.stringify(doc);
}

/** Parses and validates a stored document. Invalid shapes are dropped and
 *  coordinates clamped; returns null when the document itself is unusable. */
export function parseAnnotationDocument(raw: unknown): AnnotationDocument | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  const width = positiveInt(record.width);
  const height = positiveInt(record.height);
  if (!width || !height) return null;
  const bounds = { width, height };
  const shapes: AnnotationShape[] = [];
  if (Array.isArray(record.shapes)) {
    for (const item of record.shapes.slice(0, ANNOTATION_MAX_SHAPES)) {
      const shape = parseShape(item, bounds);
      if (shape) shapes.push(shape);
    }
  }
  const cropRect = parseRect(record.crop, bounds);
  return {
    version: 1,
    width,
    height,
    crop: cropRect && isUsableRegion(cropRect) ? cropRect : null,
    shapes: renumberMarkers(shapes),
  };
}

const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

function parseColor(value: unknown) {
  return typeof value === "string" && COLOR_PATTERN.test(value) ? value.toLowerCase() : null;
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInt(value: unknown) {
  const number = finite(value);
  return number !== null && number >= 1 && number <= 100_000 ? Math.round(number) : null;
}

function parsePoint(value: unknown, bounds: { width: number; height: number }) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = finite(record.x);
  const y = finite(record.y);
  if (x === null || y === null) return null;
  return { x: clamp(x, 0, bounds.width), y: clamp(y, 0, bounds.height) };
}

function parseRect(value: unknown, bounds: { width: number; height: number }) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = finite(record.x);
  const y = finite(record.y);
  const w = finite(record.w);
  const h = finite(record.h);
  if (x === null || y === null || w === null || h === null) return null;
  return rectFromPoints({ x, y }, { x: x + w, y: y + h }, bounds);
}

function parseSize(value: unknown, max: number) {
  const number = finite(value);
  return number !== null && number > 0 ? Math.min(number, max) : null;
}

function parseShape(value: unknown, bounds: { width: number; height: number }) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id ? record.id.slice(0, 64) : null;
  if (!id) return null;
  const color = parseColor(record.color);
  const sizeCap = Math.max(bounds.width, bounds.height);
  switch (record.kind) {
    case "rect": {
      const rect = parseRect(record, bounds);
      const width = parseSize(record.width, sizeCap);
      return rect && color && width
        ? ({ id, kind: "rect", ...rect, color, width } as RectShape)
        : null;
    }
    case "blur": {
      const rect = parseRect(record, bounds);
      const block = parseSize(record.block, sizeCap);
      return rect && block
        ? ({ id, kind: "blur", ...rect, block: Math.max(2, Math.round(block)) } as BlurShape)
        : null;
    }
    case "arrow": {
      const from = parsePoint(record.from, bounds);
      const to = parsePoint(record.to, bounds);
      const width = parseSize(record.width, sizeCap);
      return from && to && color && width
        ? ({ id, kind: "arrow", from, to, color, width } as ArrowShape)
        : null;
    }
    case "pen": {
      const width = parseSize(record.width, sizeCap);
      if (!Array.isArray(record.points) || !color || !width) return null;
      const points = record.points
        .slice(0, ANNOTATION_MAX_PEN_POINTS)
        .map((point) => parsePoint(point, bounds))
        .filter((point): point is AnnotationPoint => point !== null);
      return points.length > 0 ? ({ id, kind: "pen", points, color, width } as PenShape) : null;
    }
    case "text": {
      const at = parsePoint(record, bounds);
      const size = parseSize(record.size, sizeCap);
      const text =
        typeof record.text === "string" ? record.text.slice(0, ANNOTATION_MAX_TEXT_CHARS) : "";
      return at && size && color && text.trim()
        ? ({ id, kind: "text", ...at, text, color, size } as TextShape)
        : null;
    }
    case "marker": {
      const at = parsePoint(record, bounds);
      const size = parseSize(record.size, sizeCap);
      const label =
        typeof record.label === "string" ? record.label.slice(0, ANNOTATION_MAX_TEXT_CHARS) : "";
      return at && size && color
        ? ({ id, kind: "marker", ...at, n: 0, label, color, size } as MarkerShape)
        : null;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundRect(rect: AnnotationRect, bounds: { width: number; height: number }) {
  const x = clamp(Math.round(rect.x), 0, bounds.width - 1);
  const y = clamp(Math.round(rect.y), 0, bounds.height - 1);
  const w = clamp(Math.round(rect.w), 1, bounds.width - x);
  const h = clamp(Math.round(rect.h), 1, bounds.height - y);
  return { x, y, w, h };
}

function sameRect(a: AnnotationRect | null, b: AnnotationRect | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Distance from point `p` to segment `a`-`b`. */
function distanceToSegment(p: AnnotationPoint, a: AnnotationPoint, b: AnnotationPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Topmost shape under `point` (within `tolerance` image pixels), for the
 *  eraser-free "select and delete" flow. */
export function hitTestShape(
  doc: AnnotationDocument,
  point: AnnotationPoint,
  tolerance: number,
): AnnotationShape | null {
  for (let index = doc.shapes.length - 1; index >= 0; index -= 1) {
    const shape = doc.shapes[index];
    if (!shape) continue;
    switch (shape.kind) {
      case "rect":
      case "blur": {
        const inside =
          point.x >= shape.x - tolerance &&
          point.x <= shape.x + shape.w + tolerance &&
          point.y >= shape.y - tolerance &&
          point.y <= shape.y + shape.h + tolerance;
        if (inside) return shape;
        break;
      }
      case "arrow":
        if (distanceToSegment(point, shape.from, shape.to) <= tolerance + shape.width) return shape;
        break;
      case "pen":
        for (let i = 0; i < shape.points.length; i += 1) {
          const a = shape.points[i];
          const b = shape.points[i + 1] ?? a;
          if (a && b && distanceToSegment(point, a, b) <= tolerance + shape.width) return shape;
        }
        break;
      case "marker":
        if (Math.hypot(point.x - shape.x, point.y - shape.y) <= shape.size + tolerance)
          return shape;
        break;
      case "text": {
        const lines = shape.text.split("\n");
        const longest = Math.max(...lines.map((line) => line.length));
        const width = longest * shape.size * 0.6;
        const height = lines.length * shape.size * 1.25;
        if (
          point.x >= shape.x - tolerance &&
          point.x <= shape.x + width + tolerance &&
          point.y >= shape.y - tolerance &&
          point.y <= shape.y + height + tolerance
        ) {
          return shape;
        }
        break;
      }
    }
  }
  return null;
}

/** Moves a shape by (dx, dy) image pixels, clamped so it stays on the image. */
export function translateShape(
  shape: AnnotationShape,
  dx: number,
  dy: number,
  bounds: { width: number; height: number },
): AnnotationShape {
  const move = (point: AnnotationPoint) => ({
    x: clamp(point.x + dx, 0, bounds.width),
    y: clamp(point.y + dy, 0, bounds.height),
  });
  switch (shape.kind) {
    case "rect":
    case "blur":
      return {
        ...shape,
        x: clamp(shape.x + dx, 0, bounds.width - shape.w),
        y: clamp(shape.y + dy, 0, bounds.height - shape.h),
      };
    case "arrow":
      return { ...shape, from: move(shape.from), to: move(shape.to) };
    case "pen":
      return { ...shape, points: shape.points.map(move) };
    default:
      return { ...shape, ...move(shape) };
  }
}
