import { Switch as SwitchPrimitive } from "@base-ui/react";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

// Unstyled parts for existing controls with a distinct track or hit area.
export const SwitchRoot = SwitchPrimitive.Root;
export const SwitchThumb = SwitchPrimitive.Thumb;

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> & {
  tone?: "default" | "success";
  /** `sm` is for switches that sit inline with a label rather than owning a row. */
  size?: "default" | "sm" | "lg";
};

// Track and thumb have to move together: the thumb's travel is
// trackWidth - thumbWidth - inset, so overriding only the track from a call site
// would leave the thumb overshooting or short of the far edge.
const SWITCH_SIZES = {
  default: { track: "h-5 w-9", thumb: "size-4 data-[checked]:translate-x-18px" },
  sm: { track: "h-4 w-7", thumb: "size-3 data-[checked]:translate-x-14px" },
  lg: {
    track: "relative inline-block h-6 w-11",
    thumb: "absolute left-0.5 top-0.5 size-5 translate-x-0 data-[checked]:translate-x-5",
  },
} as const;

export const Switch = React.forwardRef<HTMLElement, SwitchProps>(
  ({ className, tone = "default", size = "default", ...props }, ref) => (
    <SwitchRoot
      ref={ref}
      data-slot="switch"
      className={cn(
        "peer shrink-0 rounded-full bg-muted-foreground/20 transition-colors",
        size !== "lg" && "inline-flex cursor-pointer items-center",
        "focus-visible:outline-none focus-visible:ring-2 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[unchecked]:hover:bg-muted-foreground/30",
        SWITCH_SIZES[size].track,
        tone === "success"
          ? "data-[checked]:bg-emerald-500 focus-visible:ring-emerald-500/30"
          : "data-[checked]:bg-sky-500 focus-visible:ring-sky-500/30",
        size === "lg" && tone === "default" && "focus-visible:ring-sky-500/35",
        className,
      )}
      {...props}
    >
      <SwitchThumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block translate-x-0.5 rounded-full bg-white shadow-sm transition-transform",
          SWITCH_SIZES[size].thumb,
        )}
      />
    </SwitchRoot>
  ),
);
Switch.displayName = "Switch";
