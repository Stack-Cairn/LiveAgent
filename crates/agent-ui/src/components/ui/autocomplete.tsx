import { Autocomplete as Primitive } from "@base-ui/react/autocomplete";
import * as React from "react";
import { cn } from "../../lib/shared/utils";
import { Input } from "./input";
import { floatingSurfaceClassName } from "./menu-surface";
import { useZoneFontScaleStyle } from "./zone-font-scale";

// coss composition: Root / Input / Portal / Positioner / Popup / List / Item.
export const Autocomplete = Primitive.Root;
export const AutocompleteEmpty = Primitive.Empty;
export const AutocompleteInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentPropsWithoutRef<typeof Primitive.Input>
>((props, ref) => <Primitive.Input ref={ref} render={<Input />} {...props} />);
AutocompleteInput.displayName = "AutocompleteInput";

export function AutocompletePopup({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof Primitive.Popup>) {
  const zoneStyle = useZoneFontScaleStyle();
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        sideOffset={4}
        collisionPadding={8}
        className="layer-popover"
        style={zoneStyle}
      >
        <Primitive.Popup
          className={cn(
            floatingSurfaceClassName,
            "flex max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) flex-col overflow-hidden p-1 text-sm",
            className,
          )}
          {...props}
        />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}

export function AutocompleteList(props: React.ComponentPropsWithoutRef<typeof Primitive.List>) {
  return (
    <Primitive.List
      {...props}
      className={cn("min-h-0 max-h-64 overflow-y-auto overscroll-contain", props.className)}
    />
  );
}

export function AutocompleteItem(props: React.ComponentPropsWithoutRef<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      {...props}
      className={cn(
        "flex cursor-pointer select-none items-center rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        props.className,
      )}
    />
  );
}
