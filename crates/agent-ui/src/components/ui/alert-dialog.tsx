import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogPortal = AlertDialogPrimitive.Portal;
export const AlertDialogClose = AlertDialogPrimitive.Close;

export const AlertDialogOverlay = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Backdrop
    ref={ref}
    data-slot="alert-dialog-overlay"
    className={cn(
      "fixed inset-0 z-[100] bg-black/55 backdrop-blur-sm transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
      className,
    )}
    {...props}
  />
));
AlertDialogOverlay.displayName = "AlertDialogOverlay";

type AlertDialogContentProps = React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Popup> & {
  overlayClassName?: string;
  portalProps?: React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Portal>;
  viewportClassName?: string;
};

export const AlertDialogContent = React.forwardRef<HTMLDivElement, AlertDialogContentProps>(
  ({ className, children, overlayClassName, portalProps, viewportClassName, ...props }, ref) => (
    <AlertDialogPortal {...portalProps}>
      <AlertDialogOverlay className={overlayClassName} />
      <AlertDialogPrimitive.Viewport
        data-slot="alert-dialog-viewport"
        className={cn(
          "fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto p-4",
          viewportClassName,
        )}
      >
        <AlertDialogPrimitive.Popup
          ref={ref}
          data-slot="alert-dialog-content"
          className={cn(
            "relative w-full max-w-lg overflow-hidden rounded-2xl border border-border/70 bg-background text-foreground shadow-2xl outline-none transition-[transform,opacity] duration-200 ease-out data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
            className,
          )}
          {...props}
        >
          {children}
        </AlertDialogPrimitive.Popup>
      </AlertDialogPrimitive.Viewport>
    </AlertDialogPortal>
  ),
);
AlertDialogContent.displayName = "AlertDialogContent";

export const AlertDialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    data-slot="alert-dialog-title"
    className={cn("text-base font-semibold leading-none text-foreground", className)}
    {...props}
  />
));
AlertDialogTitle.displayName = "AlertDialogTitle";

export const AlertDialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    data-slot="alert-dialog-description"
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
AlertDialogDescription.displayName = "AlertDialogDescription";

export { AlertDialogPrimitive };
