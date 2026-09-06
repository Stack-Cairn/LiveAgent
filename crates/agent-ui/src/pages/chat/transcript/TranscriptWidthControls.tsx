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
  clampWidthToStage,
  DEFAULT_CHAT_TRANSCRIPT_WIDTH,
  MIN_CHAT_TRANSCRIPT_WIDTH,
  normalizePreferredWidth,
  resolveDragWidth,
  resolveKeyboardWidth,
  resolveStageMaxWidth,
  resolveTranscriptWidthControlsState,
  TRANSCRIPT_HORIZONTAL_SAFE_SPACE,
  TRANSCRIPT_WIDTH_CONTROLS_HIDDEN_MEDIA_QUERY,
  type TranscriptResizeSide,
} from "../../../lib/transcript-width/transcriptWidthModel";

export const CHAT_TRANSCRIPT_WIDTH_CSS_VAR = "--chat-transcript-content-width";

// Who writes CHAT_TRANSCRIPT_WIDTH_CSS_VAR: the nearest shared width owner
// carries the *preferred* (persisted) width, so transcript and composer paint
// at one width on the first frame. This component then narrows that owner to
// what the stage can host — from a layout effect, before paint. A passive
// effect would flash the unclamped width for a frame whenever a commit has to
// be clamped.

type TranscriptWidthControlsProps = {
  hostRef: RefObject<HTMLElement | null>;
  width: number;
  onWidthChange: (width: number) => void;
  resizeLabel: string;
  resetLabel: string;
  /**
   * True while a loading overlay covers the stage (history switch, first
   * layout settle). The handles unmount — an opaque overlay leaves nothing to
   * grab, and a focusable separator must not hide beneath a blocking layer —
   * while the stage observer keeps the width variable clamped. They return in
   * the same commit the overlay leaves, re-measured against the stage as it is
   * then, so no unrelated layout change is needed to wake them.
   */
  suspended?: boolean;
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

function resolveWidthOwner(host: HTMLElement | null): HTMLElement | null {
  return host?.closest<HTMLElement>("[data-chat-width-owner]") ?? host;
}

function applyWidth(host: HTMLElement | null, width: number) {
  resolveWidthOwner(host)?.style.setProperty(
    CHAT_TRANSCRIPT_WIDTH_CSS_VAR,
    `${Math.round(width)}px`,
  );
}

export function TranscriptWidthControls(props: TranscriptWidthControlsProps) {
  const { hostRef, width, onWidthChange, resizeLabel, resetLabel, suspended = false } = props;
  const [maxWidth, setMaxWidth] = useState(() => resolveStageMaxWidth(null));
  const [resizingWidth, setResizingWidth] = useState<number | null>(null);
  const pendingWidthRef = useRef(width);
  const resizingRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // Ends the drag in flight — listeners off, pending width committed. Null
  // while no drag is running.
  const endResizeRef = useRef<(() => void) | null>(null);
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
  const controlsState = resolveTranscriptWidthControlsState({
    suspended,
    mediaHidden: controlsHidden,
    maxWidth,
  });
  const handlesVisible = controlsState === "ready";

  useLayoutEffect(() => {
    // Mid-drag the pointer owns the variable; that drag's commit reconciles it.
    if (resizingWidth !== null) return;
    applyWidth(hostRef.current, clampWidthToStage(width, maxWidth));
  }, [hostRef, maxWidth, resizingWidth, width]);

  // One measurement shared by mount, reveal, window resize and the stage
  // observer: reads the stage as it is right now, stores the ceiling and
  // re-clamps the variable unless a drag currently owns it.
  const measureStage = useCallback(() => {
    const host = hostRef.current;
    const nextMaxWidth = measureStageMaxWidth(host);
    setMaxWidth(nextMaxWidth);
    if (!resizingRef.current) {
      applyWidth(host, clampWidthToStage(widthRef.current, nextMaxWidth));
    }
  }, [hostRef]);

  // Mount and every reveal measure synchronously, before paint. A pane that
  // changed size behind a loading overlay would otherwise keep the ceiling
  // measured before the overlay, and a stale narrow ceiling keeps the handles
  // hidden until some unrelated layout change wakes the observer (#749). On a
  // first mount whose host ref is not attached yet the measurement falls back
  // to the unmeasured ceiling and the observer below corrects it on its first
  // delivery.
  useLayoutEffect(() => {
    if (suspended) return;
    measureStage();
  }, [measureStage, suspended]);

  // Keyed off the host alone on purpose: re-arming the observer on every width
  // commit would tear it down and rebuild it mid-interaction for nothing.
  useEffect(() => {
    const host = hostRef.current;
    let frameId = 0;
    const measureOnFrame = () => {
      frameId = 0;
      measureStage();
    };
    const scheduleUpdate = () => {
      if (frameId !== 0) return;
      frameId = requestAnimationFrame(measureOnFrame);
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
  }, [hostRef, measureStage]);

  // An overlay landing mid-drag ends the drag where the pointer is: the window
  // listeners would otherwise keep resizing a stage the user can no longer
  // see, holding a handle that is about to unmount.
  useEffect(() => {
    if (suspended) endResizeRef.current?.();
  }, [suspended]);

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
        endResizeRef.current = null;
      };

      const handleMove = (moveEvent: PointerEvent) => {
        scheduleWidth(resolveDragWidth(startWidth, moveEvent.clientX - startX, side));
      };

      const handleEnd = () => {
        cleanup();
        commitWidth(pendingWidthRef.current);
      };

      cleanupRef.current = cleanup;
      endResizeRef.current = handleEnd;
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

  const handleTitle = `${resizeLabel} · ${resetLabel}`;

  // Only the right handle is exposed to assistive tech. Both handles drive one
  // value, and aria-value* is only meaningful on a focusable separator — so
  // the left handle stays a pointer-only affordance instead of advertising
  // values nothing can focus to change.
  //
  // The transparent hit target spans the pane's full height at 17px wide —
  // the original 96px-tall, 12px-wide grips were hard to acquire (#749
  // follow-up). Only the hit area grew; the visible pill stays small.
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
          "group pointer-events-auto absolute inset-y-0 z-10 flex w-[17px] touch-none cursor-col-resize items-center justify-center border-0 bg-transparent p-0 focus-visible:outline-none",
          isPrimary ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "h-10 w-0.5 rounded-full bg-muted-foreground/25 opacity-0 shadow-sm transition-[height,background-color,opacity] duration-150",
            "group-hover:h-16 group-hover:bg-primary/60 group-hover:opacity-100 group-focus-visible:h-16 group-focus-visible:bg-primary group-focus-visible:opacity-100",
            resizingWidth !== null && "h-20 bg-primary opacity-100",
          )}
        />
      </button>
    );
  };

  return (
    <div
      className="transcript-width-controls pointer-events-none absolute inset-y-0 left-1/2 z-10 -translate-x-1/2"
      // The root stays mounted in every state and names the gate that hides
      // the handles, so a runtime look at a pane that lost them tells the
      // gates apart instead of finding nothing to inspect (#749). `hidden`
      // keeps the empty root out of layout, hit testing and the a11y tree.
      data-transcript-width-state={controlsState}
      data-transcript-width-max={maxWidth}
      hidden={!handlesVisible}
      style={{
        width: `var(${CHAT_TRANSCRIPT_WIDTH_CSS_VAR}, ${DEFAULT_CHAT_TRANSCRIPT_WIDTH}px)`,
        maxWidth: `calc(100% - ${TRANSCRIPT_HORIZONTAL_SAFE_SPACE}px)`,
      }}
    >
      {handlesVisible ? renderHandle("left") : null}
      {handlesVisible ? renderHandle("right") : null}
      {handlesVisible && resizingWidth !== null ? (
        <div className="absolute left-1/2 top-2 -translate-x-1/2 rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] font-medium tabular-nums text-muted-foreground shadow-sm">
          {effectiveWidth} px
        </div>
      ) : null}
    </div>
  );
}
