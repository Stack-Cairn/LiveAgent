import { Switch as SwitchPrimitive } from "@base-ui/react";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

export const Switch = React.forwardRef<
  HTMLElement,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    data-slot="switch"
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-muted-foreground/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30 data-[checked]:bg-sky-500 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[unchecked]:hover:bg-muted-foreground/30",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      className="pointer-events-none block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[checked]:translate-x-[18px]"
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
