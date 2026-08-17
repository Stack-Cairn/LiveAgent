import { useMemo, useState } from "react";
import { useLocale } from "../../i18n";
import { formatUploadedFileSize, type PendingUploadedFile } from "../../lib/chat/uploadedFiles";
import {
  type UploadedImagePreviewLoader,
  useUploadedImagePreview,
} from "../../lib/chat/uploadedImagePreview";
import { cn } from "../../lib/shared/utils";
import { X } from "../IconSet";
import { getUploadedFileTypeIcon } from "./fileTypeIcons";
import {
  ImagePreview,
  ImagePreviewActionFeedback,
  ImagePreviewContextMenu,
  type ImagePreviewSlide,
} from "./ImagePreview";

type ImagePreviewMode = "absolutePath" | "imageKind";

export function createUserAttachmentImagePreviewSlide(
  file: PendingUploadedFile,
  imageSrc: string | null,
  workspaceRoot?: string,
): ImagePreviewSlide | null {
  if (!imageSrc) return null;
  const workdir = workspaceRoot?.trim() ?? "";
  const absolutePath = file.absolutePath?.trim() ?? "";
  const relativePath = file.relativePath.trim();
  return {
    src: imageSrc,
    alt: file.fileName,
    title: file.fileName,
    fileName: file.fileName,
    sizeBytes: file.sizeBytes,
    ...(workdir && absolutePath && relativePath
      ? {
          attachment: {
            workdir,
            absolutePath,
            relativePath,
          },
        }
      : {}),
  };
}

