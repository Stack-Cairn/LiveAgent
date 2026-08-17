import { useCallback, useRef } from "react";
import { cn } from "../../lib/shared/utils";
import {
  clampRatioToMinSize,
  type DividerGeometry,
  MIN_CONVERSATION_PANE_HEIGHT,
  MIN_CONVERSATION_PANE_WIDTH,
} from "../../lib/workbench/geometry";

export type DividerLayerProps = {
  dividers: readonly DividerGeometry[];
  dividerSize: number;
  separatorLabel: string;
  minPaneWidth?: number;
  minPaneHeight?: number;
  /** Live ratio preview while dragging; at most one call per frame. */
  onResizePreview: (splitId: string, ratio: number) => void;
  /** Final ratio on pointer-up / keyboard commit. */
  onResizeCommit: (splitId: string, ratio: number) => void;
  /** Double-click equalizes the split back to 50/50. */
  onEqualize?: (splitId: string) => void;
};

const KEYBOARD_RESIZE_STEP = 0.02;

function ratioFromPointer(divider: DividerGeometry, dividerSize: number, x: number, y: number) {
  const { splitArea, axis } = divider;
  const usable = (axis === "horizontal" ? splitArea.width : splitArea.height) - dividerSize;
  if (usable <= 0) return 0.5;
  const offset =
    axis === "horizontal"
      ? x - splitArea.left - dividerSize / 2
      : y - splitArea.top - dividerSize / 2;
  return offset / usable;
}

function currentRatio(divider: DividerGeometry, dividerSize: number): number {
  const usable =
    (divider.axis === "horizontal" ? divider.splitArea.width : divider.splitArea.height) -
    dividerSize;
  if (usable <= 0) return 0.5;
  return divider.axis === "horizontal"
    ? (divider.rect.left - divider.splitArea.left) / usable
    : (divider.rect.top - divider.splitArea.top) / usable;
}

/**
 * Pointer-captured split dividers. Rendered above the pane layer; each
 * divider maps pointer moves to a clamped ratio for its own split only.
 */
export function DividerLayer(props: DividerLayerProps) {
  const {
    dividers,
    dividerSize,
    separatorLabel,
    minPaneWidth = MIN_CONVERSATION_PANE_WIDTH,
    minPaneHeight = MIN_CONVERSATION_PANE_HEIGHT,
    onResizePreview,
    onResizeCommit,
    onEqualize,
  } = props;
  const dragRef = useRef<{
    pointerId: number;
    splitId: string;
    lastRatio: number;
    frame: number | null;
  } | null>(null);

  const clampFor = useCallback(
    (divider: DividerGeometry, ratio: number) =>
      clampRatioToMinSize({
        ratio,
        axis: divider.axis,
        splitArea: divider.splitArea,
        minSize: divider.axis === "horizontal" ? minPaneWidth : minPaneHeight,
        dividerSize,
      }),
    [dividerSize, minPaneHeight, minPaneWidth],
  );

  return (
    <>
      {dividers.map((divider) => {
        const ratioNow = clampFor(divider, currentRatio(divider, dividerSize));
        return (
          <div
            key={divider.splitId}
            data-workbench-divider={divider.splitId}
            role="separator"
            tabIndex={0}
            aria-label={separatorLabel}
            aria-orientation={divider.axis === "horizontal" ? "vertical" : "horizontal"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratioNow * 100)}
            className={cn(
              "absolute z-10 flex items-center justify-center bg-transparent",
              divider.axis === "horizontal" ? "cursor-col-resize" : "cursor-row-resize",
              "focus-visible:outline-none",
              "group/divider",
            )}
            style={{
              left: divider.rect.left,
              top: divider.rect.top,
              width: divider.rect.width,
              height: divider.rect.height,
            }}
            onDoubleClick={() => onEqualize?.(divider.splitId)}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = {
                pointerId: event.pointerId,
                splitId: divider.splitId,
                lastRatio: ratioNow,
                frame: null,
              };
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              const canvas = event.currentTarget.parentElement?.getBoundingClientRect();
              if (!canvas) return;
              const ratio = clampFor(
                divider,
                ratioFromPointer(
                  divider,
                  dividerSize,
                  event.clientX - canvas.left,
                  event.clientY - canvas.top,
                ),
              );
              drag.lastRatio = ratio;
              if (drag.frame !== null) return;
              drag.frame = requestAnimationFrame(() => {
                const active = dragRef.current;
                if (active?.splitId === divider.splitId) {
                  active.frame = null;
                  onResizePreview(divider.splitId, active.lastRatio);
                }
              });
            }}
            onPointerUp={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              if (drag.frame !== null) cancelAnimationFrame(drag.frame);
              dragRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              onResizeCommit(divider.splitId, drag.lastRatio);
            }}
            onPointerCancel={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              if (drag.frame !== null) cancelAnimationFrame(drag.frame);
              dragRef.current = null;
              onResizeCommit(divider.splitId, drag.lastRatio);
            }}
            onKeyDown={(event) => {
              const horizontal = divider.axis === "horizontal";
              const decreaseKey = horizontal ? "ArrowLeft" : "ArrowUp";
              const increaseKey = horizontal ? "ArrowRight" : "ArrowDown";
              if (event.key !== decreaseKey && event.key !== increaseKey) return;
              event.preventDefault();
              const delta =
                event.key === increaseKey ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
              onResizeCommit(divider.splitId, clampFor(divider, ratioNow + delta));
            }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "bg-border/80 transition-colors duration-100 motion-reduce:transition-none",
                "group-hover/divider:bg-primary/50 group-focus-visible/divider:bg-primary/60",
                // Forced-colors modes drop the themed backgrounds entirely, so
                // the divider needs a system colour to stay visible at all.
                "forced-colors:bg-[CanvasText]",
                "group-hover/divider:forced-colors:bg-[Highlight] group-focus-visible/divider:forced-colors:bg-[Highlight]",
                divider.axis === "horizontal"
                  ? "h-full w-px group-hover/divider:w-[3px] group-focus-visible/divider:w-[3px]"
                  : "h-px w-full group-hover/divider:h-[3px] group-focus-visible/divider:h-[3px]",
              )}
            />
          </div>
        );
      })}
    </>
  );
}
