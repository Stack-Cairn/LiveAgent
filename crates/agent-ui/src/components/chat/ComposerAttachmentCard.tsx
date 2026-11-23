import { Pencil, RotateCcw, X } from "@liveagent/ui/components/IconSet";
import { Skeleton } from "@liveagent/ui/components/ui/skeleton";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useMemo, useState } from "react";
import type { PendingUploadedFile } from "../../lib/chat/uploadedFiles";
import { ImagePreview, type ImagePreviewSlide } from "./ImagePreview";
import { ImagePreviewActionFeedback, ImagePreviewContextMenu } from "./ImagePreviewMenu";

const cornerActionClassName = cn(
  "absolute z-10 inline-flex size-4 items-center justify-center",
  "rounded-full bg-on-media-control text-on-media/95 backdrop-blur-sm transition-[background-color,scale,opacity]",
  "hover:bg-on-media-control-hover active:scale-90 focus-visible:bg-on-media-control-hover disabled:pointer-events-none disabled:opacity-35",
);

export function ComposerAttachmentCard(props: {
  file?: PendingUploadedFile;
  workspaceRoot?: string;
  fileName: string;
  pathTitle: string;
  imageSrc?: string | null;
  isImageLoading?: boolean;
  fallbackIcon: ReactNode;
  disabled: boolean;
  removeLabel: string;
  previewLabel?: string;
  closePreviewLabel?: string;
  onRemove: () => void;
  /** Opens the image annotation editor; the action is hidden when absent. */
  onAnnotate?: () => void;
  /** The attachment is an annotated copy; shows a badge and the revert action. */
  annotated?: boolean;
  onRevertAnnotation?: () => void;
}) {
  const {
    file,
    workspaceRoot,
    fileName,
    pathTitle,
    imageSrc,
    isImageLoading = false,
    fallbackIcon,
    disabled,
    removeLabel,
    previewLabel,
    closePreviewLabel,
    onRemove,
    onAnnotate,
    annotated = false,
    onRevertAnnotation,
  } = props;
  const { t } = useLocale();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [imageLoadState, setImageLoadState] = useState<{
    src: string | null;
    status: "loaded" | "error";
  } | null>(null);
  const previewSlides = useMemo<ImagePreviewSlide[]>(() => {
    if (!imageSrc) return [];
    const workdir = workspaceRoot?.trim() ?? "";
    const absolutePath = file?.absolutePath?.trim() ?? "";
    const relativePath = file?.relativePath.trim() ?? "";
    return [
      {
        src: imageSrc,
        alt: fileName,
        title: fileName,
        fileName,
        sizeBytes: file?.sizeBytes,
        ...(file && workdir && absolutePath && relativePath
          ? {
              attachment: {
                workdir,
                absolutePath,
                relativePath,
              },
            }
          : {}),
      },
    ];
  }, [file, fileName, imageSrc, workspaceRoot]);
  const previewSlide = previewSlides[0];
  const imageLoadFailed = Boolean(
    imageSrc && imageLoadState?.src === imageSrc && imageLoadState.status === "error",
  );
  const canPreview = Boolean(
    imageSrc && imageLoadState?.src === imageSrc && imageLoadState.status === "loaded",
  );

  // 图片附件：纯缩略图方块，点击放大预览，文件名放悬浮提示，角标删除。
  if (imageSrc || isImageLoading) {
    return (
      <div
        title={annotated ? `${fileName} · ${t("chat.annotate.annotated")}` : fileName}
        className={cn(
          "group relative size-12 shrink-0 overflow-hidden",
          "rounded-lg border border-glass-border bg-glass-fill/75 transition-[border-color]",
          "hover:border-glass-border-strong",
          annotated && "border-primary/60 dark:border-primary/60",
        )}
        data-composer-attachment-annotated-state={annotated ? "annotated" : undefined}
      >
        {imageSrc && !imageLoadFailed ? (
          <ImagePreviewContextMenu
            slide={previewSlide}
            disabled={!canPreview}
            onOpen={() => setPreviewOpen(true)}
            onActionError={setActionError}
            trigger={
              <button
                type="button"
                disabled={!canPreview}
                onClick={() => setPreviewOpen(true)}
                className={cn(
                  "block size-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60",
                  canPreview ? "cursor-zoom-in" : "cursor-default",
                )}
                aria-label={previewLabel ? `${previewLabel}: ${fileName}` : fileName}
                title={previewLabel}
              >
                <img
                  src={imageSrc}
                  alt=""
                  draggable={false}
                  className="block size-full object-cover"
                  onLoad={() => setImageLoadState({ src: imageSrc, status: "loaded" })}
                  onError={() => {
                    setImageLoadState({ src: imageSrc, status: "error" });
                  }}
                />
              </button>
            }
          />
        ) : imageLoadFailed ? (
          <span className="flex size-full items-center justify-center text-muted-foreground">
            {fallbackIcon}
          </span>
        ) : (
          <Skeleton render={<span />} className="block size-full bg-glass-fill" />
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className={cn(
            "absolute right-0.5 top-0.5 z-10 inline-flex size-4 items-center justify-center",
            "rounded-full bg-on-media-control text-on-media/95 backdrop-blur-sm transition-[background-color,scale]",
            "hover:bg-on-media-control-hover active:scale-90 focus-visible:bg-on-media-control-hover disabled:pointer-events-none disabled:opacity-35",
          )}
          aria-label={`${removeLabel} ${fileName}`}
          title={removeLabel}
        >
          <X className="size-2.5" />
        </button>
        {onAnnotate && canPreview ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onAnnotate}
            data-composer-attachment-annotate=""
            className={cn(
              cornerActionClassName,
              "bottom-0.5 right-0.5",
              !annotated &&
                "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
            )}
            aria-label={`${t("chat.annotate.actionHint")}: ${fileName}`}
            title={t("chat.annotate.action")}
          >
            <Pencil className="size-2.5" />
          </button>
        ) : null}
        {annotated && onRevertAnnotation ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onRevertAnnotation}
            data-composer-attachment-revert=""
            className={cn(cornerActionClassName, "bottom-0.5 left-0.5")}
            aria-label={`${t("chat.annotate.revert")}: ${fileName}`}
            title={t("chat.annotate.revert")}
          >
            <RotateCcw className="size-2.5" />
          </button>
        ) : null}
        {annotated ? (
          <span className="sr-only" data-composer-attachment-annotated="">
            {t("chat.annotate.annotated")}
          </span>
        ) : null}
        {previewOpen ? (
          <ImagePreview
            open={previewOpen}
            slides={previewSlides}
            closeLabel={closePreviewLabel}
            onClose={() => setPreviewOpen(false)}
          />
        ) : null}
        <ImagePreviewActionFeedback message={actionError} onDismiss={() => setActionError(null)} />
      </div>
    );
  }

  return (
    <div
      title={pathTitle}
      className={cn(
        "group flex h-9 w-36 max-w-viewport-inset-5rem shrink-0 items-center gap-1",
        "rounded-lg border border-glass-border bg-glass-fill/75 p-1 pr-1.5 shadow-ui-composerattachmentcard-1 transition-[border-color,background-color]",
        "hover:border-glass-border-strong/75 hover:bg-glass-fill dark:shadow-ui-composerattachmentcard-2",
      )}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center overflow-hidden",
          "rounded-md bg-glass-fill/95 text-muted-foreground",
        )}
      >
        {fallbackIcon}
      </span>

      <span className="min-w-0 flex-1 truncate text-xs font-medium leading-4 tracking-tight text-foreground/90">
        {fileName}
      </span>

      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center",
          "rounded-full text-muted-foreground/75 outline-hidden transition-[background-color,color,scale]",
          "hover:bg-foreground/[0.07] hover:text-foreground active:scale-90 focus-visible:bg-foreground/[0.07] focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-35",
        )}
        aria-label={`${removeLabel} ${fileName}`}
        title={removeLabel}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