function UserImageAttachmentCard(props: {
  file: PendingUploadedFile;
  imageSrc: string | null;
  workspaceRoot?: string;
  isLoading: boolean;
  compact: boolean;
  onRemove?: (relativePath: string) => void;
  removeLabel?: string;
  previewLabel: string;
  closePreviewLabel: string;
}) {
  const {
    file,
    imageSrc,
    workspaceRoot,
    isLoading,
    compact,
    onRemove,
    removeLabel,
    previewLabel,
    closePreviewLabel,
  } = props;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [imageLoadState, setImageLoadState] = useState<{
    src: string | null;
    status: "loaded" | "error";
  } | null>(null);
  const labeledPreview = `${previewLabel}: ${file.fileName}`;
  const FallbackIcon = getUploadedFileTypeIcon(file);
  const previewSlides = useMemo<ImagePreviewSlide[]>(() => {
    const slide = createUserAttachmentImagePreviewSlide(file, imageSrc, workspaceRoot);
    return slide ? [slide] : [];
  }, [file, imageSrc, workspaceRoot]);
  const previewSlide = previewSlides[0];
  const imageLoadFailed = Boolean(
    imageSrc && imageLoadState?.src === imageSrc && imageLoadState.status === "error",
  );
  const canPreview = Boolean(
    imageSrc && imageLoadState?.src === imageSrc && imageLoadState.status === "loaded",
  );

  return (
    <div
      title={file.relativePath}
      className={cn(
        "group relative overflow-hidden rounded-xl border border-white/60 bg-white/75 dark:border-white/[0.12] dark:bg-white/[0.06]",
        compact ? "min-w-0 basis-[calc(33.333%-5.33px)] grow" : "w-full max-w-[280px]",
      )}
    >
      {onRemove ? (
        <button
          type="button"
          onClick={() => onRemove(file.relativePath)}
          className="absolute top-1.5 right-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-black/30 text-white/90 opacity-0 backdrop-blur-sm transition-all hover:bg-black/45 group-hover:opacity-100"
          aria-label={removeLabel ?? file.fileName}
          title={removeLabel}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
      {imageSrc ? (
        <>
          {imageLoadFailed ? (
            <div
              className={cn(
                "flex w-full items-center justify-center bg-black/[0.02] dark:bg-white/5",
                compact ? "h-28" : "h-36",
              )}
            >
              <FallbackIcon className="h-5 w-5" />
            </div>
          ) : (
            <button
              type="button"
              className={cn(
                "block w-full overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
                canPreview ? "cursor-zoom-in" : "cursor-default",
              )}
              aria-label={labeledPreview}
              title={labeledPreview}
              disabled={!canPreview}
              onClick={() => setPreviewOpen(true)}
              onContextMenu={(event) => {
                if (!canPreview) return;
                event.preventDefault();
                setContextMenu({ x: event.clientX, y: event.clientY });
              }}
            >
              <img
                src={imageSrc}
                alt={file.fileName}
                className={cn(
                  "block w-full bg-black/[0.02] dark:bg-white/5",
                  compact ? "h-28 object-cover" : "max-h-56 object-contain",
                )}
                onLoad={() => setImageLoadState({ src: imageSrc, status: "loaded" })}
                onError={() => {
                  setImageLoadState({ src: imageSrc, status: "error" });
                  setContextMenu(null);
                }}
              />
            </button>
          )}
          {previewOpen ? (
            <ImagePreview
              open={previewOpen}
              slides={previewSlides}
              closeLabel={closePreviewLabel}
              onClose={() => setPreviewOpen(false)}
            />
          ) : null}
          {contextMenu && previewSlide ? (
            <ImagePreviewContextMenu
              slide={previewSlide}
              position={contextMenu}
              onOpen={() => setPreviewOpen(true)}
              onClose={() => setContextMenu(null)}
              onActionError={setActionError}
            />
          ) : null}
          <ImagePreviewActionFeedback
            message={actionError}
            onDismiss={() => setActionError(null)}
          />
        </>
      ) : (
        <div
          className={cn(
            "flex w-full items-center justify-center bg-black/[0.02] dark:bg-white/5",
            compact ? "h-28" : "h-36",
          )}
        >
          <div
            className={
              isLoading
                ? "h-16 w-16 animate-pulse rounded-xl bg-black/5 dark:bg-white/10"
                : "flex h-10 w-10 items-center justify-center rounded-xl bg-black/[0.03] dark:bg-white/10"
            }
          >
            {isLoading ? null : <FallbackIcon className="h-5 w-5" />}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-tight text-[hsl(var(--chat-user-fg)/0.85)]">
            {file.fileName}
          </div>
        </div>
        <span className="shrink-0 text-[calc(10px*var(--zone-font-scale,1))] tabular-nums text-[hsl(var(--chat-user-fg)/0.4)]">
          {formatUploadedFileSize(file.sizeBytes)}
        </span>
      </div>
    </div>
  );
}

function UserFileAttachmentCard(props: {
  file: PendingUploadedFile;
  onRemove?: (relativePath: string) => void;
  removeLabel?: string;
  compact: boolean;
}) {
  const { file, onRemove, removeLabel, compact } = props;
  const TypeIcon = getUploadedFileTypeIcon(file);

  return (
    <div
      title={file.relativePath}
      className={cn(
        "group relative flex items-center gap-2 rounded-xl border border-white/60 bg-white/75 px-2.5 py-2 text-left shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] transition-shadow hover:shadow-[0_2px_8px_rgba(0,0,0,0.1)] dark:border-white/[0.12] dark:bg-white/[0.06]",
        compact ? "min-w-0 basis-[calc(33.333%-5.33px)] grow" : "w-full",
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b from-black/[0.03] to-black/[0.06] dark:from-white/[0.06] dark:to-white/[0.1]">
        <TypeIcon className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-tight text-[hsl(var(--chat-user-fg)/0.85)]">
          {file.fileName}
        </div>
        <div className="mt-0.5 text-[calc(10px*var(--zone-font-scale,1))] tabular-nums leading-tight text-[hsl(var(--chat-user-fg)/0.4)]">
          {formatUploadedFileSize(file.sizeBytes)}
        </div>
      </div>
      {onRemove ? (
        <button
          type="button"
          onClick={() => onRemove(file.relativePath)}
          className="absolute top-1/2 right-1.5 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-[hsl(var(--chat-user-fg)/0.3)] opacity-0 transition-all hover:bg-black/5 hover:text-[hsl(var(--chat-user-fg)/0.6)] group-hover:opacity-100 dark:hover:bg-white/10"
          aria-label={removeLabel ?? file.fileName}
          title={removeLabel}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function UserAttachmentCard(props: {
  file: PendingUploadedFile;
  workspaceRoot?: string;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  imagePreviewMode: ImagePreviewMode;
  compactImageLayout: boolean;
  compactFileLayout: boolean;
  onRemove?: (relativePath: string) => void;
  removeLabel?: string;
  previewLabel: string;
  closePreviewLabel: string;
}) {
  const {
    file,
    workspaceRoot,
    onLoadUploadedImagePreview,
    imagePreviewMode,
    compactImageLayout,
    compactFileLayout,
    onRemove,
    removeLabel,
    previewLabel,
    closePreviewLabel,
  } = props;
  const hasWorkspaceRoot = typeof workspaceRoot === "string" && Boolean(workspaceRoot.trim());
  const hasAbsolutePath =
    typeof file.absolutePath === "string" && Boolean(file.absolutePath.trim());
  const shouldPreviewImage =
    file.kind === "image" &&
    hasWorkspaceRoot &&
    Boolean(onLoadUploadedImagePreview) &&
    (imagePreviewMode === "imageKind" || hasAbsolutePath);
  const { imageSrc, isLoading } = useUploadedImagePreview(
    shouldPreviewImage ? file : undefined,
    shouldPreviewImage ? workspaceRoot : undefined,
    onLoadUploadedImagePreview,
  );

  if (shouldPreviewImage) {
    return (
      <UserImageAttachmentCard
        file={file}
        imageSrc={imageSrc}
        workspaceRoot={workspaceRoot}
        isLoading={isLoading}
        compact={compactImageLayout}
        onRemove={onRemove}
        removeLabel={removeLabel}
        previewLabel={previewLabel}
        closePreviewLabel={closePreviewLabel}
      />
    );
  }

  return (
    <UserFileAttachmentCard
      file={file}
      onRemove={onRemove}
      removeLabel={removeLabel}
      compact={compactFileLayout}
    />
  );
}

export function UserAttachmentCards(props: {
  files: PendingUploadedFile[];
  workspaceRoot?: string;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  imagePreviewMode?: ImagePreviewMode;
  onRemove?: (relativePath: string) => void;
  removeLabel?: string;
}) {
  const {
    files,
    workspaceRoot,
    onLoadUploadedImagePreview,
    imagePreviewMode = "absolutePath",
    onRemove,
    removeLabel: explicitRemoveLabel,
  } = props;
  const { t } = useLocale();
  if (files.length === 0) return null;

  const imageFiles = files.filter((file) => file.kind === "image");
  const otherFiles = files.filter((file) => file.kind !== "image");
  const compactImageLayout = imageFiles.length > 1;
  const compactFileLayout = otherFiles.length > 1;
  const removeLabel = explicitRemoveLabel ?? (onRemove ? t("chat.upload.removeFile") : undefined);
  const previewLabel = t("chat.upload.previewImage");
  const closePreviewLabel = t("chat.upload.closePreview");

  return (
    <div className="mb-2 flex flex-col gap-2">
      {imageFiles.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {imageFiles.map((file) => (
            <UserAttachmentCard
              key={`${file.relativePath}-${file.absolutePath ?? file.fileName}`}
              file={file}
              workspaceRoot={workspaceRoot}
              onLoadUploadedImagePreview={onLoadUploadedImagePreview}
              imagePreviewMode={imagePreviewMode}
              compactImageLayout={compactImageLayout}
              compactFileLayout={false}
              onRemove={onRemove}
              removeLabel={removeLabel}
              previewLabel={previewLabel}
              closePreviewLabel={closePreviewLabel}
            />
          ))}
        </div>
      ) : null}
      {otherFiles.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {otherFiles.map((file) => (
            <UserAttachmentCard
              key={`${file.relativePath}-${file.absolutePath ?? file.fileName}`}
              file={file}
              workspaceRoot={workspaceRoot}
              onLoadUploadedImagePreview={onLoadUploadedImagePreview}
              imagePreviewMode={imagePreviewMode}
              compactImageLayout={false}
              compactFileLayout={compactFileLayout}
              onRemove={onRemove}
              removeLabel={removeLabel}
              previewLabel={previewLabel}
              closePreviewLabel={closePreviewLabel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
