import { type ReactNode, useMemo, useState } from "react";

import { X } from "../icons";
import { ImagePreview, type ImagePreviewSlide } from "./ImagePreview";

export function ComposerAttachmentCard(props: {
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
}) {
  const {
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
  } = props;
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewSlides = useMemo<ImagePreviewSlide[]>(
    () => (imageSrc ? [{ src: imageSrc, alt: fileName, title: fileName }] : []),
    [fileName, imageSrc],
  );

  // 图片附件：纯缩略图方块，点击放大预览，文件名放悬浮提示，角标删除。
  if (imageSrc || isImageLoading) {
    return (
      <div
        title={fileName}
        className="group relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-black/[0.075] bg-black/[0.035] transition-[border-color] hover:border-black/[0.16] dark:border-white/[0.11] dark:bg-white/[0.065] dark:hover:border-white/[0.22]"
      >
        {imageSrc ? (
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="block h-full w-full cursor-zoom-in outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label={previewLabel ? `${previewLabel}: ${fileName}` : fileName}
            title={previewLabel}
          >
            <img src={imageSrc} alt="" draggable={false} className="h-full w-full object-cover" />
          </button>
        ) : (
          <span className="block h-full w-full animate-pulse bg-black/[0.055] dark:bg-white/[0.09]" />
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className="absolute right-0.5 top-0.5 z-10 inline-flex h-4 w-4 items-center justify-center rounded-full bg-black/50 text-white/95 backdrop-blur-sm transition-[background-color,scale] hover:bg-black/70 active:scale-90 focus-visible:bg-black/70 disabled:pointer-events-none disabled:opacity-35"
          aria-label={`${removeLabel} ${fileName}`}
          title={removeLabel}
        >
          <X className="h-2.5 w-2.5" />
        </button>
        {previewOpen ? (
          <ImagePreview
            open={previewOpen}
            slides={previewSlides}
            closeLabel={closePreviewLabel}
            onClose={() => setPreviewOpen(false)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      title={pathTitle}
      className="group flex h-9 w-36 max-w-[calc(100vw-5rem)] shrink-0 items-center gap-1 rounded-lg border border-black/[0.075] bg-black/[0.035] p-1 pr-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.64)] transition-[border-color,background-color] hover:border-black/[0.11] hover:bg-black/[0.05] dark:border-white/[0.11] dark:bg-white/[0.065] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.055)] dark:hover:border-white/[0.16] dark:hover:bg-white/[0.09]"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black/[0.045] text-muted-foreground dark:bg-white/[0.08]">
        {fallbackIcon}
      </span>

      <span className="min-w-0 flex-1 truncate text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-4 tracking-tight text-foreground/90">
        {fileName}
      </span>

      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/75 outline-hidden transition-[background-color,color,scale] hover:bg-foreground/[0.07] hover:text-foreground active:scale-90 focus-visible:bg-foreground/[0.07] focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-35"
        aria-label={`${removeLabel} ${fileName}`}
        title={removeLabel}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
