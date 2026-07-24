import type { ReactNode } from "react";

import { X } from "../icons";

export function ComposerAttachmentCard(props: {
  fileName: string;
  pathTitle: string;
  imageSrc?: string | null;
  isImageLoading?: boolean;
  fallbackIcon: ReactNode;
  disabled: boolean;
  removeLabel: string;
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
    onRemove,
  } = props;

  return (
    <div
      title={pathTitle}
      className="group flex h-16 w-[min(26rem,100%)] shrink-0 items-center gap-2.5 rounded-xl border border-black/[0.075] bg-black/[0.035] p-2 pr-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.64)] transition-[border-color,background-color] hover:border-black/[0.11] hover:bg-black/[0.05] dark:border-white/[0.11] dark:bg-white/[0.065] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.055)] dark:hover:border-white/[0.16] dark:hover:bg-white/[0.09]"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/[0.045] text-muted-foreground dark:bg-white/[0.08]">
        {imageSrc ? (
          <img src={imageSrc} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : isImageLoading ? (
          <span className="h-full w-full animate-pulse bg-black/[0.055] dark:bg-white/[0.09]" />
        ) : (
          fallbackIcon
        )}
      </div>

      <span className="min-w-0 flex-1 truncate text-[calc(13px*var(--zone-font-scale,1))] font-medium leading-5 tracking-tight text-foreground/90">
        {fileName}
      </span>

      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground/75 outline-hidden transition-[background-color,color,scale] hover:bg-foreground/[0.07] hover:text-foreground active:scale-90 focus-visible:bg-foreground/[0.07] focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-35"
        aria-label={`${removeLabel} ${fileName}`}
        title={removeLabel}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
