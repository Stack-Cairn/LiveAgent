import {
  copyImagePreviewData,
  copyUploadedImagePreview,
  openUploadedImageInSystemViewer,
  prepareImagePreviewSave,
  prepareUploadedImagePreviewCopy,
  supportsDirectUploadedImageCopy,
  supportsSystemImageOpen,
} from "@liveagent/adapters/imagePreview";
import {
  clampImagePreviewIndex,
  clampImageViewerPan,
  clampImageViewerState,
  fitImageViewerSize,
  getImagePreviewCapabilities,
  getImagePreviewDisplayName,
  getImagePreviewDisplaySource,
  getImagePreviewFileName,
  getImagePreviewMimeType,
  getImagePreviewSlideKey,
  IMAGE_VIEWER_MAX_SCALE,
  IMAGE_VIEWER_MIN_SCALE,
  type ImagePreviewSlide,
  type ImageViewerSize,
  type ImageViewerState,
  imageViewerScaleAfterStep,
  imageViewerScaleAfterWheelDelta,
  isVerifiedImagePreviewAttachment,
  normalizeImagePreviewIndex,
  resetImageViewerState,
  resolveImagePreviewData,
  zoomImageViewerAtPoint,
} from "@liveagent/ui/components/chat/imagePreviewModel";
import { NotifyToast } from "@liveagent/ui/components/chat/NotifyToast";
import {
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Info,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RefreshCw,
  RotateCwSquare,
  X,
} from "@liveagent/ui/components/IconSet";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useLocale } from "@liveagent/ui/i18n";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type { ImagePreviewAttachment, ImagePreviewSlide } from "./imagePreviewModel";

type ImagePreviewProps = {
  open: boolean;
  slides: ImagePreviewSlide[];
  index?: number;
  closeLabel?: string;
  onClose: () => void;
};

type MenuPosition = { x: number; y: number };
type ImagePreviewDataResolver = (
  slide: ImagePreviewSlide,
) => ReturnType<typeof resolveImagePreviewData>;

function toMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? "").trim();
  return text || fallback;
}

