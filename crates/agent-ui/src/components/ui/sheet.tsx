import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { X } from "@liveagent/ui/components/IconSet";
import * as React from "react";

import { cn } from "../../lib/shared/utils";
import { Button } from "./button";

export const Sheet = SheetPrimitive.Root;
export const SheetPortal = SheetPrimitive.Portal;

export function SheetTrigger(props: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

export function SheetClose(props: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

export const SheetBackdrop = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Backdrop
    ref={ref}
    data-slot="sheet-backdrop"
    className={cn(
      "fixed inset-0 z-[100] bg-black/35 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
      className,
    )}
    {...props}
  />
));
SheetBackdrop.displayName = "SheetBackdrop";

type SheetSide = "top" | "right" | "bottom" | "left";
type SheetVariant = "default" | "inset";

type SheetViewportProps = React.ComponentPropsWithoutRef<typeof SheetPrimitive.Viewport> & {
  side?: SheetSide;
  variant?: SheetVariant;
};

export const SheetViewport = React.forwardRef<HTMLDivElement, SheetViewportProps>(
  ({ className, side = "right", variant = "default", ...props }, ref) => (
    <SheetPrimitive.Viewport
      ref={ref}
      data-slot="sheet-viewport"
      className={cn(
        "fixed inset-0 z-[100] grid",
        side === "bottom" && "grid-rows-[1fr_auto] pt-12",
        side === "top" && "grid-rows-[auto_1fr] pb-12",
        side === "left" && "flex justify-start",
        side === "right" && "flex justify-end",
        variant === "inset" && "sm:p-4",
        className,
      )}
      {...props}
    />
  ),
);
SheetViewport.displayName = "SheetViewport";

type SheetPopupProps = React.ComponentPropsWithoutRef<typeof SheetPrimitive.Popup> & {
  backdropClassName?: string;
  closeLabel?: string;
  closeProps?: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Close>;
  portalProps?: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Portal>;
  showCloseButton?: boolean;
  side?: SheetSide;
  variant?: SheetVariant;
};

export const SheetPopup = React.forwardRef<HTMLDivElement, SheetPopupProps>(
  (
    {
      side = "right",
      variant = "default",
      backdropClassName,
      className,
      children,
      closeLabel = "Close",
      closeProps,
      portalProps,
      showCloseButton = true,
      ...props
    },
    ref,
  ) => (
    <SheetPortal {...portalProps}>
      <SheetBackdrop className={backdropClassName} />
      <SheetViewport side={side} variant={variant}>
        <SheetPrimitive.Popup
          ref={ref}
          data-slot="sheet-popup"
          className={cn(
            "relative flex max-h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background text-foreground shadow-2xl outline-none transition-[transform,opacity] duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            side === "top" &&
              "max-h-[85dvh] border-b data-[ending-style]:-translate-y-8 data-[starting-style]:-translate-y-8",
            side === "right" &&
              "h-full w-[calc(100%-3rem)] max-w-lg border-l data-[ending-style]:translate-x-8 data-[starting-style]:translate-x-8",
            side === "bottom" &&
              "row-start-2 max-h-[85dvh] border-t data-[ending-style]:translate-y-8 data-[starting-style]:translate-y-8",
            side === "left" &&
              "h-full w-[calc(100%-3rem)] max-w-lg border-r data-[ending-style]:-translate-x-8 data-[starting-style]:-translate-x-8",
            variant === "inset" && "sm:rounded-2xl sm:border",
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton ? (
            <SheetPrimitive.Close
              data-slot="sheet-close"
              aria-label={closeLabel}
              title={closeLabel}
              className="absolute right-3 top-3 z-10"
              render={<Button variant="ghost" size="icon" className="h-8 w-8" />}
              {...closeProps}
            >
              <X className="h-4 w-4" />
            </SheetPrimitive.Close>
          ) : null}
        </SheetPrimitive.Popup>
      </SheetViewport>
    </SheetPortal>
  ),
);
SheetPopup.displayName = "SheetPopup";

export const SheetHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="sheet-header"
      className={cn("flex shrink-0 flex-col gap-2 p-6", className)}
      {...props}
    />
  ),
);
SheetHeader.displayName = "SheetHeader";

export const SheetPanel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="sheet-panel"
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain p-6", className)}
      {...props}
    />
  ),
);
SheetPanel.displayName = "SheetPanel";

type SheetFooterProps = React.HTMLAttributes<HTMLDivElement> & {
  variant?: "default" | "bare";
};

export const SheetFooter = React.forwardRef<HTMLDivElement, SheetFooterProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <div
      ref={ref}
      data-slot="sheet-footer"
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 px-6 sm:flex-row sm:items-center sm:justify-end",
        variant === "default" && "border-t border-border bg-muted/40 py-4",
        variant === "bare" && "pb-6 pt-4",
        className,
      )}
      {...props}
    />
  ),
);
SheetFooter.displayName = "SheetFooter";

export const SheetTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    data-slot="sheet-title"
    className={cn("text-base font-semibold leading-none text-foreground", className)}
    {...props}
  />
));
SheetTitle.displayName = "SheetTitle";

export const SheetDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    data-slot="sheet-description"
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = "SheetDescription";

export { SheetBackdrop as SheetOverlay, SheetPopup as SheetContent, SheetPrimitive };
