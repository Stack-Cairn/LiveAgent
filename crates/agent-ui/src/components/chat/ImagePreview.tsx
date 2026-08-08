import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";

export type ImagePreviewSlide = {
  src: string;
  alt?: string;
  title?: string;
  width?: number;
  height?: number;
};

type ImagePreviewProps = {
  open: boolean;
  slides: ImagePreviewSlide[];
  index?: number;
  closeLabel?: string;
  onClose: () => void;
};

const imagePreviewPlugins = [Zoom];

function normalizeImagePreviewIndex(index: number | undefined) {
  return Number.isFinite(index) ? Math.trunc(index as number) : 0;
}

function clampImagePreviewIndex(index: number, slideCount: number) {
  if (slideCount <= 0) return 0;
  return Math.min(Math.max(index, 0), slideCount - 1);
}

export const ImagePreview = memo(function ImagePreview(props: ImagePreviewProps) {
  const { open, slides, index = 0, closeLabel = "关闭预览", onClose } = props;
  const requestedIndex = normalizeImagePreviewIndex(index);
  const clampedRequestedIndex = clampImagePreviewIndex(requestedIndex, slides.length);
  const [activeIndex, setActiveIndex] = useState(clampedRequestedIndex);
  const wasOpenRef = useRef(open);
  const requestedIndexRef = useRef(requestedIndex);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    const requestedIndexChanged = requestedIndexRef.current !== requestedIndex;
    requestedIndexRef.current = requestedIndex;

    if (!open) {
      wasOpenRef.current = false;
      setActiveIndex(clampedRequestedIndex);
      return;
    }

    if (!wasOpen || requestedIndexChanged) {
      setActiveIndex(clampedRequestedIndex);
    }
    wasOpenRef.current = true;
  }, [clampedRequestedIndex, open, requestedIndex]);

  useEffect(() => {
    setActiveIndex((currentIndex) => clampImagePreviewIndex(currentIndex, slides.length));
  }, [slides.length]);

  const handleView = useCallback(
    ({ index: nextIndex }: { index: number }) => {
      setActiveIndex(clampImagePreviewIndex(nextIndex, slides.length));
    },
    [slides.length],
  );

  const callbacks = useMemo(
    () => ({
      view: handleView,
    }),
    [handleView],
  );

  if (slides.length === 0) return null;

  const clampedIndex = clampImagePreviewIndex(activeIndex, slides.length);
  const singleSlideRender =
    slides.length > 1
      ? undefined
      : {
          buttonPrev: () => null,
          buttonNext: () => null,
        };

  return (
    <Lightbox
      open={open}
      close={onClose}
      index={clampedIndex}
      slides={slides}
      on={callbacks}
      plugins={imagePreviewPlugins}
      labels={{
        Close: closeLabel,
        Next: "下一张",
        Previous: "上一张",
      }}
      carousel={{
        finite: true,
        imageFit: "contain",
      }}
      controller={{
        aria: true,
        closeOnBackdropClick: true,
      }}
      render={singleSlideRender}
      zoom={{
        maxZoomPixelRatio: 3,
        scrollToZoom: true,
      }}
      styles={{
        container: {
          backgroundColor: "rgba(0, 0, 0, 0.75)",
          backdropFilter: "blur(8px)",
        },
      }}
    />
  );
});
