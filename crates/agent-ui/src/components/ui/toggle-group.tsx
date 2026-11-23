import { Toggle, ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

// The group's pressed values, so each item can tell the composite whether it
// should hold the roving tab stop when the group mounts.
const ToggleGroupValueContext = React.createContext<readonly unknown[] | undefined>(undefined);

export const ToggleGroup = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive>
>(({ className, ...props }, ref) => (
  <ToggleGroupValueContext.Provider value={props.value ?? props.defaultValue}>
    <ToggleGroupPrimitive
      ref={ref}
      data-slot="toggle-group"
      className={cn("flex items-center", className)}
      {...props}
    />
  </ToggleGroupValueContext.Provider>
));
ToggleGroup.displayName = "ToggleGroup";

export const ToggleGroupItem = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof Toggle>
>(({ className, ...props }, ref) => {
  const groupValue = React.useContext(ToggleGroupValueContext);
  // The composite starts its single tab stop on the item marked active; without
  // the mark it lands on the first item even when another one is pressed.
  const active = props.value !== undefined && groupValue?.includes(props.value) === true;
  return (
    <Toggle
      ref={ref}
      data-slot="toggle-group-item"
      data-composite-item-active={active ? "" : undefined}
      className={cn(
        "inline-flex items-center justify-center",
        "whitespace-nowrap rounded-md text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[pressed]:bg-accent data-[pressed]:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
});
ToggleGroupItem.displayName = "ToggleGroupItem";
