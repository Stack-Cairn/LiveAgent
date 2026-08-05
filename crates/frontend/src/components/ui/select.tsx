import { Select as SelectPrimitive } from "@base-ui/react";
import * as React from "react";
import { cn } from "../../lib/shared/utils";
import { Check, ChevronDown, ChevronUp } from "../icons";

type SelectProps = Omit<
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Root>,
  "onValueChange"
> & {
  onValueChange?: (value: string) => void;
};

export function Select({ onValueChange, ...props }: SelectProps) {
  return (
    <SelectPrimitive.Root
      onValueChange={
        onValueChange
          ? (value) => {
              if (value != null) onValueChange(value as string);
            }
          : undefined
      }
      {...props}
    />
  );
}

type SelectValueProps = Omit<
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Value>,
  "children"
> & {
  placeholder?: React.ReactNode;
  children?: React.ReactNode | ((value: unknown) => React.ReactNode);
};

export const SelectValue = React.forwardRef<HTMLSpanElement, SelectValueProps>(
  ({ placeholder, children, ...props }, ref) => {
    return (
      <SelectPrimitive.Value ref={ref} placeholder={placeholder} {...props}>
        {children as React.ComponentPropsWithoutRef<typeof SelectPrimitive.Value>["children"]}
      </SelectPrimitive.Value>
    );
  },
);
SelectValue.displayName = "SelectValue";

export const SelectTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus:border-input focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

const SelectScrollUpButton = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpArrow>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpArrow
    ref={ref}
    // Base UI renders scroll arrows position:absolute (inline style); they
    // must be anchored and given a background or they float transparently
    // over the list items.
    className={cn(
      "left-0 top-0 z-[1] flex w-full cursor-default items-center justify-center rounded-t-md bg-popover py-1",
      className,
    )}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpArrow>
));
SelectScrollUpButton.displayName = "SelectScrollUpButton";

const SelectScrollDownButton = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownArrow>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownArrow
    ref={ref}
    className={cn(
      "bottom-0 left-0 z-[1] flex w-full cursor-default items-center justify-center rounded-b-md bg-popover py-1",
      className,
    )}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownArrow>
));
SelectScrollDownButton.displayName = "SelectScrollDownButton";

export const SelectContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Popup> & {
    position?: "popper" | "item-aligned";
  }
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-[9999]">
      <SelectPrimitive.Popup
        ref={ref}
        className={cn(
          "max-h-96 min-w-32 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.List
          className={cn(
            "p-1 max-h-[inherit] overflow-y-auto",
            position === "popper" && "w-full min-w-(--anchor-width)",
          )}
        >
          {children}
        </SelectPrimitive.List>
        <SelectScrollDownButton />
      </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = "SelectContent";

export const SelectItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    /**
     * Optional secondary line rendered under the item label. Kept OUTSIDE
     * ItemText on purpose: ItemText must stay text-only (it feeds typeahead
     * and the trigger's value reflection), so rich item layouts go here.
     */
    description?: React.ReactNode;
  }
>(({ className, children, description, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-xs py-1.5 pl-2 pr-8 text-sm outline-hidden data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span
      className={cn(
        "absolute right-2 flex h-3.5 w-3.5 items-center justify-center",
        description != null && "top-1/2 -translate-y-1/2",
      )}
    >
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    {description == null ? (
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    ) : (
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        <span className="truncate text-[10px] leading-tight text-muted-foreground/70">
          {description}
        </span>
      </span>
    )}
  </SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";
