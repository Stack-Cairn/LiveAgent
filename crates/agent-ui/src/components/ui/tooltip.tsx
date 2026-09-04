import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

export function Tooltip<Payload = unknown>(props: TooltipPrimitive.Root.Props<Payload>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

/**
 * 分离式触发器：多个 TooltipTrigger 通过同一个 handle 共享一个 Tooltip 实例，
 * 列表类场景不必为每一行各挂一份弹层。
 */
export const createTooltipHandle = TooltipPrimitive.createHandle;

export function TooltipTrigger(
  props: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>,
) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Popup> &
  Pick<
    React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Positioner>,
    "align" | "anchor" | "collisionPadding" | "side" | "sideOffset"
  >;

export const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  (
    {
      align = "center",
      anchor,
      className,
      collisionPadding = 8,
      side = "top",
      sideOffset = 6,
      ...props
    },
    ref,
  ) => (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        collisionPadding={collisionPadding}
        side={side}
        sideOffset={sideOffset}
        className="layer-popover isolate"
      >
        <TooltipPrimitive.Popup
          ref={ref}
          data-slot="tooltip-content"
          className={cn(
            "max-w-64 rounded-lg border border-border/60 bg-popover px-2.5 py-1.5 text-xs font-medium leading-4 text-popover-foreground shadow-lg outline-none transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
            className,
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  ),
);
TooltipContent.displayName = "TooltipContent";
