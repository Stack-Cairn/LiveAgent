import { Loader2, Minus, Plus, RefreshCw } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { mermaid } from "@streamdown/mermaid";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  formatMermaidViewBox,
  type MermaidViewBox,
  panMermaidViewBox,
  parseMermaidViewBox,
  zoomMermaidViewBox,
} from "../../lib/mermaidViewBox";
import { cn } from "../../lib/shared/utils";
import { useMermaidConfig } from "./MermaidTheme";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

// Streaming hands the diagram a longer chart every flush; a full mermaid
// parse + layout per delta stalls the main thread. First sight renders
// immediately, later chart changes render at most once per interval with a
// trailing render for the final chart. The previous SVG stays visible while
// a render is pending, so the diagram never flashes back to the spinner.
const STREAM_RENDER_MIN_INTERVAL_MS = 500;

type ViewportState = { zoom: number; viewBox: MermaidViewBox };

export function MermaidDiagram({
  chart,
  fullscreen = false,
  interactive = true,
}: {
  chart: string;
  fullscreen?: boolean;
  interactive?: boolean;
}) {
  const { t } = useLocale();
  const config = useMermaidConfig();
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const generation = useRef(0);
  const lastRenderStartRef = useRef(0);
  const lastRenderChartRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgHostRef = useRef<HTMLDivElement>(null);
  const originalViewBoxRef = useRef<MermaidViewBox | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [visible, setVisible] = useState(fullscreen);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [viewport, setViewport] = useState<ViewportState | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (visible) return;
    const element = viewportRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const render = () => {
      timer = null;
      lastRenderStartRef.current = performance.now();
      lastRenderChartRef.current = chart;
      setError("");
      generation.current += 1;
      void mermaid
        .getMermaid(config)
        .render(
          `mermaid-${fullscreen ? "fullscreen" : "inline"}-${renderId}-${generation.current}`,
          chart,
        )
        .then(({ svg: renderedSvg }) => {
          if (active) setSvg(renderedSvg);
        })
        .catch((reason: unknown) => {
          if (active) {
            setError(reason instanceof Error ? reason.message : "Failed to render Mermaid chart");
          }
        });
    };
    // Only a grown/changed chart is throttled; theme/config changes and the
    // first sight of a chart render immediately.
    const wait =
      lastRenderStartRef.current === 0 || lastRenderChartRef.current === chart
        ? 0
        : Math.max(
            0,
            STREAM_RENDER_MIN_INTERVAL_MS - (performance.now() - lastRenderStartRef.current),
          );
    if (wait === 0) {
      render();
    } else {
      timer = setTimeout(render, wait);
    }
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [chart, config, fullscreen, renderId, visible]);

  useLayoutEffect(() => {
    if (!svg || !svgHostRef.current) return;
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    const original = parseMermaidViewBox(parsed.documentElement.getAttribute("viewBox"));
    if (
      parsed.querySelector("parsererror") ||
      parsed.documentElement.localName !== "svg" ||
      !original
    ) {
      setError("Mermaid returned invalid SVG or viewBox");
      return;
    }
    const element = document.importNode(parsed.documentElement, true);
    element.setAttribute("preserveAspectRatio", "xMidYMid meet");
    // Keep the SVG viewport fixed. Only its viewBox changes, so text and paths
    // are repainted at the new scale instead of enlarging a composited layer.
    element.setAttribute("width", "100%");
    element.setAttribute("height", "100%");
    element.style.width = "100%";
    element.style.height = "100%";
    element.style.maxWidth = "none";
    svgHostRef.current.replaceChildren(element);
    originalViewBoxRef.current = original;
    setViewport({ zoom: 1, viewBox: original });
  }, [svg]);

  useLayoutEffect(() => {
    if (!viewport) return;
    svgHostRef.current
      ?.querySelector("svg")
      ?.setAttribute("viewBox", formatMermaidViewBox(viewport.viewBox));
  }, [viewport]);

  const changeZoom = useCallback((delta: number) => {
    setViewport((current) => {
      if (!current) return current;
      const zoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, Number((current.zoom + delta).toFixed(1))),
      );
      if (zoom === current.zoom) return current;
      return { zoom, viewBox: zoomMermaidViewBox(current.viewBox, zoom / current.zoom) };
    });
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !interactive) return;
    const onWheel = (event: WheelEvent) => {
      if (!originalViewBoxRef.current || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      changeZoom(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP);
    };
    // React's delegated wheel listener is passive; cancellation must happen here.
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [changeZoom, interactive]);

  const finishDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <div
      ref={viewportRef}
      role="img"
      aria-label="Mermaid chart"
      data-liveagent-mermaid-viewport=""
      className={cn(
        "relative min-w-0 overflow-hidden",
        fullscreen ? "min-h-0 flex-1" : "h-280px w-full",
        interactive && "touch-none select-none",
        interactive && (dragging ? "cursor-grabbing" : "cursor-grab"),
      )}
      onPointerDown={(event) => {
        if (
          !interactive ||
          event.button !== 0 ||
          event.isPrimary === false ||
          !viewport ||
          (event.target instanceof Element && event.target.closest("button"))
        )
          return;
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
        const rect = svgHostRef.current?.querySelector("svg")?.getBoundingClientRect();
        if (!rect) return;
        setViewport((current) =>
          current
            ? { ...current, viewBox: panMermaidViewBox(current.viewBox, delta, rect) }
            : current,
        );
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        finishDrag();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
    >
      <div
        ref={svgHostRef}
        data-streamdown={fullscreen ? undefined : "mermaid"}
        className={cn("absolute", fullscreen ? "inset-4" : "inset-0")}
      />
      {!svg && !error ? (
        <Loader2 className="absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />
      ) : null}
      {error && !svg ? (
        <div role="alert" className="absolute inset-4 overflow-auto text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {interactive ? (
        <div
          className={cn(
            "absolute bottom-2 left-2 z-10 flex items-center gap-1",
            fullscreen
              ? "rounded-md border border-border bg-background/95 p-1 shadow-md"
              : "flex-col",
          )}
        >
          <button
            type="button"
            aria-label={t("chat.imageViewer.zoomIn")}
            title={t("chat.imageViewer.zoomIn")}
            disabled={!viewport || viewport.zoom >= MAX_ZOOM}
            className="flex size-8 items-center justify-center rounded-md text-foreground/75 transition-colors hover:bg-foreground/[0.08] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
            onClick={() => changeZoom(ZOOM_STEP)}
          >
            <Plus className="size-4" />
          </button>
          {fullscreen ? (
            <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
              {Math.round((viewport?.zoom ?? 1) * 100)}%
            </span>
          ) : null}
          <button
            type="button"
            aria-label={t("chat.imageViewer.zoomOut")}
            title={t("chat.imageViewer.zoomOut")}
            disabled={!viewport || viewport.zoom <= MIN_ZOOM}
            className="flex size-8 items-center justify-center rounded-md text-foreground/75 transition-colors hover:bg-foreground/[0.08] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
            onClick={() => changeZoom(-ZOOM_STEP)}
          >
            <Minus className="size-4" />
          </button>
          <button
            type="button"
            aria-label={t("chat.imageViewer.reset")}
            title={t("chat.imageViewer.reset")}
            disabled={!viewport}
            className="flex size-8 items-center justify-center rounded-md text-foreground/75 transition-colors hover:bg-foreground/[0.08] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
            onClick={() => {
              const original = originalViewBoxRef.current;
              if (original) setViewport({ zoom: 1, viewBox: original });
            }}
          >
            <RefreshCw className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
