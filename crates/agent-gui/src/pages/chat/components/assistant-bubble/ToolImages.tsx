import type { ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { useEffect, useMemo, useState } from "react";

import { ImagePreview, type ImagePreviewSlide } from "../../../../components/chat/ImagePreview";
import { ImageOff, Loader2 } from "../../../../components/icons";
import { useLocale } from "../../../../i18n";
import type { ToolTraceItem } from "../../../../lib/chat/messages/uiMessages";
import { prepareImageProxyUrl } from "../../../../lib/providers/proxy";
import { cn } from "../../../../lib/shared/utils";
import type {
  DisplayImageItemDetails,
  DisplayImageResultDetails,
} from "../../../../lib/tools/builtinTypes";
import { getBuiltinResultKind } from "./assistantBubbleUtils";

export function getToolResultImages(result?: ToolResultMessage) {
  if (!result) return [];
  return result.content.filter((block): block is ImageContent => block.type === "image");
}

export type NativeDisplayImageEntry = {
  detail: DisplayImageItemDetails;
  image?: ImageContent;
};

type NativeDisplayImageProxyRequest = {
  index: number;
  source: string;
};

export type NativeDisplayImageSourceState = {
  src: string;
  status: "loading" | "ready" | "error";
};

type ToolImageLoadState = "loading" | "loaded" | "error";

function getImageDataUrl(image: ImageContent) {
  return `data:${image.mimeType};base64,${image.data}`;
}

function isDisplayImageItemDetails(value: unknown): value is DisplayImageItemDetails {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

function getDisplayImageDetails(result: ToolResultMessage): DisplayImageItemDetails[] {
  const details = result.details as DisplayImageResultDetails | undefined;
  if (!details || details.kind !== "display_image" || !Array.isArray(details.images)) {
    return [];
  }
  return details.images.filter(isDisplayImageItemDetails);
}

function shouldRenderDisplayImageThroughProxy(detail: DisplayImageItemDetails) {
  return detail.renderMode === "proxy" || detail.sourceType === "url";
}

function getProxyImageSource(detail: DisplayImageItemDetails) {
  if (!shouldRenderDisplayImageThroughProxy(detail)) return "";
  const source = (detail.sourceUrl || detail.path || "").trim();
  return /^https?:\/\//i.test(source) ? source : "";
}

function getNativeDisplayImageEntries(result: ToolResultMessage): NativeDisplayImageEntry[] {
  const inlineImages = getToolResultImages(result);
  const detailImages = getDisplayImageDetails(result);
  if (detailImages.length > 0) {
    let inlineImageIndex = 0;
    const entries = detailImages
      .map((detail) => {
        if (shouldRenderDisplayImageThroughProxy(detail)) {
          return { detail, image: undefined };
        }
        const image = inlineImages[inlineImageIndex];
        inlineImageIndex += 1;
        return { detail, image };
      })
      .filter((entry) => Boolean(entry.image) || Boolean(getProxyImageSource(entry.detail)));
    if (entries.length > 0) return entries;
  }
  return inlineImages.map((image, index) => ({
    image,
    detail: {
      path: `inline-image-${index + 1}`,
      renderMode: "inline",
      mimeType: image.mimeType,
      sizeBytes: Math.ceil((image.data.length * 3) / 4),
    },
  }));
}

function getNativeDisplayImageProxyKey(entries: NativeDisplayImageEntry[]) {
  const requests = entries
    .map((entry, index) => {
      const source = getProxyImageSource(entry.detail);
      return source ? { index, source } : null;
    })
    .filter((request): request is NativeDisplayImageProxyRequest => request !== null);
  return JSON.stringify(requests);
}

function parseNativeDisplayImageProxyKey(proxyKey: string): NativeDisplayImageProxyRequest[] {
  if (!proxyKey || proxyKey === "[]") return [];
  try {
    const parsed = JSON.parse(proxyKey);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is NativeDisplayImageProxyRequest =>
        item !== null &&
        typeof item === "object" &&
        typeof item.index === "number" &&
        Number.isInteger(item.index) &&
        item.index >= 0 &&
        typeof item.source === "string" &&
        item.source.length > 0,
    );
  } catch {
    return [];
  }
}

function useNativeDisplayImageSources(entries: NativeDisplayImageEntry[]) {
  const proxyKey = getNativeDisplayImageProxyKey(entries);
  const [proxySources, setProxySources] = useState<Record<number, NativeDisplayImageSourceState>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    const pending = parseNativeDisplayImageProxyKey(proxyKey);

    if (pending.length === 0) {
      setProxySources({});
      return;
    }

    setProxySources(
      Object.fromEntries(
        pending.map(({ index }) => [index, { src: "", status: "loading" as const }]),
      ),
    );
    void Promise.all(
      pending.map(async ({ index, source }) => {
        try {
          const preparedSource = await prepareImageProxyUrl(source);
          return [
            index,
            preparedSource
              ? { src: preparedSource, status: "ready" as const }
              : { src: "", status: "error" as const },
          ] as const;
        } catch {
          return [index, { src: "", status: "error" as const }] as const;
        }
      }),
    ).then((items) => {
      if (cancelled) return;
      const next: Record<number, NativeDisplayImageSourceState> = {};
      for (const [index, source] of items) {
        next[index] = source;
      }
      setProxySources(next);
    });

    return () => {
      cancelled = true;
    };
  }, [proxyKey]);

  return entries.map((entry, index) => {
    if (entry.image) {
      return { src: getImageDataUrl(entry.image), status: "ready" as const };
    }
    if (!getProxyImageSource(entry.detail)) {
      return { src: "", status: "error" as const };
    }
    return proxySources[index] ?? { src: "", status: "loading" as const };
  });
}

