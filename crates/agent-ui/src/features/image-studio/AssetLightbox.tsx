import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ImagePreviewSlide } from "../../components/chat/imagePreviewModel";
import { Loader2, X } from "../../components/IconSet";
import { useLocale } from "../../i18n";
import type { ImageAsset, ImageStudioClient } from "../../lib/imaging/types";
import { formatMessage, message } from "./studioText";

// Reuses the chat lightbox (zoom, pan, slide switching, save/copy). Loaded on first
// open so the workbench does not pull the viewer into its initial bundle.
const ImagePreview = lazy(() =>
  import("../../components/chat/ImagePreview").then((module) => ({ default: module.ImagePreview })),
);

const extension = (mime: string) =>
  mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";

function Loading({ label, onClose }: { label: string; onClose: () => void }) {
  const { t } = useLocale();
  // A stalled read must never trap the user behind the overlay.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="status"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 text-sm text-white"
    >
      <Loader2 className="mr-2 size-5 animate-spin motion-reduce:animate-none" />
      {label}
      <button
        type="button"
        aria-label={t("imageStudio.lightbox.close")}
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 hover:bg-white/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white"
      >
        <X className="size-5" />
      </button>
    </div>
  );
}

export function AssetLightbox({
  client,
  assetIds,
  index,
  title,
  assets,
  open,
  onClose,
  onFailed,
}: {
  client: ImageStudioClient;
  assetIds: string[];
  index: number;
  title: string;
  assets: Record<string, ImageAsset>;
  open: boolean;
  onClose: () => void;
  /** Every original failed to load; the viewer closes and the host reports it. */
  onFailed?: () => void;
}) {
  // Slides keep their asset id so a failed sibling never shifts the start position.
  const [loaded, setSlides] = useState<
    (Omit<ImagePreviewSlide, "alt"> & { assetId: string; position: number })[] | null
  >(null);
  const { t } = useLocale();
  const key = assetIds.join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined key stands in for the id list
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const urls: string[] = [];
    setSlides(null);
    void Promise.all(
      assetIds.map(async (id, position) => {
        try {
          const blob = await client.readAsset(id, "original", controller.signal);
          if (controller.signal.aborted) return null;
          const src = URL.createObjectURL(blob);
          urls.push(src);
          const meta = assets[id];
          return {
            assetId: id,
            position,
            src,
            title,
            mimeType: blob.type || meta?.mime,
            sizeBytes: blob.size,
            width: meta?.width,
            height: meta?.height,
            fileName: `${id}.${extension(blob.type || meta?.mime || "")}`,
          };
        } catch {
          return null;
        }
      }),
    ).then((loaded) => {
      if (controller.signal.aborted) return;
      const available = loaded.filter((slide) => slide !== null);
      if (available.length) setSlides(available);
      else {
        onClose();
        onFailed?.();
      }
    });
    return () => {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [open, client, key, title]);
  // Labelled at render time: a language switch must not re-download the originals.
  const slides = useMemo(
    () =>
      loaded?.map(({ position, ...slide }) => ({
        ...slide,
        alt: formatMessage(
          message("imageStudio.lightbox.slideAlt", { title, index: position + 1 }),
          t,
        ),
      })) ?? null,
    [loaded, title, t],
  );
  if (!open) return null;
  if (!slides) return <Loading label={t("imageStudio.lightbox.loading")} onClose={onClose} />;
  const start = Math.max(
    0,
    slides.findIndex((slide) => slide.assetId === assetIds[index]),
  );
  return (
    <Suspense fallback={<Loading label={t("imageStudio.lightbox.opening")} onClose={onClose} />}>
      <ImagePreview
        open
        slides={slides}
        index={start}
        closeLabel={t("imageStudio.lightbox.close")}
        onClose={onClose}
      />
    </Suspense>
  );
}
