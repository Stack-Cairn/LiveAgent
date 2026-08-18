import { Meter as MeterPrimitive } from "@base-ui/react/meter";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

export const Meter = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof MeterPrimitive.Root>
>(({ className, ...props }, ref) => (
  <MeterPrimitive.Root ref={ref} data-slot="meter" className={cn(className)} {...props} />
));
Meter.displayName = "Meter";