function formatBytes(bytes: number | undefined) {
  if (!Number.isFinite(bytes) || (bytes ?? 0) < 0) return "-";
  const normalized = bytes as number;
  if (normalized < 1024) return `${normalized} B`;
  if (normalized < 1024 * 1024) return `${(normalized / 1024).toFixed(1)} KB`;
  return `${(normalized / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDimensions(size: ImageViewerSize) {
  return size.width > 0 && size.height > 0 ? `${size.width} x ${size.height}` : "-";
}

function imageViewerAnchor(
  event: { clientX: number; clientY: number },
  viewport: HTMLElement | null,
) {
  const rect = viewport?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return {
    x: event.clientX - rect.left - rect.width / 2,
    y: event.clientY - rect.top - rect.height / 2,
  };
}

async function copyTextToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Text clipboard is unavailable");
}

async function saveImagePreviewSlide(
  slide: ImagePreviewSlide,
  resolveData: ImagePreviewDataResolver = resolveImagePreviewData,
) {
  const writeImage = await prepareImagePreviewSave({
    fileName: getImagePreviewFileName(slide),
    mimeType: getImagePreviewMimeType(slide),
  });
  if (!writeImage) return;

  const data = await resolveData(slide);
  await writeImage({
    dataBase64: data.dataBase64,
    fileName: getImagePreviewFileName(slide),
    mimeType: data.mimeType,
  });
}

async function copyImagePreviewSlide(
  slide: ImagePreviewSlide,
  resolveData: ImagePreviewDataResolver = resolveImagePreviewData,
) {
  if (
    supportsDirectUploadedImageCopy &&
    getImagePreviewMimeType(slide) !== "image/svg+xml" &&
    isVerifiedImagePreviewAttachment(slide.attachment)
  ) {
    await copyUploadedImagePreview({
      workdir: slide.attachment.workdir,
      absolutePath: slide.attachment.absolutePath,
    });
    return;
  }
  const data = resolveData(slide).then((resolved) => ({
    dataBase64: resolved.dataBase64,
    mimeType: resolved.mimeType,
  }));
  await copyImagePreviewData(data);
}

async function openImagePreviewSlideInSystemViewer(slide: ImagePreviewSlide) {
  if (!isVerifiedImagePreviewAttachment(slide.attachment)) {
    throw new Error("This image is not a verified uploaded attachment");
  }
  await openUploadedImageInSystemViewer({
    workdir: slide.attachment.workdir,
    absolutePath: slide.attachment.absolutePath,
  });
}

function ImagePreviewToolButton(props: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { label, disabled, pressed, onClick, children } = props;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35",
        pressed && "bg-muted text-foreground",
      )}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function ImagePreviewMenuItem(props: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function ImagePreviewActionFeedback(props: {
  message: string | null;
  onDismiss: () => void;
}) {
  if (!props.message || typeof document === "undefined") return null;
  return createPortal(
    <div className="layer-toast fixed inset-x-0 top-0 h-0">
      <NotifyToast
        items={[{ id: "image-preview-action-error", type: "error", message: props.message }]}
        onDismiss={props.onDismiss}
      />
    </div>,
    document.body,
  );
}

export function runImagePreviewContextMenuAction(params: {
  action: () => Promise<void>;
  fallback: string;
  onClose: () => void;
  onActionError: (message: string) => void;
}) {
  params.onClose();
  try {
    return params.action().catch((actionError) => {
      params.onActionError(toMessage(actionError, params.fallback));
    });
  } catch (actionError) {
    params.onActionError(toMessage(actionError, params.fallback));
    return Promise.resolve();
  }
}

export function ImagePreviewContextMenu(props: {
  slide: ImagePreviewSlide;
  position: MenuPosition;
  onClose: () => void;
  onOpen?: () => void;
  onActionError: (message: string) => void;
  children?: ReactNode;
}) {
  const { slide, position, onClose, onOpen, onActionError, children } = props;
  const { t } = useLocale();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const capabilities = getImagePreviewCapabilities(slide, supportsSystemImageOpen);

  const updateMenuPosition = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const inset = 8;
    setMenuPosition({
      x: Math.max(inset, Math.min(position.x, window.innerWidth - rect.width - inset)),
      y: Math.max(inset, Math.min(position.y, window.innerHeight - rect.height - inset)),
    });
  }, [position.x, position.y]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    updateMenuPosition();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateMenuPosition);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [updateMenuPosition]);

  useEffect(() => {
    window.addEventListener("resize", updateMenuPosition);
    return () => window.removeEventListener("resize", updateMenuPosition);
  }, [updateMenuPosition]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  const run = useCallback(
    (action: () => Promise<void>, fallback: string) => {
      void runImagePreviewContextMenuAction({ action, fallback, onClose, onActionError });
    },
    [onActionError, onClose],
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="layer-popover fixed min-w-52 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-2xl"
      style={{
        left: (menuPosition ?? position).x,
        top: (menuPosition ?? position).y,
        visibility: menuPosition ? undefined : "hidden",
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {children}
      {onOpen ? (
        <ImagePreviewMenuItem
          onClick={() => {
            onOpen();
            onClose();
          }}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          {t("chat.imageViewer.open")}
        </ImagePreviewMenuItem>
      ) : null}
      {capabilities.canSave ? (
        <ImagePreviewMenuItem
          onClick={() => run(() => saveImagePreviewSlide(slide), t("chat.imageViewer.saveFailed"))}
        >
          <Download className="h-3.5 w-3.5" />
          {t("chat.imageViewer.save")}
        </ImagePreviewMenuItem>
      ) : null}
      {capabilities.canCopyImage ? (
        <ImagePreviewMenuItem
          onClick={() => run(() => copyImagePreviewSlide(slide), t("chat.imageViewer.copyFailed"))}
        >
          <Copy className="h-3.5 w-3.5" />
          {t("chat.imageViewer.copy")}
        </ImagePreviewMenuItem>
      ) : null}
      {capabilities.canCopyPaths && slide.attachment ? (
        <ImagePreviewMenuItem
          onClick={() =>
            run(
              () => copyTextToClipboard(slide.attachment?.absolutePath ?? ""),
              t("chat.imageViewer.copyPathFailed"),
            )
          }
        >
          <Copy className="h-3.5 w-3.5" />
          {t("chat.imageViewer.copyAbsolutePath")}
        </ImagePreviewMenuItem>
      ) : null}
      {capabilities.canCopyPaths && slide.attachment ? (
        <ImagePreviewMenuItem
          onClick={() =>
            run(
              () => copyTextToClipboard(slide.attachment?.relativePath ?? ""),
              t("chat.imageViewer.copyPathFailed"),
            )
          }
        >
          <Copy className="h-3.5 w-3.5" />
          {t("chat.imageViewer.copyRelativePath")}
        </ImagePreviewMenuItem>
      ) : null}
      {capabilities.canOpenSystem ? (
        <ImagePreviewMenuItem
          onClick={() =>
            run(
              () => openImagePreviewSlideInSystemViewer(slide),
              t("chat.imageViewer.openSystemFailed"),
            )
          }
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("chat.imageViewer.openSystem")}
        </ImagePreviewMenuItem>
      ) : null}
    </div>,
    document.body,
  );
}

export const ImagePreview = memo(function ImagePreview(props: ImagePreviewProps) {
  const { open, slides, index = 0, onClose } = props;
  const { t } = useLocale();
  const closeLabel = props.closeLabel ?? t("chat.imageViewer.close");
  const requestedIndex = normalizeImagePreviewIndex(index);
  const clampedRequestedIndex = clampImagePreviewIndex(requestedIndex, slides.length);
  const [activeIndex, setActiveIndex] = useState(clampedRequestedIndex);
  const [viewerState, setViewerState] = useState<ImageViewerState>(resetImageViewerState);
  const [viewportSize, setViewportSize] = useState<ImageViewerSize>({ width: 0, height: 0 });
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const [naturalSize, setNaturalSize] = useState<ImageViewerSize>({ width: 0, height: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [contextMenu, setContextMenu] = useState<MenuPosition | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const setViewportRef = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    setViewportElement(node);
  }, []);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const resolvedDataRef = useRef(
    new WeakMap<ImagePreviewSlide, ReturnType<typeof resolveImagePreviewData>>(),
  );
  const wasOpenRef = useRef(open);
  const requestedIndexRef = useRef(requestedIndex);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    const requestedIndexChanged = requestedIndexRef.current !== requestedIndex;
    requestedIndexRef.current = requestedIndex;

    if (!open) {
      wasOpenRef.current = false;
      setActiveIndex(clampedRequestedIndex);
      return;
    }
    if (!wasOpen || requestedIndexChanged) setActiveIndex(clampedRequestedIndex);
    wasOpenRef.current = true;
  }, [clampedRequestedIndex, open, requestedIndex]);

  useEffect(() => {
    setActiveIndex((currentIndex) => clampImagePreviewIndex(currentIndex, slides.length));
  }, [slides.length]);

  const clampedIndex = clampImagePreviewIndex(activeIndex, slides.length);
  const slide = slides[clampedIndex];
  // 紧凑指纹而非整串 src/dataBase64：内联图的 payload 是 MB 级巨串，进 deps
  // 会让缩放/拖拽的每帧重渲染都重新物化+全量比较一次（内存churn 主因）。
  const activeSlideKey = slide ? getImagePreviewSlideKey(slide) : null;
  const imageSource = useMemo(() => (slide ? getImagePreviewDisplaySource(slide) : ""), [slide]);
  const hasInlineImageData = Boolean(slide?.dataBase64?.trim() || imageSource.startsWith("data:"));

  const resolveCachedImageData = useCallback((candidate: ImagePreviewSlide) => {
    const cached = resolvedDataRef.current.get(candidate);
    if (cached) return cached;

    const resolving = resolveImagePreviewData(candidate);
    resolvedDataRef.current.set(candidate, resolving);
    void resolving.catch(() => {
      if (resolvedDataRef.current.get(candidate) === resolving) {
        resolvedDataRef.current.delete(candidate);
      }
    });
    return resolving;
  }, []);

  useEffect(() => {
    if (!open || activeSlideKey === null) return;
    setViewerState(resetImageViewerState());
    setNaturalSize({ width: 0, height: 0 });
    setShowInfo(false);
    setContextMenu(null);
    setActionError(null);
  }, [activeSlideKey, open]);

  useEffect(() => {
    if (!open) {
      setIsFullscreen(false);
      return;
    }
    const updateFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === dialogRef.current);
    };
    updateFullscreenState();
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () => document.removeEventListener("fullscreenchange", updateFullscreenState);
  }, [open]);

  useEffect(() => {
    if (!open || !viewportElement) return;
    const updateViewportSize = () => {
      setViewportSize({ width: viewportElement.clientWidth, height: viewportElement.clientHeight });
    };
    updateViewportSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateViewportSize);
      return () => window.removeEventListener("resize", updateViewportSize);
    }
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(viewportElement);
    return () => observer.disconnect();
  }, [open, viewportElement]);

  const imageSize = useMemo(
    () => fitImageViewerSize(naturalSize, viewportSize, viewerState.rotation),
    [naturalSize, viewportSize, viewerState.rotation],
  );
  const viewerOptions = useMemo(() => ({ imageSize, viewportSize }), [imageSize, viewportSize]);
  const capabilities = slide ? getImagePreviewCapabilities(slide, supportsSystemImageOpen) : null;
  const verifiedAttachment =
    slide && isVerifiedImagePreviewAttachment(slide.attachment) ? slide.attachment : null;
  const canPan =
    clampImageViewerPan(
      { x: 1_000_000, y: 1_000_000 },
      { ...viewerOptions, scale: viewerState.scale, rotation: viewerState.rotation },
    ).x > 0 ||
    clampImageViewerPan(
      { x: 1_000_000, y: 1_000_000 },
      { ...viewerOptions, scale: viewerState.scale, rotation: viewerState.rotation },
    ).y > 0;

  useEffect(() => {
    setViewerState((current) => clampImageViewerState(current, viewerOptions));
  }, [viewerOptions]);

  const zoomByStep = useCallback(
    (direction: -1 | 1) => {
      setViewerState((current) =>
        zoomImageViewerAtPoint(
          current,
          imageViewerScaleAfterStep(current.scale, direction),
          { x: 0, y: 0 },
          viewerOptions,
        ),
      );
    },
    [viewerOptions],
  );

  const zoomByWheel = useCallback(
    (deltaY: number, deltaMode: number, anchor: MenuPosition) => {
      setViewerState((current) =>
        zoomImageViewerAtPoint(
          current,
          imageViewerScaleAfterWheelDelta(current.scale, deltaY, deltaMode),
          anchor,
          viewerOptions,
        ),
      );
    },
    [viewerOptions],
  );

  const rotateImage = useCallback(
    (direction: -1 | 1) => {
      setViewerState((current) =>
        clampImageViewerState(
          { ...current, rotation: current.rotation + direction * 90 },
          viewerOptions,
        ),
      );
    },
    [viewerOptions],
  );

  const handleFullscreen = useCallback(async () => {
    const dialog = dialogRef.current;
    const dialogIsFullscreen = document.fullscreenElement === dialog;
    if (dialogIsFullscreen) {
      if (!document.exitFullscreen) {
        setActionError(t("chat.imageViewer.fullscreenFailed"));
        return;
      }
      try {
        await document.exitFullscreen();
      } catch (error) {
        setActionError(toMessage(error, t("chat.imageViewer.fullscreenFailed")));
      }
      return;
    }
    if (!dialog?.requestFullscreen) {
      setActionError(t("chat.imageViewer.fullscreenFailed"));
      return;
    }
    try {
      await dialog.requestFullscreen();
    } catch (error) {
      setActionError(toMessage(error, t("chat.imageViewer.fullscreenFailed")));
    }
  }, [t]);

  const closeViewer = useCallback(() => {
    if (document.fullscreenElement === dialogRef.current && document.exitFullscreen) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onClose();
  }, [onClose]);

  const saveImage = useCallback(async () => {
    if (!slide || isSaving) return;
    setIsSaving(true);
    try {
      await saveImagePreviewSlide(slide, resolveCachedImageData);
    } catch (error) {
      setActionError(toMessage(error, t("chat.imageViewer.saveFailed")));
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, resolveCachedImageData, slide, t]);

  const copyImage = useCallback(async () => {
    if (!slide || isCopying) return;
    setIsCopying(true);
    try {
      await copyImagePreviewSlide(slide, resolveCachedImageData);
    } catch (error) {
      setActionError(toMessage(error, t("chat.imageViewer.copyFailed")));
    } finally {
      setIsCopying(false);
    }
  }, [isCopying, resolveCachedImageData, slide, t]);

  const openSystemViewer = useCallback(async () => {
    if (!slide) return;
    try {
      await openImagePreviewSlideInSystemViewer(slide);
    } catch (error) {
      setActionError(toMessage(error, t("chat.imageViewer.openSystemFailed")));
    }
  }, [slide, t]);

  if (!open || !slide || typeof document === "undefined") return null;

  const imageCount = slides.length;
  const canOpenPrevious = clampedIndex > 0;
  const canOpenNext = clampedIndex < imageCount - 1;
  const setActiveImage = (nextIndex: number) => {
    setActiveIndex(clampImagePreviewIndex(nextIndex, imageCount));
  };

  return (
    <Dialog
      open={open}
      disablePointerDismissal
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) return;
        if (eventDetails.reason === "escape-key") {
          if (contextMenu) {
            eventDetails.cancel();
            setContextMenu(null);
            return;
          }
          if (showInfo) {
            eventDetails.cancel();
            setShowInfo(false);
            return;
          }
          if (isFullscreen) {
            eventDetails.cancel();
            void handleFullscreen();
            return;
          }
        }
        closeViewer();
      }}
    >
      <DialogContent
        ref={dialogRef}
        initialFocus={dialogRef}
        className="chat-image-preview-dialog flex h-[min(78vh,760px)] w-[min(82vw,1120px)] max-w-none min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border-border bg-background p-0 text-foreground"
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            event.key.toLowerCase() === "c"
          ) {
            event.preventDefault();
            event.stopPropagation();
            void copyImage();
          }
          if (event.key === "0") {
            event.preventDefault();
            event.stopPropagation();
            setViewerState(resetImageViewerState());
          }
        }}
      >
        <DialogTitle className="sr-only">{t("chat.imageViewer.viewer")}</DialogTitle>
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-background/90 px-2">
          <div className="flex min-w-0 items-center gap-1">
            {imageCount > 1 ? (
              <>
                <ImagePreviewToolButton
                  label={t("chat.imageViewer.previous")}
                  disabled={!canOpenPrevious}
                  onClick={() => setActiveImage(clampedIndex - 1)}
                >
                  <ChevronRight className="h-4 w-4 rotate-180" />
                </ImagePreviewToolButton>
                <ImagePreviewToolButton
                  label={t("chat.imageViewer.next")}
                  disabled={!canOpenNext}
                  onClick={() => setActiveImage(clampedIndex + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </ImagePreviewToolButton>
                <span className="ml-1 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {clampedIndex + 1} / {imageCount}
                </span>
              </>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto">
            <ImagePreviewToolButton
              label={t("chat.imageViewer.zoomOut")}
              disabled={viewerState.scale <= IMAGE_VIEWER_MIN_SCALE}
              onClick={() => zoomByStep(-1)}
            >
              <Minus className="h-4 w-4" />
            </ImagePreviewToolButton>
            <span className="w-11 text-center text-[11px] tabular-nums text-muted-foreground">
              {Math.round(viewerState.scale * 100)}%
            </span>
            <ImagePreviewToolButton
              label={t("chat.imageViewer.zoomIn")}
              disabled={viewerState.scale >= IMAGE_VIEWER_MAX_SCALE}
              onClick={() => zoomByStep(1)}
            >
              <Plus className="h-4 w-4" />
            </ImagePreviewToolButton>
            <ImagePreviewToolButton
              label={t("chat.imageViewer.rotateLeft")}
              onClick={() => rotateImage(-1)}
            >
              <RotateCwSquare className="h-4 w-4 -scale-x-100" />
            </ImagePreviewToolButton>
            <ImagePreviewToolButton
              label={t("chat.imageViewer.rotateRight")}
              onClick={() => rotateImage(1)}
            >
              <RotateCwSquare className="h-4 w-4" />
            </ImagePreviewToolButton>
            <ImagePreviewToolButton
              label={t("chat.imageViewer.reset")}
              onClick={() => setViewerState(resetImageViewerState())}
            >
              <RefreshCw className="h-4 w-4" />
            </ImagePreviewToolButton>
            <ImagePreviewToolButton
              label={t("chat.imageViewer.save")}
              disabled={isSaving}
              onClick={() => void saveImage()}
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </ImagePreviewToolButton>
            {capabilities?.canOpenSystem ? (
              <ImagePreviewToolButton
                label={t("chat.imageViewer.openSystem")}
                onClick={() => void openSystemViewer()}
              >
                <ExternalLink className="h-4 w-4" />
              </ImagePreviewToolButton>
            ) : null}
            <ImagePreviewToolButton
              label={t("chat.imageViewer.copy")}
              disabled={isCopying}
              onClick={() => void copyImage()}
            >
              {isCopying ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </ImagePreviewToolButton>
            <ImagePreviewToolButton
              label={t("chat.imageViewer.info")}
              pressed={showInfo}
              onClick={() => setShowInfo((current) => !current)}
            >
              <Info className="h-4 w-4" />
            </ImagePreviewToolButton>
            <ImagePreviewToolButton
              label={t(
                isFullscreen ? "chat.imageViewer.exitFullscreen" : "chat.imageViewer.fullscreen",
              )}
              onClick={() => void handleFullscreen()}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </ImagePreviewToolButton>
            <DialogClose
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={closeLabel}
              aria-label={closeLabel}
            >
              <X className="h-4 w-4" />
            </DialogClose>
          </div>
        </div>
        <div
          ref={setViewportRef}
          role="application"
          aria-label={t("chat.imageViewer.viewer")}
          className={cn(
            "relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-muted/25",
            isDragging ? "cursor-grabbing" : canPan ? "cursor-grab" : "cursor-default",
          )}
          onWheel={(event) => {
            if (event.deltaY === 0) return;
            event.preventDefault();
            zoomByWheel(
              event.deltaY,
              event.deltaMode,
              imageViewerAnchor(event, viewportRef.current),
            );
          }}
          onPointerDown={(event) => {
            if (contextMenu) {
              setContextMenu(null);
              return;
            }
            if (event.button !== 0 || !canPan) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originX: viewerState.x,
              originY: viewerState.y,
            };
            setIsDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            setViewerState((current) => ({
              ...current,
              ...clampImageViewerPan(
                {
                  x: drag.originX + event.clientX - drag.startX,
                  y: drag.originY + event.clientY - drag.startY,
                },
                { ...viewerOptions, scale: current.scale, rotation: current.rotation },
              ),
            }));
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return;
            dragRef.current = null;
            setIsDragging(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            setIsDragging(false);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className="relative shrink-0"
              style={{
                height: `${imageSize.height}px`,
                width: `${imageSize.width}px`,
                transform: `translate(${viewerState.x}px, ${viewerState.y}px) scale(${viewerState.scale})`,
                transformOrigin: "center",
                transition: isDragging ? "none" : "transform 120ms ease-out",
              }}
            >
              <div
                className="h-full w-full"
                style={{ transform: `rotate(${viewerState.rotation}deg)` }}
              >
                <img
                  key={activeSlideKey ?? undefined}
                  className="h-full w-full select-none object-contain"
                  src={imageSource}
                  alt={slide.alt ?? getImagePreviewDisplayName(slide)}
                  draggable={false}
                  onLoad={(event) => {
                    setNaturalSize({
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    });
                    if (
                      supportsDirectUploadedImageCopy &&
                      getImagePreviewMimeType(slide) !== "image/svg+xml" &&
                      isVerifiedImagePreviewAttachment(slide.attachment)
                    ) {
                      void prepareUploadedImagePreviewCopy({
                        workdir: slide.attachment.workdir,
                        absolutePath: slide.attachment.absolutePath,
                      }).catch(() => undefined);
                    }
                    if (hasInlineImageData) void resolveCachedImageData(slide);
                  }}
                  onError={() => setActionError(t("chat.imageViewer.unavailable"))}
                />
              </div>
            </div>
          </div>
          {actionError ? (
            <div
              role="alert"
              className="absolute left-3 top-3 z-10 max-w-[min(28rem,calc(100%-1.5rem))] rounded-md border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive shadow-lg backdrop-blur"
            >
              {actionError}
            </div>
          ) : null}
          {showInfo ? (
            <aside
              aria-label={t("chat.imageViewer.infoPanel")}
              className="absolute right-3 top-3 z-10 w-72 rounded-lg border border-border bg-background/90 p-3 text-xs text-foreground shadow-xl backdrop-blur"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">{t("chat.imageViewer.infoPanel")}</div>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={closeLabel}
                  aria-label={closeLabel}
                  onClick={() => setShowInfo(false)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-muted-foreground">
                <dt>{t("chat.imageViewer.fileName")}</dt>
                <dd
                  className="truncate text-right text-foreground"
                  title={getImagePreviewDisplayName(slide)}
                >
                  {getImagePreviewDisplayName(slide)}
                </dd>
                <dt>{t("chat.imageViewer.dimensions")}</dt>
                <dd className="text-right text-foreground">{formatDimensions(naturalSize)}</dd>
                <dt>{t("chat.imageViewer.fileSize")}</dt>
                <dd className="text-right text-foreground">{formatBytes(slide.sizeBytes)}</dd>
                <dt>{t("chat.imageViewer.fileType")}</dt>
                <dd
                  className="truncate text-right text-foreground"
                  title={getImagePreviewMimeType(slide)}
                >
                  {getImagePreviewMimeType(slide)}
                </dd>
                {capabilities?.canCopyPaths && verifiedAttachment ? (
                  <>
                    <dt>{t("chat.imageViewer.absolutePath")}</dt>
                    <dd
                      className="truncate text-right text-foreground"
                      title={verifiedAttachment.absolutePath}
                    >
                      {verifiedAttachment.absolutePath}
                    </dd>
                    <dt>{t("chat.imageViewer.relativePath")}</dt>
                    <dd
                      className="truncate text-right text-foreground"
                      title={verifiedAttachment.relativePath}
                    >
                      {verifiedAttachment.relativePath}
                    </dd>
                  </>
                ) : null}
              </dl>
            </aside>
          ) : null}
          {contextMenu ? (
            <ImagePreviewContextMenu
              slide={slide}
              position={contextMenu}
              onClose={() => setContextMenu(null)}
              onActionError={setActionError}
            >
              <ImagePreviewMenuItem
                disabled={viewerState.scale <= IMAGE_VIEWER_MIN_SCALE}
                onClick={() => {
                  zoomByStep(-1);
                  setContextMenu(null);
                }}
              >
                <Minus className="h-3.5 w-3.5" />
                {t("chat.imageViewer.zoomOut")}
              </ImagePreviewMenuItem>
              <ImagePreviewMenuItem
                disabled={viewerState.scale >= IMAGE_VIEWER_MAX_SCALE}
                onClick={() => {
                  zoomByStep(1);
                  setContextMenu(null);
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("chat.imageViewer.zoomIn")}
              </ImagePreviewMenuItem>
              <ImagePreviewMenuItem
                onClick={() => {
                  setViewerState(resetImageViewerState());
                  setContextMenu(null);
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t("chat.imageViewer.reset")}
              </ImagePreviewMenuItem>
              <ImagePreviewMenuItem
                onClick={() => {
                  rotateImage(-1);
                  setContextMenu(null);
                }}
              >
                <RotateCwSquare className="h-3.5 w-3.5 -scale-x-100" />
                {t("chat.imageViewer.rotateLeft")}
              </ImagePreviewMenuItem>
              <ImagePreviewMenuItem
                onClick={() => {
                  rotateImage(1);
                  setContextMenu(null);
                }}
              >
                <RotateCwSquare className="h-3.5 w-3.5" />
                {t("chat.imageViewer.rotateRight")}
              </ImagePreviewMenuItem>
              <ImagePreviewMenuItem
                onClick={() => {
                  setShowInfo(true);
                  setContextMenu(null);
                }}
              >
                <Info className="h-3.5 w-3.5" />
                {t("chat.imageViewer.info")}
              </ImagePreviewMenuItem>
              <ImagePreviewMenuItem
                onClick={() => {
                  void handleFullscreen();
                  setContextMenu(null);
                }}
              >
                {isFullscreen ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
                {t(
                  isFullscreen ? "chat.imageViewer.exitFullscreen" : "chat.imageViewer.fullscreen",
                )}
              </ImagePreviewMenuItem>
            </ImagePreviewContextMenu>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
});
