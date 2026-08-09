import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { cn } from "../../../lib/shared/utils";
import {
  areWidthControlsUsable,
  clampWidthToStage,
  DEFAULT_CHAT_TRANSCRIPT_WIDTH,
  MIN_CHAT_TRANSCRIPT_WIDTH,
  normalizePreferredWidth,
  resolveDragWidth,
  resolveKeyboardWidth,
  resolveStageMaxWidth,
  TRANSCRIPT_HORIZONTAL_SAFE_SPACE,
  TRANSCRIPT_WIDTH_CONTROLS_HIDDEN_MEDIA_QUERY,
  type TranscriptResizeSide,
} from "../../../lib/transcript-width/transcriptWidthModel";

export const CHAT_TRANSCRIPT_WIDTH_CSS_VAR = "--chat-transcript-content-width";

// Who writes CHAT_TRANSCRIPT_WIDTH_CSS_VAR: the host element's own inline
// style carries the *preferred* (persisted) width, so a fresh mount already
// paints at the user's width. This component then narrows that to what the
// stage can host — from a layout effect, before paint. A passive effect lands
// after paint and would flash the unclamped width for a frame whenever a
// commit has to be clamped.

type TranscriptWidthControlsProps = {
  hostRef: RefObject<HTMLElement | null>;
  width: number;
  onWidthChange: (width: number) => void;
  resizeLabel: string;
  resetLabel: string;
};

