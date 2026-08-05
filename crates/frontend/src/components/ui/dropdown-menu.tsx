import { Menu } from "@base-ui/react";
import * as React from "react";
import { cn } from "../../lib/shared/utils";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuSub = Menu.SubmenuRoot;

type DropdownMenuContentProps = React.ComponentPropsWithoutRef<typeof Menu.Popup> &
  Pick<
    React.ComponentPropsWithoutRef<typeof Menu.Positioner>,
    "side" | "align" | "sideOffset" | "collisionPadding"
  >;

export const DropdownMenuContent = React.forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  ({ className, side, align, sideOffset = 4, collisionPadding, ...props }, ref) => (
    <Menu.Portal>
      <Menu.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className="z-[9999]"
      >
        <Menu.Popup
          ref={ref}
          className={cn(
            "min-w-48 max-h-[min(var(--available-height),66vh)] overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            className,
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  ),
);
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuLabel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("px-2 py-1.5 text-sm font-semibold", className)} {...props} />
));
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof Menu.Separator>
>(({ className, ...props }, ref) => (
  <Menu.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

type DropdownMenuSubTriggerProps = React.ComponentPropsWithoutRef<typeof Menu.SubmenuTrigger> & {
  // Menu-button style trigger (e.g. an icon "⋯" button): disables hover-open,
  // which flips Base UI's click handling from open-only to an open/close
  // toggle so a second click dismisses the submenu.
  clickToggle?: boolean;
};

export const DropdownMenuSubTrigger = React.forwardRef<HTMLElement, DropdownMenuSubTriggerProps>(
  ({ className, clickToggle, ...props }, ref) => (
    <Menu.SubmenuTrigger
      ref={ref}
      openOnHover={clickToggle ? false : undefined}
      className={cn(
        "relative flex cursor-default select-none items-center rounded-xs px-2 py-1.5 text-sm outline-hidden transition-colors data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[popup-open]:bg-accent data-[popup-open]:text-accent-foreground data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = React.forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  (
    { className, side = "right", align = "start", sideOffset = 6, collisionPadding, ...props },
    ref,
  ) => (
    <Menu.Portal>
      <Menu.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className="z-[9999]"
      >
        <Menu.Popup
          ref={ref}
          className={cn(
            "min-w-48 max-h-[min(var(--available-height),66vh)] overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            className,
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  ),
);
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

type DropdownMenuItemProps = React.ComponentPropsWithoutRef<typeof Menu.Item> & {
  onSelect?: () => void;
};

export const DropdownMenuItem = React.forwardRef<HTMLDivElement, DropdownMenuItemProps>(
  ({ className, onSelect, onClick, ...props }, ref) => (
    <Menu.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center rounded-xs px-2 py-1.5 text-sm outline-hidden transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
      onClick={(e) => {
        onSelect?.();
        onClick?.(e);
      }}
    />
  ),
);
DropdownMenuItem.displayName = "DropdownMenuItem";
