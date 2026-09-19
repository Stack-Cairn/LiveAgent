import {
  copyImagePreviewData,
  copyUploadedImagePreview,
  openUploadedImageInSystemViewer,
  prepareImagePreviewSave,
  supportsDirectUploadedImageCopy,
  supportsSystemImageOpen,
} from "@liveagent/adapters/imagePreview";
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import { useLocale } from "../../i18n";
import { copyTextToClipboard as copySharedTextToClipboard } from "../../lib/shared/clipboard";
import { Copy, Download, ExternalLink, Maximize2 } from "../IconSet";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { toast } from "../ui/toast-manager";
import {
  getImagePreviewCapabilities,
  getImagePreviewFileName,
  getImagePreviewMimeType,
  type ImagePreviewSlide,
  isVerifiedImagePreviewAttachment,
  resolveImagePreviewData,
} from "./imagePreviewModel";

type ImagePreviewDataResolver = (
  slide: ImagePreviewSlide,
) => ReturnType<typeof resolveImagePreviewData>;
export const ImagePreviewMenuItem = ContextMenuItem;

export function toMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? "").trim();
  return text || fallback;
}

async function copyTextToClipboard(value: string) {
  if (!(await copySharedTextToClipboard(value))) {
    throw new Error("Text clipboard is unavailable");
  }
}

export async function saveImagePreviewSlide(
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

export async function copyImagePreviewSlide(
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

export async function openImagePreviewSlideInSystemViewer(slide: ImagePreviewSlide) {
  if (!isVerifiedImagePreviewAttachment(slide.attachment)) {
    throw new Error("This image is not a verified uploaded attachment");
  }
  await openUploadedImageInSystemViewer({
    workdir: slide.attachment.workdir,
    absolutePath: slide.attachment.absolutePath,
  });
}

export function ImagePreviewActionFeedback(props: {
  message: string | null;
  onDismiss: () => void;
}) {
  const dismissRef = useRef(props.onDismiss);
  dismissRef.current = props.onDismiss;
  useEffect(() => {
    if (!props.message) return;
    let active = true;
    const id = toast.error(props.message, {
      onDismiss: () => {
        if (active) dismissRef.current();
      },
    });
    return () => {
      active = false;
      toast.dismiss(id);
    };
  }, [props.message]);
  return null;
}

export function runImagePreviewAction(params: {
  action: () => Promise<void>;
  fallback: string;
  onActionError: (message: string) => void;
}) {
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
  slide?: ImagePreviewSlide;
  trigger: ReactElement;
  disabled?: boolean;
  onOpen?: () => void;
  onActionError: (message: string) => void;
  children?: ReactNode;
  portalContainer?: HTMLElement | null;
}) {
  const { slide, trigger, disabled, onOpen, onActionError, children, portalContainer } = props;
  const { t } = useLocale();
  const capabilities = slide ? getImagePreviewCapabilities(slide, supportsSystemImageOpen) : null;
  const run = (action: () => Promise<void>, fallback: string) => {
    void runImagePreviewAction({
      action,
      fallback,
      onActionError,
    });
  };
  return (
    <ContextMenu disabled={disabled || !slide}>
      <ContextMenuTrigger render={trigger} />
      {slide && capabilities ? (
        <ContextMenuContent
          variant="soft"
          portalContainer={portalContainer}
          className="pointer-events-auto [&_[role=menuitem]]:gap-2"
          collisionPadding={8}
        >
          {children}
          {onOpen ? (
            <ImagePreviewMenuItem onClick={onOpen}>
              <Maximize2 className="size-3.5" />
              {t("chat.imageViewer.open")}
            </ImagePreviewMenuItem>
          ) : null}
          {capabilities.canSave ? (
            <ImagePreviewMenuItem
              onClick={() =>
                run(() => saveImagePreviewSlide(slide), t("chat.imageViewer.saveFailed"))
              }
            >
              <Download className="size-3.5" />
              {t("chat.imageViewer.save")}
            </ImagePreviewMenuItem>
          ) : null}
          {capabilities.canCopyImage ? (
            <ImagePreviewMenuItem
              onClick={() =>
                run(() => copyImagePreviewSlide(slide), t("chat.imageViewer.copyFailed"))
              }
            >
              <Copy className="size-3.5" />
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
              <Copy className="size-3.5" />
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
              <Copy className="size-3.5" />
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
              <ExternalLink className="size-3.5" />
              {t("chat.imageViewer.openSystem")}
            </ImagePreviewMenuItem>
          ) : null}
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}
