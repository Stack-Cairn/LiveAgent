import { Switch as SwitchPrimitive } from "@base-ui/react";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & {
  tone?: "default" | "success";
  /** `sm` is for switches that sit inline with a label rather than owning a row. */
  size?: "default" | "sm";
};

// Track and thumb have to move together: the thumb's travel is
// trackWidth - thumbWidth - inset, so overriding only the track from a call site
// would leave the thumb overshooting or short of the far edge.
const SWITCH_SIZES = {
  default: { track: "h-5 w-9", thumb: "h-4 w-4 data-[checked]:translate-x-[18px]" },
  sm: { track: "h-4 w-7", thumb: "h-3 w-3 data-[checked]:translate-x-[14px]" },
} as const;

export const Switch = React.forwardRef<HTMLElement, SwitchProps>(
  ({ className, tone = "default", size = "default", ...props }, ref) => (
    <SwitchPrimitive.Root
      ref={ref}
      data-slot="switch"
      className={cn(
        "peer inline-flex shrink-0 cursor-pointer items-center rounded-full bg-muted-foreground/20 transition-colors focus-visible:outline-none focus-visible:ring-2 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[unchecked]:hover:bg-muted-foreground/30",
        SWITCH_SIZES[size].track,
        tone === "success"
          ? "data-[checked]:bg-emerald-500 focus-visible:ring-emerald-500/30"
          : "data-[checked]:bg-sky-500 focus-visible:ring-sky-500/30",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block translate-x-0.5 rounded-full bg-white shadow-sm transition-transform",
          SWITCH_SIZES[size].thumb,
        )}
      />
    </SwitchPrimitive.Root>
  ),
);
Switch.displayName = "Switch";
