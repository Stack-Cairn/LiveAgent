import { PreviewCard as Primitive } from "@base-ui/react/preview-card";
import * as React from "react";
import { cn } from "../../lib/shared/utils";
import { floatingSurfaceClassName } from "./menu-surface";
import { useZoneFontScaleStyle } from "./zone-font-scale";

export const PreviewCard = Primitive.Root;
export const PreviewCardTrigger = Primitive.Trigger;

type Props = React.ComponentPropsWithoutRef<typeof Primitive.Popup> &
  Pick<
    React.ComponentPropsWithoutRef<typeof Primitive.Positioner>,
    "side" | "sideOffset" | "align" | "anchor"
  >;

export const PreviewCardContent = React.forwardRef<HTMLDivElement, Props>(
  ({ side = "top", sideOffset = 8, align = "center", anchor, className, ...props }, ref) => {
    const zoneStyle = useZoneFontScaleStyle();
    return (
      <Primitive.Portal>
        <Primitive.Positioner
          anchor={anchor}
          side={side}
          sideOffset={sideOffset}
          align={align}
          collisionPadding={8}
          className="layer-popover"
          style={zoneStyle}
        >
          <Primitive.Popup
            ref={ref}
            className={cn(
              floatingSurfaceClassName,
              "w-80 max-w-(--available-width) max-h-(--available-height) overflow-y-auto p-3 text-sm outline-none",
              className,
            )}
            {...props}
          />
        </Primitive.Positioner>
      </Primitive.Portal>
    );
  },
);
PreviewCardContent.displayName = "PreviewCardContent";