function estimateBase64Bytes(data: string) {
  return Math.ceil((data.length * 3) / 4);
}

function formatToolResultBytes(sizeBytes: number) {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${Math.round(sizeBytes / 1024)} KB`;
  }
  return `${sizeBytes} B`;
}

function getInitialImageLoadState(source: NativeDisplayImageSourceState): ToolImageLoadState {
  if (source.status === "error") return "error";
  if (source.status === "ready" && !source.src) return "error";
  return "loading";
}

function formatDisplayImageLabel(t: (key: string) => string, imageCount: number, index: number) {
  if (imageCount <= 1) return t("chat.image.display");
  return t("chat.image.displayNumber").replace("{index}", String(index + 1));
}

function ToolImageStatusCard(props: {
  status: "loading" | "error";
  title?: string;
  detail?: string;
  className?: string;
}) {
  const { status, title, detail, className } = props;
  const { t } = useLocale();
  const isError = status === "error";
  const Icon = isError ? ImageOff : Loader2;

  return (
    <div
      className={cn(
        "relative flex min-h-28 w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-[8px] border border-dashed px-4 py-5 text-center",
        isError
          ? "border-red-500/25 bg-red-500/[0.04] text-red-700 dark:border-red-400/25 dark:bg-red-400/[0.06] dark:text-red-300"
          : "border-black/[0.08] bg-black/[0.025] text-muted-foreground dark:border-white/[0.1] dark:bg-white/[0.035]",
        className,
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-[8px] border bg-white/80 shadow-sm dark:bg-black/20",
          isError ? "border-red-500/20" : "border-black/[0.06] dark:border-white/[0.08]",
        )}
      >
        <Icon className={cn("h-4 w-4", !isError && "animate-spin text-primary")} />
      </div>
      <div className="max-w-full space-y-1">
        <div className="text-[calc(12px*var(--zone-font-scale,1))] font-medium">
          {title ?? (isError ? t("chat.image.unavailable") : t("chat.image.loading"))}
        </div>
        {detail ? (
          <div
            className={cn(
              "max-w-full truncate text-[calc(11px*var(--zone-font-scale,1))]",
              isError ? "text-red-700/75 dark:text-red-200/75" : "text-muted-foreground",
            )}
            title={detail}
          >
            {detail}
          </div>
        ) : null}
      </div>
      {!isError ? (
        <div className="h-1 w-24 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-primary/55" />
        </div>
      ) : null}
    </div>
  );
}

export function ToolResultImagePreview(props: {
  image: ImageContent;
  alt: string;
  id: string;
  sizeBytes?: number;
}) {
  const { image, alt, id, sizeBytes } = props;
  const { t } = useLocale();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageStatus, setImageStatus] = useState<ToolImageLoadState>("loading");
  const src = getImageDataUrl(image);
  const estimatedBytes = sizeBytes ?? estimateBase64Bytes(image.data);
  const imageDetail = `${alt} · ${formatToolResultBytes(estimatedBytes)}`;
  const slides = useMemo<ImagePreviewSlide[]>(
    () => [
      {
        src,
        alt,
        title: alt,
      },
    ],
    [alt, src],
  );

  useEffect(() => {
    setImageStatus(src ? "loading" : "error");
    setPreviewOpen(false);
  }, [src]);

  const canPreview = imageStatus === "loaded";

  return (
    <>
      <button
        type="button"
        className={cn(
          "relative block w-full overflow-hidden rounded-[8px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:opacity-100",
          canPreview ? "cursor-zoom-in" : "cursor-default",
        )}
        disabled={!canPreview}
        onClick={() => {
          if (canPreview) setPreviewOpen(true);
        }}
        title={alt}
        aria-label={
          canPreview ? `${t("chat.image.preview")} ${alt}` : `${t("chat.image.loading")} ${alt}`
        }
      >
        <div className={cn("relative w-full", imageStatus !== "loaded" && "min-h-32")}>
          {imageStatus !== "loaded" ? (
            <ToolImageStatusCard
              status={imageStatus === "error" ? "error" : "loading"}
              title={
                imageStatus === "error" ? t("chat.image.unavailable") : t("chat.image.loading")
              }
              detail={imageStatus === "error" ? t("chat.image.checkGenerated") : imageDetail}
              className="absolute inset-0 min-h-32"
            />
          ) : null}
          {imageStatus !== "error" ? (
            <img
              key={id}
              src={src}
              alt={alt}
              loading="lazy"
              decoding="async"
              className={cn(
                "max-h-72 w-full rounded-[8px] object-contain transition-opacity duration-200",
                imageStatus === "loaded"
                  ? "opacity-100"
                  : "pointer-events-none absolute inset-0 h-full max-h-none opacity-0",
              )}
              onLoad={() => setImageStatus("loaded")}
              onError={() => setImageStatus("error")}
            />
          ) : null}
        </div>
      </button>
      {previewOpen ? (
        <ImagePreview open={previewOpen} slides={slides} onClose={() => setPreviewOpen(false)} />
      ) : null}
    </>
  );
}

export function getNativeDisplayImagePayload(item: ToolTraceItem) {
  const result = item.toolResult;
  if (!result || result.isError || getBuiltinResultKind(result) !== "display_image") {
    return null;
  }

  const entries = getNativeDisplayImageEntries(result);
  if (entries.length === 0) {
    return null;
  }

  return {
    details: result.details as DisplayImageResultDetails,
    entries,
  };
}

function getNativeImageGridClass(imageCount: number) {
  if (imageCount <= 1) {
    return "my-1 flex max-w-full flex-col items-start gap-2";
  }
  if (imageCount === 2) {
    return "my-1 grid w-full max-w-3xl grid-cols-2 gap-2";
  }
  if (imageCount === 3) {
    return "my-1 grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-3";
  }
  if (imageCount === 4) {
    return "my-1 grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-4";
  }
  if (imageCount === 5) {
    return "my-1 grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5";
  }
  return "my-1 grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6";
}

function isSvgDisplayImageEntry(entry: NativeDisplayImageEntry) {
  const mimeType = entry.image?.mimeType || entry.detail.mimeType || "";
  return mimeType.split(";")[0]?.trim().toLowerCase() === "image/svg+xml";
}

function NativeDisplayImageTile(props: {
  source: NativeDisplayImageSourceState;
  alt: string;
  isGallery: boolean;
  isSvgImage: boolean;
  loading: "lazy" | "eager";
  onPreview: () => void;
}) {
  const { source, alt, isGallery, isSvgImage, loading, onPreview } = props;
  const { src, status } = source;
  const { t } = useLocale();
  const [imageStatus, setImageStatus] = useState<ToolImageLoadState>(() =>
    getInitialImageLoadState({ src, status }),
  );

  useEffect(() => {
    setImageStatus(getInitialImageLoadState({ src, status }));
  }, [src, status]);

  const canPreview = status === "ready" && imageStatus === "loaded";
  const isWaiting = !canPreview;
  const statusTitle =
    imageStatus === "error"
      ? t("chat.image.unavailable")
      : status === "loading"
        ? t("chat.image.preparing")
        : t("chat.image.loading");

  return (
    <button
      type="button"
      className={cn(
        "relative flex max-w-full items-center justify-center overflow-hidden rounded-[10px] text-left shadow-sm transition-[filter,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:opacity-100",
        canPreview
          ? "cursor-zoom-in hover:brightness-[0.98]"
          : "cursor-default hover:brightness-100",
        isGallery && "aspect-square w-full bg-muted/30",
        !isGallery && (isSvgImage || isWaiting) && "min-h-28 w-full max-w-3xl bg-muted/30",
        imageStatus === "error" && "shadow-none",
      )}
      disabled={!canPreview}
      aria-label={canPreview ? `${t("chat.image.preview")} ${alt}` : statusTitle}
      onClick={() => {
        if (canPreview) onPreview();
      }}
    >
      {source.status === "ready" && source.src && imageStatus !== "error" ? (
        <img
          src={source.src}
          alt={alt}
          loading={loading}
          decoding="async"
          className={cn(
            "block object-contain transition-opacity duration-200",
            isGallery
              ? "absolute inset-0 h-full w-full p-1"
              : isSvgImage
                ? "h-auto max-h-[32rem] w-full max-w-full p-1"
                : "h-auto max-h-[32rem] max-w-full",
            imageStatus === "loaded"
              ? "opacity-100"
              : "pointer-events-none absolute inset-0 h-full w-full max-h-none opacity-0",
          )}
          onLoad={() => setImageStatus("loaded")}
          onError={() => setImageStatus("error")}
        />
      ) : null}
      {imageStatus !== "loaded" ? (
        <ToolImageStatusCard
          status={imageStatus === "error" ? "error" : "loading"}
          title={statusTitle}
          detail={imageStatus === "error" ? t("chat.image.checkSource") : alt}
          className={cn(
            "rounded-[10px]",
            isGallery ? "absolute inset-0 min-h-0" : "min-h-28 w-full max-w-3xl",
          )}
        />
      ) : null}
    </button>
  );
}

export function NativeDisplayImageBlock(props: {
  payload: NonNullable<ReturnType<typeof getNativeDisplayImagePayload>>;
}) {
  const { payload } = props;
  const { t } = useLocale();
  const isGallery = payload.entries.length > 1;
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const imageSources = useNativeDisplayImageSources(payload.entries);
  const slides = useMemo<ImagePreviewSlide[]>(
    () =>
      payload.entries.map((_entry, index) => ({
        src: imageSources[index]?.src ?? "",
        alt: formatDisplayImageLabel(t, payload.entries.length, index),
        title: formatDisplayImageLabel(t, payload.entries.length, index),
      })),
    [imageSources, payload.entries, t],
  );

  return (
    <>
      <div className={getNativeImageGridClass(payload.entries.length)}>
        {payload.entries.map((entry, index) => {
          const id = entry.image
            ? `${entry.image.mimeType}-${entry.image.data.length}-${index}`
            : `${entry.detail.sourceUrl ?? entry.detail.path}-${index}`;
          const slide = slides[index];
          const alt = slide?.alt ?? formatDisplayImageLabel(t, payload.entries.length, index);
          const isSvgImage = isSvgDisplayImageEntry(entry);
          return (
            <NativeDisplayImageTile
              key={id}
              source={imageSources[index] ?? { src: "", status: "loading" }}
              alt={alt}
              isGallery={isGallery}
              isSvgImage={isSvgImage}
              loading={isGallery ? "eager" : "lazy"}
              onPreview={() => setPreviewIndex(index)}
            />
          );
        })}
      </div>
      {previewIndex !== null ? (
        <ImagePreview
          open={previewIndex !== null}
          slides={slides}
          index={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}
    </>
  );
}
