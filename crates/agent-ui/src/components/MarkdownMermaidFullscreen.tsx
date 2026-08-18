import { Loader2, Maximize2, Minus, Plus, RefreshCw } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { mermaid } from "@streamdown/mermaid";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  formatMermaidViewBox,
  type MermaidViewBox,
  panMermaidViewBox,
  parseMermaidViewBox,
  zoomMermaidViewBox,
} from "../lib/mermaidViewBox";
import { cn } from "../lib/shared/utils";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

type MermaidViewportState = {
  zoom: number;
  viewBox: MermaidViewBox;
};

type MermaidFullscreenButtonProps = {
  chart: string;
  className?: string;
};

function MermaidControlButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const { children, disabled = false, label, onClick } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-foreground/75 transition-colors hover:bg-foreground/[0.08] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function MermaidFullscreenDialog({ chart, onClose }: { chart: string; onClose: () => void }) {
  const { t } = useLocale();
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const svgHostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const originalViewBoxRef = useRef<MermaidViewBox | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [viewportState, setViewportState] = useState<MermaidViewportState | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let active = true;
    svgHostRef.current?.replaceChildren();
    setSvg("");
    setError("");
    setViewportState(null);
    originalViewBoxRef.current = null;
    void mermaid
      .getMermaid()
      .render(`mermaid-fullscreen-${renderId}-${Date.now()}`, chart)
      .then(({ svg: renderedSvg }) => {
        if (active) setSvg(renderedSvg);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Failed to render Mermaid chart");
      });
    return () => {
      active = false;
    };
  }, [chart, renderId]);

  useLayoutEffect(() => {
    if (!svg) return;
    const host = svgHostRef.current;
    if (!host) return;
    const parsedDocument = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (
      parsedDocument.querySelector("parsererror") ||
      parsedDocument.documentElement.localName !== "svg"
    ) {
      setError("Mermaid returned invalid SVG");
      return;
    }
    const element = document.importNode(parsedDocument.documentElement, true);
    host.replaceChildren(element);
    const originalViewBox = parseMermaidViewBox(element?.getAttribute("viewBox") ?? null);
    if (!originalViewBox) {
      setError("Mermaid chart is missing a valid viewBox");
      return;
    }
    element.setAttribute("preserveAspectRatio", "xMidYMid meet");
    originalViewBoxRef.current = originalViewBox;
    setViewportState({ zoom: 1, viewBox: originalViewBox });
  }, [svg]);

  useLayoutEffect(() => {
    if (!viewportState) return;
    svgHostRef.current
      ?.querySelector("svg")
      ?.setAttribute("viewBox", formatMermaidViewBox(viewportState.viewBox));
  }, [viewportState]);

  const changeZoom = useCallback((delta: number) => {
    setViewportState((current) => {
      if (!current) return current;
      const zoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, Number((current.zoom + delta).toFixed(1))),
      );
      if (zoom === current.zoom) return current;
      return {
        zoom,
        viewBox: zoomMermaidViewBox(current.viewBox, zoom / current.zoom),
      };
    });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      changeZoom(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP);
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [changeZoom]);

  const resetView = useCallback(() => {
    const originalViewBox = originalViewBoxRef.current;
    if (originalViewBox) setViewportState({ zoom: 1, viewBox: originalViewBox });
  }, []);

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <Dialog open disablePointerDismissal onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="fixed inset-0 m-0 flex h-full w-screen max-w-none overflow-hidden rounded-none border-0 bg-background p-0 shadow-none transition-none"
        closeLabel={t("chat.imageViewer.exitFullscreen")}
        data-liveagent-mermaid-fullscreen="true"
        showCloseButton
        style={{ opacity: 1, scale: "none", transform: "none" }}
      >
        <DialogTitle className="sr-only">{t("chat.imageViewer.fullscreen")}</DialogTitle>
        <div
          ref={viewportRef}
          role="application"
          aria-label="Mermaid chart"
          className={cn(
            "relative min-h-0 flex-1 touch-none select-none overflow-hidden",
            dragging ? "cursor-grabbing" : "cursor-grab",
          )}
          onPointerDown={(event) => {
            if (
              event.button !== 0 ||
              !viewportState ||
              (event.target instanceof Element && event.target.closest("button"))
            ) {
              return;
            }
            dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const delta = { x: event.clientX - drag.x, y: event.clientY - drag.y };
            drag.x = event.clientX;
            drag.y = event.clientY;
            const svgRect = svgHostRef.current?.querySelector("svg")?.getBoundingClientRect();
            if (!svgRect) return;
            setViewportState((current) =>
              current
                ? {
                    ...current,
                    viewBox: panMermaidViewBox(current.viewBox, delta, {
                      width: svgRect.width,
                      height: svgRect.height,
                    }),
                  }
                : current,
            );
          }}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        >
          <div
            ref={svgHostRef}
            className="absolute inset-4 flex items-center justify-center [&_svg]:!h-full [&_svg]:!w-full [&_svg]:!max-w-none"
          />
          {!svg && !error ? (
            <Loader2 className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : null}
          {error ? (
            <div
              role="alert"
              className="absolute left-1/2 top-1/2 max-w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-md border border-destructive/30 bg-background px-4 py-3 text-sm text-destructive shadow-lg"
            >
              {error}
            </div>
          ) : null}
          <div className="absolute bottom-4 left-4 z-10 flex items-center rounded-md border border-border bg-background/95 p-1 shadow-md">
            <MermaidControlButton
              label={t("chat.imageViewer.zoomOut")}
              disabled={!viewportState || viewportState.zoom <= MIN_ZOOM}
              onClick={() => changeZoom(-ZOOM_STEP)}
            >
              <Minus className="h-4 w-4" />
            </MermaidControlButton>
            <span className="w-12 text-center text-[11px] tabular-nums text-muted-foreground">
              {Math.round((viewportState?.zoom ?? 1) * 100)}%
            </span>
            <MermaidControlButton
              label={t("chat.imageViewer.zoomIn")}
              disabled={!viewportState || viewportState.zoom >= MAX_ZOOM}
              onClick={() => changeZoom(ZOOM_STEP)}
            >
              <Plus className="h-4 w-4" />
            </MermaidControlButton>
            <MermaidControlButton label={t("chat.imageViewer.reset")} onClick={resetView}>
              <RefreshCw className="h-4 w-4" />
            </MermaidControlButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function MermaidFullscreenButton({ chart, className }: MermaidFullscreenButtonProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        aria-label={t("chat.imageViewer.fullscreen")}
        title={t("chat.imageViewer.fullscreen")}
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          className,
        )}
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
      {open ? <MermaidFullscreenDialog chart={chart} onClose={close} /> : null}
    </>
  );
}
