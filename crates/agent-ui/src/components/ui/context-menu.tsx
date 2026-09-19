import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import * as React from "react";
import { cn } from "../../lib/shared/utils";
import { DropdownMenuContent, DropdownMenuItem } from "./dropdown-menu";

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
// Base UI context menus use the same popup, positioning and item primitives.
export {
  DropdownMenuContent as ContextMenuContent,
  DropdownMenuLabel as ContextMenuLabel,
  DropdownMenuRadioGroup as ContextMenuRadioGroup,
  DropdownMenuRadioItem as ContextMenuRadioItem,
  DropdownMenuSeparator as ContextMenuSeparator,
  DropdownMenuSub as ContextMenuSub,
  DropdownMenuSubContent as ContextMenuSubContent,
  DropdownMenuSubTrigger as ContextMenuSubTrigger,
} from "./dropdown-menu";

export const ContextMenuItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DropdownMenuItem>
>(({ className, ...props }, ref) => (
  <DropdownMenuItem
    ref={ref}
    className={cn("cursor-pointer gap-2 rounded-lg px-2.5 text-left", className)}
    {...props}
  />
));
ContextMenuItem.displayName = "ContextMenuItem";

export const ContextMenuCheckboxItem = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-hidden transition-colors",
      "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  />
));
ContextMenuCheckboxItem.displayName = "ContextMenuCheckboxItem";

type ContextMenuPopupProps = Omit<
  React.ComponentPropsWithoutRef<typeof DropdownMenuContent>,
  "anchor"
> & {
  point: { x: number; y: number };
  coordinateRoot?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
};

/** For delegated right-click handlers (virtual rows and editor selections).
 * Coordinates are viewport-relative unless a local coordinate root is supplied.
 * Base UI owns collision handling, focus, keyboard navigation and dismissal.
 */
export const ContextMenuPopup = React.forwardRef<HTMLDivElement, ContextMenuPopupProps>(
  ({ point, coordinateRoot, onClose, ...props }, ref) => {
    const anchor = React.useMemo(
      () => ({
        getBoundingClientRect: () => {
          const bounds = coordinateRoot?.current?.getBoundingClientRect();
          return window.DOMRect.fromRect({
            x: point.x + (bounds?.left ?? 0),
            y: point.y + (bounds?.top ?? 0),
            width: 0,
            height: 0,
          });
        },
      }),
      [point.x, point.y, coordinateRoot],
    );

    return (
      <ContextMenu
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DropdownMenuContent
          ref={ref}
          anchor={anchor}
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          {...props}
        />
      </ContextMenu>
    );
  },
);
ContextMenuPopup.displayName = "ContextMenuPopup";
