import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { X } from "@liveagent/ui/components/IconSet";
import * as React from "react";

import { cn } from "../../lib/shared/utils";
import { Button } from "./button";

export function Sheet(props: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

export function SheetPortal(props: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

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
      "layer-modal fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
      className,
    )}
    {...props}
  />
));
SheetBackdrop.displayName = "SheetBackdrop";

type SheetSide = "top" | "right" | "bottom" | "left";
type SheetVariant = "default" | "inset";

type SheetPopupProps = React.ComponentPropsWithoutRef<typeof SheetPrimitive.Popup> & {
  closeLabel?: string;
  closeProps?: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Close>;
  showCloseButton?: boolean;
  side?: SheetSide;
  variant?: SheetVariant;
};

export const SheetPopup = React.forwardRef<HTMLDivElement, SheetPopupProps>(
  (
    {
      side = "right",
      variant = "default",
      className,
      children,
      closeLabel = "Close",
      closeProps,
      showCloseButton = true,
      ...props
    },
    ref,
  ) => (
    <SheetPortal>
      <SheetBackdrop />
      <SheetPrimitive.Popup
        ref={ref}
        data-slot="sheet-popup"
        data-side={side}
        className={cn(
          "layer-modal fixed flex max-h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground shadow-2xl outline-none transition-[transform,opacity] duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
          side === "top" &&
            "inset-x-0 top-0 max-h-[85dvh] border-b data-[ending-style]:-translate-y-8 data-[starting-style]:-translate-y-8",
          side === "right" &&
            "inset-y-0 right-0 w-[calc(100%-3rem)] max-w-lg border-l data-[ending-style]:translate-x-8 data-[starting-style]:translate-x-8",
          side === "bottom" &&
            "inset-x-0 bottom-0 max-h-[85dvh] border-t data-[ending-style]:translate-y-8 data-[starting-style]:translate-y-8",
          side === "left" &&
            "inset-y-0 left-0 w-[calc(100%-3rem)] max-w-lg border-r data-[ending-style]:-translate-x-8 data-[starting-style]:-translate-x-8",
          variant === "inset" && side === "right" && "inset-y-4 right-4 rounded-2xl border",
          variant === "inset" && side === "left" && "inset-y-4 left-4 rounded-2xl border",
          variant === "inset" && side === "top" && "inset-x-4 top-4 rounded-2xl border",
          variant === "inset" && side === "bottom" && "inset-x-4 bottom-4 rounded-2xl border",
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

export { SheetBackdrop as SheetOverlay, SheetPopup as SheetContent };
