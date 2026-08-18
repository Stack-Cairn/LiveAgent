import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TrajectoryTimelineModel, TrajectoryTimeRange } from "../../lib/trajectory/timeline";
import {
  normalizeTimelineViewport,
  zoomTimelineViewport,
} from "../../lib/trajectory/timelineViewport";

const MINIMUM_DRAG_PX = 3;
const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function useTimelineGestures(params: {
  trackRef: RefObject<HTMLButtonElement | null>;
  model: TrajectoryTimelineModel;
  range: TrajectoryTimeRange | null;
  minimumSpan: number;
  onRangeChange: (range: TrajectoryTimeRange | null) => void;
  onRecordSelect: (index: number) => void;
}) {
  const viewport = useMemo(
    () => normalizeTimelineViewport(params.model, params.range),
    [params.model, params.range],
  );
  const viewportSpan = Math.max(Number.EPSILON, viewport.end - viewport.start);
  const dragRef = useRef<{
    pointerId: number;
    originX: number;
    originFraction: number;
  } | null>(null);
  const draftRef = useRef<{ start: number; end: number } | null>(null);
  const [draft, setDraftState] = useState<{ start: number; end: number } | null>(null);
  const setDraft = (next: { start: number; end: number } | null) => {
    draftRef.current = next;
    setDraftState(next);
  };

  const fractionAt = (clientX: number) => {
    const rect = params.trackRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };
  const toDomain = (fraction: number) => viewport.start + fraction * viewportSpan;

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const fraction = fractionAt(event.clientX);
    dragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originFraction: fraction,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ start: fraction, end: fraction });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const fraction = fractionAt(event.clientX);
    setDraft({
      start: Math.min(drag.originFraction, fraction),
      end: Math.max(drag.originFraction, fraction),
    });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const moved = Math.abs(event.clientX - drag.originX) >= MINIMUM_DRAG_PX;
    const current = draftRef.current;
    setDraft(null);
    if (!moved) {
      const point = toDomain(drag.originFraction);
      const candidates = params.model.spans.filter(
        (span) => span.start <= viewport.end && span.end >= viewport.start,
      );
      const nearest = candidates.reduce<(typeof candidates)[number] | null>((best, span) => {
        if (best === null) return span;
        const distance = point < span.start ? span.start - point : Math.max(0, point - span.end);
        const bestDistance =
          point < best.start ? best.start - point : Math.max(0, point - best.end);
        return distance < bestDistance ? span : best;
      }, null);
      if (nearest !== null) params.onRecordSelect(nearest.index);
      return;
    }
    if (current === null || current.end - current.start <= Number.EPSILON) return;
    params.onRangeChange({ start: toDomain(current.start), end: toDomain(current.end) });
  };

  const onWheel = (event: ReactWheelEvent<HTMLButtonElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    params.onRangeChange(
      zoomTimelineViewport({
        model: params.model,
        viewport,
        anchorFraction: fractionAt(event.clientX),
        wheelDeltaY: event.deltaY,
        minimumSpan: params.minimumSpan,
      }),
    );
  };

  const cancel = () => {
    dragRef.current = null;
    setDraft(null);
  };

  return {
    viewport,
    viewportSpan,
    draft,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheel,
    cancel,
  };
}

/**
 * Minimap 手势：点击把视口平移到点击处，按住拖动连续平移，双击重置回全图。
 * 视口已覆盖全图时平移无意义，全部变成 no-op。
 */
export function useMinimapGestures(params: {
  minimapRef: RefObject<HTMLButtonElement | null>;
  model: TrajectoryTimelineModel;
  viewport: TrajectoryTimeRange;
  onRangeChange: (range: TrajectoryTimeRange | null) => void;
}) {
  const panRef = useRef<{ pointerId: number } | null>(null);

  const fractionAt = (clientX: number) => {
    const rect = params.minimapRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };

  const domainAt = (fraction: number) => {
    const span = params.model.end - params.model.start;
    return params.model.start + fraction * span;
  };

  const panTo = (center: number) => {
    const span = params.viewport.end - params.viewport.start;
    const fullSpan = params.model.end - params.model.start;
    if (!(span > 0) || span >= fullSpan) return;
    let start = center - span / 2;
    if (start < params.model.start) start = params.model.start;
    if (start + span > params.model.end) start = params.model.end - span;
    params.onRangeChange({ start, end: start + span });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    panRef.current = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    // 点击即跳转：拖动只是在跳转后的视口上继续平移。
    panTo(domainAt(fractionAt(event.clientX)));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (panRef.current === null || panRef.current.pointerId !== event.pointerId) return;
    // minimap 的域是全模型，指针的域位置就是想要的视口中心。
    panTo(domainAt(fractionAt(event.clientX)));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
  };

  const cancel = () => {
    panRef.current = null;
  };

  return { onPointerDown, onPointerMove, onPointerUp, cancel };
}
