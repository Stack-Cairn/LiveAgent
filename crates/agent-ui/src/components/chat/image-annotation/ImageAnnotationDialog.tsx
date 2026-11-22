import {
  Crop,
  Grid3x3,
  Hash,
  Loader2,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Redo2,
  RotateCcw,
  Scan,
  Square,
  Trash2,
  TypeIcon,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@liveagent/ui/components/ui/toggle-group";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  ANNOTATION_COLORS,
  ANNOTATION_STROKE_WIDTHS,
  type AnnotationDocument,
  type AnnotationHistory,
  type AnnotationPoint,
  type AnnotationShape,
  type AnnotationTool,
  addShape,
  blurBlockForImage,
  buildAnnotationNote,
  canRedo,
  canUndo,
  clamp,
  commit,
  createAnnotationDocument,
  createHistory,
  hitTestShape,
  isUsableRegion,
  markerSizeForImage,
  nextAnnotationShapeId,
  nextMarkerNumber,
  rectFromPoints,
  redo,
  removeShape,
  setCrop,
  strokeWidthForImage,
  textSizeForImage,
  translateShape,
  undo,
  updateShape,
} from "@liveagent/ui/lib/chat/imageAnnotation/model";
import {
  type AnnotationCanvasContext,
  type AnnotationView,
  encodeAnnotatedImage,
  exportView,
  fitView,
  pointerTolerance,
  renderAnnotatedImage,
  workingBitmapSize,
} from "@liveagent/ui/lib/chat/imageAnnotation/render";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type ImageAnnotationResult = {
  blob: Blob;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  document: AnnotationDocument;
  /** Marker labels / free text as "1: label" lines ("" when none). */
  note: string;
  includeNote: boolean;
};

export type ImageAnnotationDialogProps = {
  open: boolean;
  /** URL of the ORIGINAL image (data:, blob: or same-origin). */
  imageSrc: string | null;
  fileName: string;
  /** Re-editing: the document saved last time, applied to the original. */
  initialDocument?: AnnotationDocument | null;
  initialIncludeNote?: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (result: ImageAnnotationResult) => Promise<void> | void;
};

type ViewState = { zoom: number; panX: number; panY: number };

type Draft =
  | { kind: "shape"; shape: AnnotationShape }
  | { kind: "crop"; start: AnnotationPoint; end: AnnotationPoint }
  | { kind: "move"; id: string; start: AnnotationPoint; doc: AnnotationDocument }
  | { kind: "pan"; startX: number; startY: number; view: ViewState };

type TextEntry = {
  /** "text"/"marker": a new shape; "edit": rewriting an existing one. */
  mode: "text" | "marker" | "edit";
  shapeId?: string;
  x: number;
  y: number;
  value: string;
};

const TOOLS: { tool: AnnotationTool; key: string; Icon: typeof Square }[] = [
  { tool: "select", key: "v", Icon: MousePointer2 },
  { tool: "rect", key: "r", Icon: Square },
  { tool: "arrow", key: "a", Icon: MoveUpRight },
  { tool: "pen", key: "p", Icon: Pencil },
  { tool: "text", key: "t", Icon: TypeIcon },
  { tool: "marker", key: "n", Icon: Hash },
  { tool: "blur", key: "b", Icon: Grid3x3 },
  { tool: "crop", key: "c", Icon: Crop },
];

const COLOR_KEYS = ["red", "amber", "green", "blue", "purple", "black", "white"] as const;
const STROKE_KEYS = ["thin", "medium", "thick"] as const;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 16;

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image load failed"));
    image.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))),
      type,
      quality,
    );
  });
}

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT")
  );
}

/**
 * Full-size image annotation editor in the shared Dialog: rectangle, arrow,
 * pen, text, numbered markers, blur (pixelate) and crop, with colour/stroke
 * pickers, undo/redo, zoom/pan and keyboard shortcuts. Edits happen on a
 * downscaled working bitmap at device-pixel resolution; Save re-renders the
 * document from the original image at full resolution.
 */
