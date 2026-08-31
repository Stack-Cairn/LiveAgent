import { forwardRef } from "react";
import type { WorkbenchDragPayload } from "../../lib/workbench/dragMachine";
import { DragAddIndicator } from "../drag/DragAddIndicator";

export type WorkbenchDragGhostProps = {
  payload: WorkbenchDragPayload;
  fallbackTitle: string;
};

/**
 * Pointer-following feedback for Workbench drags.
 *
 * New surfaces use the same compact green copy affordance as Desktop's native
 * workspace-path drag. Moving an existing pane keeps its title because that
 * operation rearranges content instead of adding another surface.
 */
export const WorkbenchDragGhost = forwardRef<HTMLDivElement, WorkbenchDragGhostProps>(
  function WorkbenchDragGhost(props, ref) {
    const { payload, fallbackTitle } = props;
    const isAddOperation = payload.kind !== "pane";
    const title = payload.title || fallbackTitle;
    const positionStyle = {
      left: 0,
      top: 0,
      transform:
        "translate3d(var(--workbench-drag-ghost-x, -9999px), var(--workbench-drag-ghost-y, -9999px), 0)",
      willChange: "transform",
    } as const;

    if (isAddOperation) {
      return (
        <DragAddIndicator
          ref={ref}
          data-workbench-drag-ghost=""
          data-workbench-drag-operation="add"
          className="layer-popover pointer-events-none fixed"
          style={positionStyle}
        />
      );
    }

    return (
      <div
        ref={ref}
        data-workbench-drag-ghost=""
        data-workbench-drag-operation="move"
        aria-hidden="true"
        className="layer-popover pointer-events-none fixed max-w-[220px] truncate rounded-md border border-border bg-background/95 px-2.5 py-1 text-xs text-foreground shadow-md"
        style={positionStyle}
      >
        {title}
      </div>
    );
  },
);