function subscribeControlsHidden(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(TRANSCRIPT_WIDTH_CONTROLS_HIDDEN_MEDIA_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readControlsHidden() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(TRANSCRIPT_WIDTH_CONTROLS_HIDDEN_MEDIA_QUERY).matches;
}

function measureStageMaxWidth(host: HTMLElement | null) {
  return resolveStageMaxWidth(host?.getBoundingClientRect().width ?? null);
}

function applyWidth(host: HTMLElement | null, width: number) {
  host?.style.setProperty(CHAT_TRANSCRIPT_WIDTH_CSS_VAR, `${Math.round(width)}px`);
}

export function TranscriptWidthControls(props: TranscriptWidthControlsProps) {
  const { hostRef, width, onWidthChange, resizeLabel, resetLabel } = props;
  const [maxWidth, setMaxWidth] = useState(() => resolveStageMaxWidth(null));
  const [resizingWidth, setResizingWidth] = useState<number | null>(null);
  const pendingWidthRef = useRef(width);
  const resizingRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // Read by the stage observer, which must outlive individual width commits.
  const widthRef = useRef(width);
  widthRef.current = width;
  const effectiveWidth = clampWidthToStage(resizingWidth ?? width, maxWidth);
  // Same gate as the CSS that hides the handles, so a coarse pointer neither
  // renders them nor pays for their listeners.
  const controlsHidden = useSyncExternalStore(
    subscribeControlsHidden,
    readControlsHidden,
    () => true,
  );

  useLayoutEffect(() => {
    // Mid-drag the pointer owns the variable; that drag's commit reconciles it.
    if (resizingWidth !== null) return;
    applyWidth(hostRef.current, clampWidthToStage(width, maxWidth));
  }, [hostRef, maxWidth, resizingWidth, width]);

  // Keyed off the host alone on purpose: re-arming the observer on every width
  // commit would tear it down and rebuild it mid-interaction for nothing.
  useEffect(() => {
    const host = hostRef.current;
    let frameId = 0;
    const updateMaxWidth = () => {
      frameId = 0;
      const nextMaxWidth = measureStageMaxWidth(host);
      setMaxWidth(nextMaxWidth);
      if (!resizingRef.current) {
        applyWidth(host, clampWidthToStage(widthRef.current, nextMaxWidth));
      }
    };
    const scheduleUpdate = () => {
      if (frameId !== 0) return;
      frameId = requestAnimationFrame(updateMaxWidth);
    };
    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    if (host) observer?.observe(host);
    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      if (frameId !== 0) cancelAnimationFrame(frameId);
      observer?.disconnect();
    };
  }, [hostRef]);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current);
    },
    [],
  );

  const commitWidth = useCallback(
    (nextWidth: number) => {
      const preferredWidth = normalizePreferredWidth(nextWidth);
      const effectiveNextWidth = clampWidthToStage(
        preferredWidth,
        measureStageMaxWidth(hostRef.current),
      );
      applyWidth(hostRef.current, effectiveNextWidth);
      pendingWidthRef.current = effectiveNextWidth;
      setResizingWidth(null);
      if (preferredWidth !== width) onWidthChange(preferredWidth);
    },
    [hostRef, onWidthChange, width],
  );

  const handleResizeStart = useCallback(
    (side: TranscriptResizeSide, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      event.preventDefault();
      event.stopPropagation();
      cleanupRef.current?.();

      const host = hostRef.current;
      const dragMaxWidth = measureStageMaxWidth(host);
      const startX = event.clientX;
      const startWidth = clampWidthToStage(width, dragMaxWidth);
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      pendingWidthRef.current = startWidth;
      resizingRef.current = true;
      setMaxWidth(dragMaxWidth);
      setResizingWidth(startWidth);
      applyWidth(host, startWidth);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const scheduleWidth = (nextWidth: number) => {
        pendingWidthRef.current = clampWidthToStage(nextWidth, dragMaxWidth);
        if (resizeFrameRef.current !== null) return;
        resizeFrameRef.current = requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          const pendingWidth = pendingWidthRef.current;
          applyWidth(hostRef.current, pendingWidth);
          setResizingWidth(pendingWidth);
        });
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleEnd);
        window.removeEventListener("pointercancel", handleEnd);
        window.removeEventListener("blur", handleEnd);
        if (resizeFrameRef.current !== null) {
          cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        resizingRef.current = false;
        cleanupRef.current = null;
      };

      const handleMove = (moveEvent: PointerEvent) => {
        scheduleWidth(resolveDragWidth(startWidth, moveEvent.clientX - startX, side));
      };

      const handleEnd = () => {
        cleanup();
        commitWidth(pendingWidthRef.current);
      };

      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleEnd);
      window.addEventListener("pointercancel", handleEnd);
      window.addEventListener("blur", handleEnd);
    },
    [commitWidth, hostRef, width],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const nextWidth = resolveKeyboardWidth(event.key, effectiveWidth, event.shiftKey);
      if (nextWidth === null) return;
      event.preventDefault();
      commitWidth(nextWidth);
    },
    [commitWidth, effectiveWidth],
  );

  const resetWidth = useCallback(() => {
    commitWidth(DEFAULT_CHAT_TRANSCRIPT_WIDTH);
  }, [commitWidth]);

  if (controlsHidden || !areWidthControlsUsable(maxWidth)) return null;

  const handleTitle = `${resizeLabel} · ${resetLabel}`;

  // Only the right handle is exposed to assistive tech. Both handles drive one
  // value, and aria-value* is only meaningful on a focusable separator — so
  // the left handle stays a pointer-only affordance instead of advertising
  // values nothing can focus to change.
  const renderHandle = (side: TranscriptResizeSide) => {
    const isPrimary = side === "right";
    return (
      <button
        type="button"
        {...(isPrimary
          ? {
              role: "separator",
              "aria-label": resizeLabel,
              "aria-orientation": "vertical" as const,
              "aria-valuemin": MIN_CHAT_TRANSCRIPT_WIDTH,
              "aria-valuemax": maxWidth,
              "aria-valuenow": effectiveWidth,
              tabIndex: 0,
              onKeyDown: handleKeyDown,
            }
          : { "aria-hidden": true, tabIndex: -1 })}
        data-scroll-follow-ignore-keys
        title={handleTitle}
        onPointerDown={(event) => handleResizeStart(side, event)}
        onDoubleClick={resetWidth}
        className={cn(
          "group pointer-events-auto absolute inset-y-0 z-10 w-3 touch-none cursor-col-resize border-0 bg-transparent p-0 focus-visible:outline-none",
          isPrimary ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-1/2 top-1/2 h-10 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/25 opacity-0 shadow-sm transition-[height,background-color,opacity] duration-150",
            "group-hover:h-16 group-hover:bg-primary/60 group-hover:opacity-100 group-focus-visible:h-16 group-focus-visible:bg-primary group-focus-visible:opacity-100",
            resizingWidth !== null && "h-20 bg-primary opacity-100",
          )}
        />
      </button>
    );
  };

  return (
    <div
      className="transcript-width-controls pointer-events-none absolute inset-y-0 left-1/2 z-[9] -translate-x-1/2"
      style={{
        width: `var(${CHAT_TRANSCRIPT_WIDTH_CSS_VAR}, ${DEFAULT_CHAT_TRANSCRIPT_WIDTH}px)`,
        maxWidth: `calc(100% - ${TRANSCRIPT_HORIZONTAL_SAFE_SPACE}px)`,
      }}
    >
      {renderHandle("left")}
      {renderHandle("right")}
      {resizingWidth !== null ? (
        <div className="absolute left-1/2 top-2 -translate-x-1/2 rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] font-medium tabular-nums text-muted-foreground shadow-sm">
          {effectiveWidth} px
        </div>
      ) : null}
    </div>
  );
}
