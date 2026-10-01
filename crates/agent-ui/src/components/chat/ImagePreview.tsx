import {
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
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
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
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  copyImagePreviewSlide,
  ImagePreviewContextMenu,
  ImagePreviewMenuItem,
  openImagePreviewSlideInSystemViewer,
  saveImagePreviewSlide,
  toMessage,
} from "./ImagePreviewMenu";

export type { ImagePreviewAttachment, ImagePreviewSlide } from "./imagePreviewModel";

type ImagePreviewProps = {
  open: boolean;
  slides: ImagePreviewSlide[];
  index?: number;
  closeLabel?: string;
  onClose: () => void;
};

type MenuPosition = { x: number; y: number };
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

function ImagePreviewToolButton(props: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { label, disabled, pressed, onClick, children } = props;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        "pointer-events-auto shrink-0 rounded-full bg-white/95 text-zinc-800 shadow-sm hover:bg-white hover:text-zinc-950 focus-visible:ring-white",
        pressed && "bg-white",
      )}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const intentionalFullscreenExitRef = useRef(false);
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
    setActionError(null);
  }, [activeSlideKey, open]);

  useEffect(() => {
    if (!open) {
      setIsFullscreen(false);
      intentionalFullscreenExitRef.current = false;
      return;
    }
    let wasFullscreen = Boolean(
      dialogRef.current && document.fullscreenElement === dialogRef.current,
    );
    const updateFullscreenState = () => {
      const fullscreen = Boolean(
        dialogRef.current && document.fullscreenElement === dialogRef.current,
      );
      setIsFullscreen(fullscreen);
      // Browsers can consume Escape before dispatching a keyboard event.
      // A native fullscreen exit must dismiss the preview too; the toolbar's
      // explicit exit-fullscreen action is the only exception.
      if (wasFullscreen && !fullscreen) {
        if (!intentionalFullscreenExitRef.current) onClose();
        intentionalFullscreenExitRef.current = false;
      }
      wasFullscreen = fullscreen;
    };
    updateFullscreenState();
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () => document.removeEventListener("fullscreenchange", updateFullscreenState);
  }, [onClose, open]);

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
    const dialogIsFullscreen = dialog !== null && document.fullscreenElement === dialog;
    if (dialogIsFullscreen) {
      if (!document.exitFullscreen) {
        setActionError(t("chat.imageViewer.fullscreenFailed"));
        return;
      }
      try {
        intentionalFullscreenExitRef.current = true;
        await document.exitFullscreen();
      } catch (error) {
        intentionalFullscreenExitRef.current = false;
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
    if (
      dialogRef.current &&
      document.fullscreenElement === dialogRef.current &&
      document.exitFullscreen
    ) {
      intentionalFullscreenExitRef.current = true;
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

  const viewMenuItems = (
    <>
      <ImagePreviewMenuItem
        disabled={viewerState.scale <= IMAGE_VIEWER_MIN_SCALE}
        onClick={() => {
          zoomByStep(-1);
        }}
      >
        <Minus className="size-3.5" />
        {t("chat.imageViewer.zoomOut")}
      </ImagePreviewMenuItem>
      <ImagePreviewMenuItem
        disabled={viewerState.scale >= IMAGE_VIEWER_MAX_SCALE}
        onClick={() => {
          zoomByStep(1);
        }}
      >
        <Plus className="size-3.5" />
        {t("chat.imageViewer.zoomIn")}
      </ImagePreviewMenuItem>
      <ImagePreviewMenuItem
        onClick={() => {
          setViewerState(resetImageViewerState());
        }}
      >
        <RefreshCw className="size-3.5" />
        {t("chat.imageViewer.reset")}
      </ImagePreviewMenuItem>
      <ImagePreviewMenuItem
        onClick={() => {
          rotateImage(-1);
        }}
      >
        <RotateCcw className="size-3.5" />
        {t("chat.imageViewer.rotateLeft")}
      </ImagePreviewMenuItem>
      <ImagePreviewMenuItem
        onClick={() => {
          rotateImage(1);
        }}
      >
        <RotateCw className="size-3.5" />
        {t("chat.imageViewer.rotateRight")}
      </ImagePreviewMenuItem>
      <ImagePreviewMenuItem
        onClick={() => {
          setShowInfo(true);
        }}
      >
        <Info className="size-3.5" />
        {t("chat.imageViewer.info")}
      </ImagePreviewMenuItem>
      <ImagePreviewMenuItem
        onClick={() => {
          void handleFullscreen();
        }}
      >
        {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        {t(isFullscreen ? "chat.imageViewer.exitFullscreen" : "chat.imageViewer.fullscreen")}
      </ImagePreviewMenuItem>
    </>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeViewer();
      }}
    >
      <DialogContent
        ref={dialogRef}
        initialFocus={dialogRef}
        layout="lightbox"
        className="overflow-hidden p-0 [&:fullscreen]:bg-black/80 [&:fullscreen]:pointer-events-auto"
        onClick={(event) => {
          // Native fullscreen puts the popup above the shared backdrop.
          if (isFullscreen && event.target === event.currentTarget) closeViewer();
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented || (event.target as HTMLElement).closest('[role="menu"]'))
            return;
          if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            event.key.toLowerCase() === "c" &&
            !window.getSelection()?.toString()
          ) {
            event.preventDefault();
            event.stopPropagation();
            void copyImage();
          }
          if (!event.ctrlKey && !event.metaKey && !event.altKey) {
            if (event.key === "ArrowLeft" && canOpenPrevious) {
              event.preventDefault();
              setActiveImage(clampedIndex - 1);
            }
            if (event.key === "ArrowRight" && canOpenNext) {
              event.preventDefault();
              setActiveImage(clampedIndex + 1);
            }
          }
          if (event.key === "0" && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            setViewerState(resetImageViewerState());
          }
        }}
      >
        <DialogTitle className="sr-only">{t("chat.imageViewer.viewer")}</DialogTitle>
        <div className="pointer-events-auto absolute right-4 top-4 z-20 flex items-center gap-2 sm:right-6 sm:top-6">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full bg-white/95 text-zinc-800 shadow-sm hover:bg-white hover:text-zinc-950"
                />
              }
              aria-label={t("chat.imageViewer.actions")}
              title={t("chat.imageViewer.actions")}
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              variant="soft"
              portalContainer={dialogRef.current}
              align="end"
              className="pointer-events-auto [&_[role=menuitem]]:gap-2"
            >
              {viewMenuItems}
              <DropdownMenuItem disabled={isCopying} onClick={() => void copyImage()}>
                <Copy className="size-3.5" />
                {t("chat.imageViewer.copy")}
              </DropdownMenuItem>
              {capabilities?.canOpenSystem ? (
                <DropdownMenuItem onClick={() => void openSystemViewer()}>
                  <ExternalLink className="size-3.5" />
                  {t("chat.imageViewer.openSystem")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <ImagePreviewToolButton
            label={t("chat.imageViewer.save")}
            disabled={isSaving}
            onClick={() => void saveImage()}
          >
            {isSaving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
          </ImagePreviewToolButton>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full bg-white/95 text-zinc-800 shadow-sm hover:bg-white hover:text-zinc-950"
              />
            }
            title={closeLabel}
            aria-label={closeLabel}
          >
            <X className="size-4" />
          </DialogClose>
        </div>
        {imageCount > 1 ? (
          <>
            <div className="absolute left-3 top-1/2 z-20 -translate-y-1/2 sm:left-6">
              {canOpenPrevious ? (
                <ImagePreviewToolButton
                  label={t("chat.imageViewer.previous")}
                  onClick={() => setActiveImage(clampedIndex - 1)}
                >
                  <ChevronRight className="size-4 rotate-180" />
                </ImagePreviewToolButton>
              ) : null}
            </div>
            <div className="absolute right-3 top-1/2 z-20 -translate-y-1/2 sm:right-6">
              {canOpenNext ? (
                <ImagePreviewToolButton
                  label={t("chat.imageViewer.next")}
                  onClick={() => setActiveImage(clampedIndex + 1)}
                >
                  <ChevronRight className="size-4" />
                </ImagePreviewToolButton>
              ) : null}
            </div>
            <span className="absolute left-6 top-6 text-xs tabular-nums text-white/70">
              {clampedIndex + 1} / {imageCount}
            </span>
          </>
        ) : null}
        <ImagePreviewContextMenu
          slide={slide}
          portalContainer={dialogRef.current}
          onActionError={setActionError}
          trigger={
            <div
              ref={setViewportRef}
              className={cn(
                "pointer-events-none absolute inset-x-12 inset-y-20 touch-none select-none sm:inset-x-20",
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
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <div
                  className="pointer-events-auto relative shrink-0"
                  style={{
                    height: `${imageSize.height}px`,
                    width: `${imageSize.width}px`,
                    transform: `translate(${viewerState.x}px, ${viewerState.y}px) scale(${viewerState.scale})`,
                    transformOrigin: "center",
                    transition: isDragging ? "none" : "transform 120ms ease-out",
                  }}
                >
                  <div
                    className="size-full"
                    style={{ transform: `rotate(${viewerState.rotation}deg)` }}
                  >
                    <img
                      key={activeSlideKey ?? undefined}
                      className="size-full select-none rounded-sm object-contain shadow-2xl"
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
                        if (hasInlineImageData)
                          void resolveCachedImageData(slide).catch(() => undefined);
                      }}
                      onError={() => setActionError(t("chat.imageViewer.unavailable"))}
                    />
                  </div>
                </div>
              </div>
              {actionError ? (
                <div
                  role="alert"
                  className={cn(
                    "pointer-events-auto absolute left-0 top-0 z-10 max-w-panel-28rem",
                    "rounded-md border border-destructive/30 bg-background/95 px-3 py-2",
                    "text-xs text-destructive shadow-lg backdrop-blur",
                  )}
                >
                  {actionError}
                </div>
              ) : null}
              {showInfo ? (
                <aside
                  aria-label={t("chat.imageViewer.infoPanel")}
                  className={cn(
                    "pointer-events-auto absolute inset-x-0 top-0 z-10 sm:left-auto sm:w-72",
                    "rounded-lg border border-border bg-background/90 p-3",
                    "text-xs text-foreground shadow-xl backdrop-blur",
                  )}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold">{t("chat.imageViewer.infoPanel")}</div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title={closeLabel}
                      aria-label={closeLabel}
                      onClick={() => setShowInfo(false)}
                    >
                      <X className="size-3.5" />
                    </Button>
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
            </div>
          }
        >
          {viewMenuItems}
        </ImagePreviewContextMenu>
        <div className="pointer-events-auto absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/95 p-1 text-zinc-800 shadow-lg sm:bottom-6">
          <ImagePreviewToolButton
            label={t("chat.imageViewer.zoomOut")}
            disabled={viewerState.scale <= IMAGE_VIEWER_MIN_SCALE}
            onClick={() => zoomByStep(-1)}
          >
            <Minus className="size-4" />
          </ImagePreviewToolButton>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-12 rounded-full px-1 text-xs tabular-nums hover:bg-black/5 hover:text-zinc-950"
            title={t("chat.imageViewer.reset")}
            aria-label={t("chat.imageViewer.reset")}
            onClick={() => setViewerState(resetImageViewerState())}
          >
            {Math.round(
              viewerState.scale *
                (naturalSize.width > 0 ? imageSize.width / naturalSize.width : 1) *
                100,
            )}
            %
          </Button>
          <ImagePreviewToolButton
            label={t("chat.imageViewer.zoomIn")}
            disabled={viewerState.scale >= IMAGE_VIEWER_MAX_SCALE}
            onClick={() => zoomByStep(1)}
          >
            <Plus className="size-4" />
          </ImagePreviewToolButton>
        </div>
      </DialogContent>
    </Dialog>
  );
});
