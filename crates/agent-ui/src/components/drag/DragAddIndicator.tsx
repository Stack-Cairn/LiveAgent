import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { cn } from "../../lib/shared/utils";
import { Plus } from "../IconSet";

export type DragAddIndicatorProps = Omit<ComponentPropsWithoutRef<"div">, "children">;

/** Shared pointer-following affordance for drag operations that add to a target. */
export const DragAddIndicator = forwardRef<HTMLDivElement, DragAddIndicatorProps>(
  function DragAddIndicator(props, ref) {
    const { className, ...rest } = props;
    return (
      <div
        {...rest}
        ref={ref}
        data-drag-add-indicator=""
        aria-hidden="true"
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-full border-2 border-background bg-emerald-500 text-white shadow-[0_3px_10px_rgba(0,0,0,0.28)] ring-1 ring-emerald-700/20 dark:bg-emerald-400 dark:text-emerald-950 dark:ring-emerald-200/30",
          className,
        )}
      >
        <Plus className="h-4 w-4" strokeWidth={2.75} />
      </div>
    );
  },
);
