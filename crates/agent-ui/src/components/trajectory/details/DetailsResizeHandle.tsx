import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../../i18n/index";
import { cn } from "../../../lib/shared/utils";
import {
  clampTrajectoryDetailsWidth,
  DEFAULT_TRAJECTORY_DETAILS_WIDTH,
  resolveTrajectoryDetailsDragWidth,
  resolveTrajectoryDetailsKeyboardWidth,
  trajectoryDetailsWidthBounds,
} from "../../../lib/trajectory/detailsResize";

type DragState = {
  pointerId: number;
  startWidth: number;
  startX: number;
  containerWidth: number;
};

export function DetailsResizeHandle(props: {
  containerRef: RefObject<HTMLDivElement | null>;
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const { t } = useLocale();
  const [dragging, setDragging] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const dragRef = useRef<DragState | null>(null);
  const previousBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const widthRef = useRef(props.width);
  widthRef.current = props.width;
  const onWidthChangeRef = useRef(props.onWidthChange);
  onWidthChangeRef.current = props.onWidthChange;

  const measureContainerWidth = useCallback(
    () => props.containerRef.current?.getBoundingClientRect().width ?? 0,
    [props.containerRef],
  );

  const commitWidth = useCallback(
    (width: number, containerWidth = measureContainerWidth()) => {
      props.onWidthChange(clampTrajectoryDetailsWidth(width, containerWidth));
    },
    [measureContainerWidth, props.onWidthChange],
  );

  const finishDrag = useCallback((pointerId?: number) => {
    const drag = dragRef.current;
    if (drag === null || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
    dragRef.current = null;
    const previousBodyStyle = previousBodyStyleRef.current;
    if (previousBodyStyle !== null) {
      document.body.style.cursor = previousBodyStyle.cursor;
      document.body.style.userSelect = previousBodyStyle.userSelect;
      previousBodyStyleRef.current = null;
    }
    setDragging(false);
  }, []);

  useEffect(
    () => () => {
      dragRef.current = null;
      const previousBodyStyle = previousBodyStyleRef.current;
      if (previousBodyStyle !== null) {
        document.body.style.cursor = previousBodyStyle.cursor;
        document.body.style.userSelect = previousBodyStyle.userSelect;
        previousBodyStyleRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const container = props.containerRef.current;
    if (container === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const nextContainerWidth =
        entry?.contentRect.width ?? container.getBoundingClientRect().width;
      setContainerWidth(nextContainerWidth);
      if (nextContainerWidth <= 0) return;
      const nextWidth = clampTrajectoryDetailsWidth(widthRef.current, nextContainerWidth);
      if (nextWidth !== widthRef.current) onWidthChangeRef.current(nextWidth);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [props.containerRef]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      if (dragRef.current !== null) return;
      const containerWidth = measureContainerWidth();
      if (containerWidth <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startWidth: clampTrajectoryDetailsWidth(props.width, containerWidth),
        startX: event.clientX,
        containerWidth,
      };
      previousBodyStyleRef.current = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      setDragging(true);
    },
    [measureContainerWidth, props.width],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      props.onWidthChange(
        resolveTrajectoryDetailsDragWidth(
          drag.startWidth,
          event.clientX - drag.startX,
          drag.containerWidth,
        ),
      );
    },
    [props.onWidthChange],
  );

  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      finishDrag(event.pointerId);
    },
    [finishDrag],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const nextWidth = resolveTrajectoryDetailsKeyboardWidth(
        event.key,
        props.width,
        measureContainerWidth(),
        event.shiftKey,
      );
      if (nextWidth === null) return;
      event.preventDefault();
      props.onWidthChange(nextWidth);
    },
    [measureContainerWidth, props.onWidthChange, props.width],
  );

  const bounds = trajectoryDetailsWidthBounds(containerWidth);
  const label = t("trajectory.details.resize");

  return (
    // biome-ignore lint/a11y/useSemanticElements: A focusable separator needs button pointer and keyboard behavior.
    <button
      type="button"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={clampTrajectoryDetailsWidth(props.width, containerWidth)}
      title={`${label} · ${t("trajectory.details.resizeReset")}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={() => finishDrag()}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => commitWidth(DEFAULT_TRAJECTORY_DETAILS_WIDTH)}
      // 水平拖拽只在左右分栏下有意义；窄容器上下排布时隐藏。
      className="group absolute inset-y-0 left-0 z-30 flex w-3 touch-none cursor-col-resize items-center justify-start border-0 bg-transparent p-0 focus-visible:outline-none @max-[640px]:hidden"
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-12 w-0.5 -translate-x-px rounded-full bg-muted-foreground/30 opacity-0 shadow-sm transition-[height,background-color,opacity] duration-150",
          "group-hover:h-20 group-hover:bg-primary/60 group-hover:opacity-100 group-focus-visible:h-20 group-focus-visible:bg-primary group-focus-visible:opacity-100",
          dragging && "h-24 bg-primary opacity-100",
        )}
      />
    </button>
  );
}