export function ImageAnnotationDialog(props: ImageAnnotationDialogProps) {
  const { open, onOpenChange } = props;
  const { t } = useLocale();
  const escapeHandlerRef = useRef<(() => boolean) | null>(null);
  const savingRef = useRef(false);
  return (
    <Dialog
      open={open}
      disablePointerDismissal
      onOpenChange={(next, details) => {
        if (next) return onOpenChange(true);
        if (savingRef.current) return;
        // Escape first unwinds editor state (text entry, drag, selection).
        if (details?.reason === "escape-key" && escapeHandlerRef.current?.()) return;
        onOpenChange(false);
      }}
    >
      <DialogContent
        layout="fullscreen-mobile"
        showCloseButton
        closeLabel={t("chat.annotate.cancel")}
        className="flex h-[min(56rem,calc(100dvh-2rem))] max-w-[min(80rem,calc(100vw-2rem))] flex-col p-0"
        data-image-annotation-dialog=""
      >
        {open ? (
          <ImageAnnotationEditor
            {...props}
            escapeHandlerRef={escapeHandlerRef}
            savingRef={savingRef}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ImageAnnotationEditor(
  props: ImageAnnotationDialogProps & {
    escapeHandlerRef: { current: (() => boolean) | null };
    savingRef: { current: boolean };
  },
) {
  const {
    imageSrc,
    fileName,
    initialDocument,
    initialIncludeNote = true,
    onOpenChange,
    onSave,
    escapeHandlerRef,
    savingRef,
  } = props;
  const { t } = useLocale();
  const includeNoteId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textEntryRef = useRef<HTMLTextAreaElement | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [working, setWorking] = useState<HTMLCanvasElement | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [history, setHistory] = useState<AnnotationHistory | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("rect");
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0]);
  const [strokeIndex, setStrokeIndex] = useState(1);
  const [view, setView] = useState<ViewState | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textEntry, setTextEntry] = useState<TextEntry | null>(null);
  const [includeNote, setIncludeNote] = useState(initialIncludeNote);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [draftTick, setDraftTick] = useState(0);
  const spaceHeldRef = useRef(false);
  const userZoomedRef = useRef(false);
  const doc = history?.present ?? null;

  // ---- Sizes for new shapes ----
  const strokePreset = ANNOTATION_STROKE_WIDTHS[strokeIndex] ?? 4;
  const sizes = useMemo(() => {
    if (!doc) return null;
    return {
      stroke: strokeWidthForImage(strokePreset, doc.width, doc.height),
      text: textSizeForImage(strokePreset, doc.width, doc.height),
      marker: markerSizeForImage(strokePreset, doc.width, doc.height),
      block: blurBlockForImage(doc.width, doc.height),
    };
  }, [doc, strokePreset]);

  // ---- Load the original and build the downscaled working bitmap ----
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    if (!imageSrc) {
      setLoadFailed(true);
      return;
    }
    loadImage(imageSrc)
      .then((loaded) => {
        if (cancelled) return;
        const width = loaded.naturalWidth;
        const height = loaded.naturalHeight;
        if (!width || !height) throw new Error("empty image");
        const size = workingBitmapSize(width, height);
        const bitmap = document.createElement("canvas");
        bitmap.width = size.width;
        bitmap.height = size.height;
        const ctx = bitmap.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(loaded, 0, 0, size.width, size.height);
        }
        const restored =
          initialDocument && initialDocument.width === width && initialDocument.height === height
            ? initialDocument
            : createAnnotationDocument(width, height);
        setImage(loaded);
        setWorking(bitmap);
        setHistory(createHistory(restored));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [imageSrc, initialDocument]);

  // ---- Stage size (CSS px) ----
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const box = stage.getBoundingClientRect();
      setStageSize((current) =>
        current.width === box.width && current.height === box.height
          ? current
          : { width: box.width, height: box.height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const docWidth = doc?.width ?? 0;
  const docHeight = doc?.height ?? 0;
  const fit = useCallback(() => {
    if (!docWidth || !docHeight || stageSize.width <= 0 || stageSize.height <= 0) return;
    const next = fitView({ width: docWidth, height: docHeight }, stageSize, 1);
    setView({ zoom: next.zoom, panX: next.panX, panY: next.panY });
  }, [docWidth, docHeight, stageSize]);

  // Fit on load and on resize until the user zooms or pans.
  useEffect(() => {
    if (!userZoomedRef.current) fit();
  }, [fit]);

  // ---- Drawing ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !doc || !view || !working) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const width = Math.max(1, Math.round(stageSize.width * dpr));
    const height = Math.max(1, Math.round(stageSize.height * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
      | (CanvasRenderingContext2D & AnnotationCanvasContext)
      | null;
    if (!ctx) return;
    const renderView: AnnotationView = {
      scale: view.zoom * dpr,
      originX: -view.panX / view.zoom,
      originY: -view.panY / view.zoom,
      canvasWidth: width,
      canvasHeight: height,
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const draft = draftRef.current;
    let shown = doc;
    if (draft?.kind === "shape") shown = { ...doc, shapes: [...doc.shapes, draft.shape] };
    if (textEntry?.mode === "marker" && sizes) {
      // The marker being labelled shows at its final number while typing.
      const pending: AnnotationShape = {
        id: "pending-marker",
        kind: "marker",
        x: textEntry.x,
        y: textEntry.y,
        n: nextMarkerNumber(doc),
        label: "",
        color,
        size: sizes.marker,
      };
      shown = { ...shown, shapes: [...shown.shapes, pending] };
    }
    renderAnnotatedImage(ctx, {
      image: working,
      doc: shown,
      view: renderView,
      hiddenShapeId: textEntry?.mode === "edit" ? textEntry.shapeId : null,
    });
    // Overlays in image space.
    ctx.save();
    ctx.setTransform(
      renderView.scale,
      0,
      0,
      renderView.scale,
      -renderView.originX * renderView.scale,
      -renderView.originY * renderView.scale,
    );
    const hairline = 1 / renderView.scale;
    const crop =
      draft?.kind === "crop" ? rectFromPoints(draft.start, draft.end, doc) : (doc.crop ?? null);
    if (crop) {
      ctx.beginPath();
      ctx.rect(0, 0, doc.width, doc.height);
      ctx.rect(crop.x, crop.y, crop.w, crop.h);
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fill("evenodd");
      ctx.setLineDash([6 * hairline, 4 * hairline]);
      ctx.lineWidth = 1.5 * hairline;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
      ctx.setLineDash([]);
    }
    const selected = selectedId ? doc.shapes.find((shape) => shape.id === selectedId) : null;
    if (selected && tool === "select") {
      const bounds = shapeBounds(ctx, selected);
      ctx.setLineDash([4 * hairline, 3 * hairline]);
      ctx.lineWidth = 1.5 * hairline;
      ctx.strokeStyle = "#3b82f6";
      const pad = 4 * hairline;
      ctx.strokeRect(bounds.x - pad, bounds.y - pad, bounds.w + pad * 2, bounds.h + pad * 2);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }, [doc, view, working, stageSize, selectedId, tool, textEntry, sizes, color]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: draftTick redraws the in-progress shape without re-creating draw.
  useEffect(() => {
    const frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [draw, draftTick]);

  const redrawDraft = useCallback(() => setDraftTick((tick) => tick + 1), []);

  // ---- History helpers ----
  const apply = useCallback((update: (current: AnnotationDocument) => AnnotationDocument) => {
    setHistory((current) => (current ? commit(current, update(current.present)) : current));
  }, []);
  const handleUndo = useCallback(() => {
    setSelectedId(null);
    setHistory((current) => (current ? undo(current) : current));
  }, []);
  const handleRedo = useCallback(() => {
    setSelectedId(null);
    setHistory((current) => (current ? redo(current) : current));
  }, []);

  // ---- Coordinates / zoom ----
  const toImagePoint = useCallback(
    (clientX: number, clientY: number): AnnotationPoint | null => {
      const canvas = canvasRef.current;
      if (!canvas || !view) return null;
      const box = canvas.getBoundingClientRect();
      return {
        x: (clientX - box.left - view.panX) / view.zoom,
        y: (clientY - box.top - view.panY) / view.zoom,
      };
    },
    [view],
  );

  const zoomAt = useCallback(
    (factor: number, anchor?: { x: number; y: number }) => {
      setView((current) => {
        if (!current) return current;
        const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const cx = anchor?.x ?? stageSize.width / 2;
        const cy = anchor?.y ?? stageSize.height / 2;
        const ratio = zoom / current.zoom;
        return {
          zoom,
          panX: cx - (cx - current.panX) * ratio,
          panY: cy - (cy - current.panY) * ratio,
        };
      });
      userZoomedRef.current = true;
    },
    [stageSize],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const box = canvas.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * 0.01), {
          x: event.clientX - box.left,
          y: event.clientY - box.top,
        });
        return;
      }
      userZoomedRef.current = true;
      setView((current) =>
        current
          ? { ...current, panX: current.panX - event.deltaX, panY: current.panY - event.deltaY }
          : current,
      );
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ---- Text entry ----
  // Enter/Escape close the field, and its unmount then fires blur with the
  // same entry: commit each entry once so a marker is not added twice.
  const committedEntryRef = useRef<TextEntry | null>(null);
  const commitTextEntry = useCallback(
    (entry: TextEntry | null, cancelled = false) => {
      if (!entry || !doc || !sizes || committedEntryRef.current === entry) return;
      committedEntryRef.current = entry;
      setTextEntry(null);
      const value = entry.value.replace(/\r\n?/g, "\n");
      if (entry.mode === "edit" && entry.shapeId) {
        const id = entry.shapeId;
        if (cancelled) return;
        apply((current) => {
          const shape = current.shapes.find((item) => item.id === id);
          if (shape?.kind === "text" && !value.trim()) return removeShape(current, id);
          return updateShape(current, id, (item) => {
            if (item.kind === "text") return item.text === value ? item : { ...item, text: value };
            if (item.kind === "marker") {
              const label = value.replace(/\s+/gu, " ").trim();
              return item.label === label ? item : { ...item, label };
            }
            return item;
          });
        });
        return;
      }
      if (entry.mode === "text") {
        if (cancelled || !value.trim()) return;
        const shape: AnnotationShape = {
          id: nextAnnotationShapeId("text"),
          kind: "text",
          x: entry.x,
          y: entry.y,
          text: value,
          color,
          size: sizes.text,
        };
        apply((current) => addShape(current, shape));
        return;
      }
      // Marker: the click placed it; Escape only drops the label.
      const shape: AnnotationShape = {
        id: nextAnnotationShapeId("marker"),
        kind: "marker",
        x: entry.x,
        y: entry.y,
        n: nextMarkerNumber(doc),
        label: cancelled ? "" : value.replace(/\s+/gu, " ").trim(),
        color,
        size: sizes.marker,
      };
      apply((current) => addShape(current, shape));
    },
    [apply, color, doc, sizes],
  );

  useEffect(() => {
    if (!textEntry) return;
    const field = textEntryRef.current;
    if (field && document.activeElement !== field) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }, [textEntry]);

  // ---- Escape unwinding (called by the Dialog before it closes) ----
  const lastInnerEscapeRef = useRef(0);
  escapeHandlerRef.current = () => {
    if (Date.now() - lastInnerEscapeRef.current < 250) return true;
    if (textEntry) {
      commitTextEntry(textEntry, true);
      return true;
    }
    if (draftRef.current) {
      draftRef.current = null;
      redrawDraft();
      return true;
    }
    if (selectedId) {
      setSelectedId(null);
      return true;
    }
    return false;
  };
  savingRef.current = saving;

  // ---- Pointer input ----
  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!doc || !sizes || !view || saving) return;
    if (textEntry) {
      commitTextEntry(textEntry);
      return;
    }
    const point = toImagePoint(event.clientX, event.clientY);
    if (!point) return;
    const pan = event.button === 1 || spaceHeldRef.current;
    if (event.button !== 0 && !pan) return;
    event.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pan) {
      draftRef.current = { kind: "pan", startX: event.clientX, startY: event.clientY, view };
      return;
    }
    const inside = point.x >= 0 && point.y >= 0 && point.x <= doc.width && point.y <= doc.height;
    const at = { x: clamp(point.x, 0, doc.width), y: clamp(point.y, 0, doc.height) };
    switch (tool) {
      case "select": {
        const hit = hitTestShape(doc, point, pointerTolerance(doc, view.zoom));
        setSelectedId(hit?.id ?? null);
        if (hit) draftRef.current = { kind: "move", id: hit.id, start: point, doc };
        else draftRef.current = { kind: "pan", startX: event.clientX, startY: event.clientY, view };
        return;
      }
      case "text":
      case "marker":
        if (!inside) return;
        setTextEntry({ mode: tool, x: at.x, y: at.y, value: "" });
        return;
      case "crop":
        draftRef.current = { kind: "crop", start: at, end: at };
        return;
      case "pen":
        draftRef.current = {
          kind: "shape",
          shape: {
            id: nextAnnotationShapeId("pen"),
            kind: "pen",
            points: [at],
            color,
            width: sizes.stroke,
          },
        };
        redrawDraft();
        return;
      case "arrow":
        draftRef.current = {
          kind: "shape",
          shape: {
            id: nextAnnotationShapeId("arrow"),
            kind: "arrow",
            from: at,
            to: at,
            color,
            width: sizes.stroke,
          },
        };
        return;
      case "rect":
        draftRef.current = {
          kind: "shape",
          shape: {
            id: nextAnnotationShapeId("rect"),
            kind: "rect",
            ...at,
            w: 0,
            h: 0,
            color,
            width: sizes.stroke,
          },
        };
        return;
      case "blur":
        draftRef.current = {
          kind: "shape",
          shape: {
            id: nextAnnotationShapeId("blur"),
            kind: "blur",
            ...at,
            w: 0,
            h: 0,
            block: sizes.block,
          },
        };
        return;
    }
  };

  const dragStartRef = useRef<AnnotationPoint | null>(null);
  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current;
    if (!draft || !doc || !view) return;
    if (draft.kind === "pan") {
      userZoomedRef.current = true;
      setView({
        ...draft.view,
        panX: draft.view.panX + event.clientX - draft.startX,
        panY: draft.view.panY + event.clientY - draft.startY,
      });
      return;
    }
    const point = toImagePoint(event.clientX, event.clientY);
    if (!point) return;
    const at = { x: clamp(point.x, 0, doc.width), y: clamp(point.y, 0, doc.height) };
    if (draft.kind === "crop") {
      draftRef.current = { ...draft, end: at };
    } else if (draft.kind === "move") {
      const dx = point.x - draft.start.x;
      const dy = point.y - draft.start.y;
      const moved = updateShape(draft.doc, draft.id, (shape) => translateShape(shape, dx, dy, doc));
      setHistory((current) => (current ? { ...current, present: moved } : current));
      return;
    } else if (draft.kind === "shape") {
      const shape = draft.shape;
      if (shape.kind === "pen") {
        const last = shape.points[shape.points.length - 1];
        const minGap = 1.5 / view.zoom;
        if (!last || Math.hypot(last.x - at.x, last.y - at.y) >= minGap) {
          shape.points = [...shape.points, at];
        }
      } else if (shape.kind === "arrow") {
        draftRef.current = { kind: "shape", shape: { ...shape, to: at } };
      } else if (shape.kind === "rect" || shape.kind === "blur") {
        const start = dragStartRef.current ?? { x: shape.x, y: shape.y };
        dragStartRef.current = start;
        draftRef.current = {
          kind: "shape",
          shape: { ...shape, ...rectFromPoints(start, at, doc) },
        };
      }
    }
    redrawDraft();
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current;
    draftRef.current = null;
    dragStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!draft || !doc) return;
    if (draft.kind === "crop") {
      const rect = rectFromPoints(draft.start, draft.end, doc);
      if (isUsableRegion(rect)) apply((current) => setCrop(current, rect));
      redrawDraft();
      return;
    }
    if (draft.kind === "move") {
      const moved = doc;
      // Restore the pre-drag state, then commit the move as one step.
      setHistory((current) =>
        current ? commit({ ...current, present: draft.doc }, moved) : current,
      );
      return;
    }
    if (draft.kind !== "shape") return;
    const shape = draft.shape;
    const keep =
      shape.kind === "pen"
        ? shape.points.length > 0
        : shape.kind === "arrow"
          ? Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) >= 4
          : shape.kind === "rect" || shape.kind === "blur"
            ? isUsableRegion(shape)
            : true;
    if (keep) apply((current) => addShape(current, shape));
    redrawDraft();
  };

  // ---- Keyboard ----
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === " " && !isTypingTarget(event.target)) {
      spaceHeldRef.current = true;
      if (event.target === rootRef.current) event.preventDefault();
      return;
    }
    if (isTypingTarget(event.target) || event.nativeEvent.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) handleRedo();
      else handleUndo();
      return;
    }
    if (mod && key === "y") {
      event.preventDefault();
      handleRedo();
      return;
    }
    if (mod || event.altKey) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
      event.preventDefault();
      const id = selectedId;
      setSelectedId(null);
      apply((current) => removeShape(current, id));
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAt(1.25);
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomAt(0.8);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      userZoomedRef.current = false;
      fit();
      return;
    }
    // Only plain letter presses on the editor itself (not on a focused
    // toolbar button, where the letter could be meant for it).
    const entry = TOOLS.find((item) => item.key === key);
    if (entry && !event.shiftKey) {
      event.preventDefault();
      setTool(entry.tool);
      if (entry.tool !== "select") setSelectedId(null);
    }
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") spaceHeldRef.current = false;
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!doc || !view || tool !== "select") return;
    const point = toImagePoint(event.clientX, event.clientY);
    if (!point) return;
    const hit = hitTestShape(doc, point, pointerTolerance(doc, view.zoom));
    if (hit?.kind === "text" || hit?.kind === "marker") {
      setTextEntry({
        mode: "edit",
        shapeId: hit.id,
        x: hit.x,
        y: hit.y,
        value: hit.kind === "text" ? hit.text : hit.label,
      });
    }
  };

  // ---- Save ----
  const note = doc ? buildAnnotationNote(doc) : "";
  const handleSave = async () => {
    if (!doc || !image || saving) return;
    if (textEntry) commitTextEntry(textEntry);
    setSaving(true);
    setError(null);
    try {
      const finalDoc = doc;
      const encoded = await encodeAnnotatedImage({
        doc: finalDoc,
        render: (plan, background) => {
          const canvas = document.createElement("canvas");
          canvas.width = plan.width;
          canvas.height = plan.height;
          const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
            | (CanvasRenderingContext2D & AnnotationCanvasContext)
            | null;
          if (!ctx) throw new Error("no 2d context");
          ctx.imageSmoothingQuality = "high";
          renderAnnotatedImage(ctx, { image, doc: finalDoc, view: exportView(plan), background });
          return canvas;
        },
        encode: canvasToBlob,
      });
      if (!encoded) {
        setError(t("chat.annotate.tooLarge"));
        return;
      }
      await onSave({
        ...encoded,
        document: finalDoc,
        note: buildAnnotationNote(finalDoc),
        includeNote,
      });
      onOpenChange(false);
    } catch {
      setError(t("chat.annotate.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const textEntryStyle = (() => {
    if (!textEntry || !view || !sizes || !doc) return null;
    const shape = textEntry.shapeId
      ? doc.shapes.find((item) => item.id === textEntry.shapeId)
      : null;
    const isMarker = textEntry.mode === "marker" || shape?.kind === "marker";
    const shapeSize = shape?.kind === "text" || shape?.kind === "marker" ? shape.size : null;
    const markerSize = shapeSize ?? sizes.marker;
    const fontPx = Math.max(
      12,
      Math.min(28, (shapeSize ?? (isMarker ? sizes.marker : sizes.text)) * view.zoom),
    );
    const left = textEntry.x * view.zoom + view.panX + (isMarker ? markerSize * view.zoom + 6 : 0);
    const top = textEntry.y * view.zoom + view.panY - (isMarker ? fontPx : 0);
    return { left, top, fontPx, isMarker };
  })();

  const toolLabel = (item: AnnotationTool) => t(`chat.annotate.tool.${item}`);
  const zoomPercent = view ? Math.round(view.zoom * 100) : 100;

  return (
    <>
      <DialogHeader className="flex items-center gap-3 border-b border-border/60 pr-14">
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate">{t("chat.annotate.title")}</DialogTitle>
          <DialogDescription className="mt-0.5 truncate text-xs" title={fileName}>
            {fileName}
          </DialogDescription>
        </div>
      </DialogHeader>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the editor root owns the single-key tool shortcuts and Space-to-pan; every control inside keeps its own semantics. */}
      <div
        ref={rootRef}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none"
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        data-image-annotation-editor=""
      >
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-3 py-2"
          role="toolbar"
          aria-label={t("chat.annotate.toolbar")}
        >
          <ToggleGroup
            value={[tool]}
            onValueChange={(values) => {
              const next = values[0] as AnnotationTool | undefined;
              if (next) setTool(next);
              if (next !== "select") setSelectedId(null);
            }}
            aria-label={t("chat.annotate.tools")}
            className="gap-0.5 rounded-lg bg-muted/60 p-0.5"
          >
            {TOOLS.map(({ tool: item, key, Icon }) => (
              <ToggleGroupItem
                key={item}
                value={item}
                aria-label={`${toolLabel(item)} (${key.toUpperCase()})`}
                title={`${toolLabel(item)} (${key.toUpperCase()})`}
                data-annotation-tool={item}
                className="size-8 text-muted-foreground hover:bg-background/70 hover:text-foreground data-[pressed]:bg-background data-[pressed]:text-foreground data-[pressed]:shadow-sm"
              >
                <Icon className="size-4" aria-hidden="true" />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <fieldset
            className="m-0 min-w-0 border-0 p-0 flex items-center gap-1"
            aria-label={t("chat.annotate.color")}
          >
            {ANNOTATION_COLORS.map((value, index) => (
              <button
                key={value}
                type="button"
                aria-pressed={color === value}
                aria-label={t(`chat.annotate.colors.${COLOR_KEYS[index]}`)}
                title={t(`chat.annotate.colors.${COLOR_KEYS[index]}`)}
                data-annotation-color={value}
                className={cn(
                  "size-6 rounded-full border border-foreground/20 outline-none transition-transform",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  color === value && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                )}
                style={{ backgroundColor: value }}
                onClick={() => setColor(value)}
              />
            ))}
          </fieldset>

          <fieldset
            className="m-0 min-w-0 border-0 p-0 flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5"
            aria-label={t("chat.annotate.stroke")}
          >
            {ANNOTATION_STROKE_WIDTHS.map((width, index) => (
              <button
                key={width}
                type="button"
                aria-pressed={strokeIndex === index}
                aria-label={t(`chat.annotate.strokes.${STROKE_KEYS[index]}`)}
                title={t(`chat.annotate.strokes.${STROKE_KEYS[index]}`)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none",
                  "hover:bg-background/70 focus-visible:ring-2 focus-visible:ring-ring",
                  strokeIndex === index && "bg-background text-foreground shadow-sm",
                )}
                onClick={() => setStrokeIndex(index)}
              >
                <span
                  aria-hidden="true"
                  className="block w-4 rounded-full bg-current"
                  style={{ height: Math.max(1, width / 1.5) }}
                />
              </button>
            ))}
          </fieldset>

          <div className="ml-auto flex items-center gap-0.5">
            {tool === "select" && selectedId ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("chat.annotate.deleteShape")}
                title={t("chat.annotate.deleteShape")}
                onClick={() => {
                  const id = selectedId;
                  setSelectedId(null);
                  apply((current) => removeShape(current, id));
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            ) : null}
            {doc?.crop ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={() => apply((current) => setCrop(current, null))}
              >
                <RotateCcw className="size-3.5" />
                {t("chat.annotate.resetCrop")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.annotate.undo")}
              title={`${t("chat.annotate.undo")} (Ctrl/⌘+Z)`}
              disabled={!history || !canUndo(history)}
              onClick={handleUndo}
            >
              <Undo2 className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.annotate.redo")}
              title={`${t("chat.annotate.redo")} (Shift+Ctrl/⌘+Z)`}
              disabled={!history || !canRedo(history)}
              onClick={handleRedo}
            >
              <Redo2 className="size-4" />
            </Button>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.annotate.zoomOut")}
              title={`${t("chat.annotate.zoomOut")} (-)`}
              onClick={() => zoomAt(0.8)}
            >
              <ZoomOut className="size-4" />
            </Button>
            <span
              className="w-12 text-center text-xs tabular-nums text-muted-foreground"
              aria-live="polite"
            >
              {zoomPercent}%
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.annotate.zoomIn")}
              title={`${t("chat.annotate.zoomIn")} (+)`}
              onClick={() => zoomAt(1.25)}
            >
              <ZoomIn className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.annotate.zoomFit")}
              title={`${t("chat.annotate.zoomFit")} (0)`}
              onClick={() => {
                userZoomedRef.current = false;
                fit();
              }}
            >
              <Scan className="size-4" />
            </Button>
          </div>
        </div>

        <div
          ref={stageRef}
          className="relative min-h-0 flex-1 overflow-hidden bg-muted/40"
          data-annotation-stage=""
        >
          <canvas
            ref={canvasRef}
            className={cn(
              "absolute inset-0 size-full touch-none select-none",
              tool === "select"
                ? "cursor-default"
                : tool === "text"
                  ? "cursor-text"
                  : "cursor-crosshair",
            )}
            aria-label={t("chat.annotate.canvas")}
            role="img"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onDoubleClick={handleDoubleClick}
          />
          {!doc && !loadFailed ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" aria-label={t("chat.annotate.loading")} />
            </div>
          ) : null}
          {loadFailed ? (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-destructive">
              {t("chat.annotate.loadFailed")}
            </div>
          ) : null}
          {textEntry && textEntryStyle ? (
            <textarea
              ref={textEntryRef}
              data-annotation-text-entry=""
              value={textEntry.value}
              rows={1}
              placeholder={
                textEntryStyle.isMarker
                  ? t("chat.annotate.markerPlaceholder")
                  : t("chat.annotate.textPlaceholder")
              }
              aria-label={
                textEntryStyle.isMarker
                  ? t("chat.annotate.markerPlaceholder")
                  : t("chat.annotate.textPlaceholder")
              }
              className={cn(
                "absolute min-w-40 resize-none rounded-md border border-primary/60 bg-background/95 px-1.5 py-0.5",
                "font-semibold text-foreground shadow-md outline-none field-sizing-content",
              )}
              style={{
                left: textEntryStyle.left,
                top: textEntryStyle.top,
                fontSize: textEntryStyle.fontPx,
                lineHeight: 1.25,
                color: textEntryStyle.isMarker ? undefined : color,
              }}
              onChange={(event) =>
                setTextEntry((current) =>
                  current ? { ...current, value: event.target.value } : current,
                )
              }
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  lastInnerEscapeRef.current = Date.now();
                  commitTextEntry(textEntry, true);
                  rootRef.current?.focus({ preventScroll: true });
                  return;
                }
                const multiline =
                  textEntry.mode === "text" ||
                  (textEntry.mode === "edit" && !textEntryStyle.isMarker);
                if (event.key === "Enter" && (!multiline || !event.shiftKey)) {
                  event.preventDefault();
                  commitTextEntry(textEntry);
                  rootRef.current?.focus({ preventScroll: true });
                }
              }}
              onBlur={() => commitTextEntry(textEntry)}
            />
          ) : null}
        </div>
        <p className="sr-only" aria-live="polite">
          {toolLabel(tool)}
        </p>
      </div>
      <DialogFooter className="flex flex-wrap items-center gap-3 border-t border-border/60">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {note ? (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Switch
                id={includeNoteId}
                checked={includeNote}
                onCheckedChange={(checked) => setIncludeNote(checked)}
                size="sm"
                data-annotation-include-note=""
              />
              <label htmlFor={includeNoteId} className="truncate">
                {t("chat.annotate.includeNote")}
              </label>
            </div>
          ) : (
            <span className="truncate text-xs text-muted-foreground">
              {t("chat.annotate.hint")}
            </span>
          )}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogActions>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {t("chat.annotate.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!doc || !image || saving}
            data-annotation-save=""
            onClick={() => void handleSave()}
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {saving ? t("chat.annotate.saving") : t("chat.annotate.save")}
          </Button>
        </DialogActions>
      </DialogFooter>
    </>
  );
}

/** Image-space bounds of a shape, for the selection outline. */
function shapeBounds(ctx: AnnotationCanvasContext, shape: AnnotationShape) {
  switch (shape.kind) {
    case "rect":
    case "blur":
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    case "arrow":
      return {
        x: Math.min(shape.from.x, shape.to.x),
        y: Math.min(shape.from.y, shape.to.y),
        w: Math.abs(shape.to.x - shape.from.x),
        h: Math.abs(shape.to.y - shape.from.y),
      };
    case "pen": {
      const xs = shape.points.map((point) => point.x);
      const ys = shape.points.map((point) => point.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case "marker":
      return {
        x: shape.x - shape.size,
        y: shape.y - shape.size,
        w: shape.size * 2,
        h: shape.size * 2,
      };
    case "text": {
      ctx.save();
      ctx.font = `600 ${shape.size}px sans-serif`;
      const lines = shape.text.split("\n");
      const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
      ctx.restore();
      return { x: shape.x, y: shape.y, w: width, h: lines.length * shape.size * 1.25 };
    }
  }
}
