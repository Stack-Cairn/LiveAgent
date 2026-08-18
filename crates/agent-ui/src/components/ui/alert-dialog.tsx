import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { X } from "@liveagent/ui/components/IconSet";
import * as React from "react";

import { cn } from "../../lib/shared/utils";
import { Button } from "./button";

export function AlertDialog(
  props: React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Root>,
) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogPortal(
  props: React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Portal>,
) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

export function AlertDialogClose(
  props: React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Close>,
) {
  return <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />;
}

export function AlertDialogCloseButton({
  className,
  disabled,
  label,
}: {
  className?: string;
  disabled?: boolean;
  label: string;
}) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-close-button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={className}
      render={<Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-lg" />}
    >
      <X className="h-4 w-4" />
    </AlertDialogPrimitive.Close>
  );
}

const AlertDialogOverlay = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Backdrop
    ref={ref}
    data-slot="alert-dialog-overlay"
    className={cn(
      "layer-modal fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
      className,
    )}
    {...props}
  />
));
AlertDialogOverlay.displayName = "AlertDialogOverlay";

type AlertDialogContentProps = React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Popup>;

export const AlertDialogContent = React.forwardRef<HTMLDivElement, AlertDialogContentProps>(
  ({ className, children, ...props }, ref) => (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Viewport
        data-slot="alert-dialog-viewport"
        className="layer-modal fixed inset-0 flex min-h-0 flex-col items-center overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]"
      >
        <AlertDialogPrimitive.Popup
          ref={ref}
          data-slot="alert-dialog-content"
          className={cn(
            "relative my-auto w-full max-w-lg rounded-2xl border border-border/70 bg-background p-6 text-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 ease-out data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
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

export const AlertDialogHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="alert-dialog-header"
    className={cn(
      "flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-5 py-4 max-[820px]:px-3.5 max-[820px]:py-3",
      className,
    )}
    {...props}
  />
));
AlertDialogHeader.displayName = "AlertDialogHeader";

export const AlertDialogBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="alert-dialog-body"
    className={cn("px-5 py-4 max-[820px]:px-3.5 max-[820px]:py-3.5", className)}
    {...props}
  />
));
AlertDialogBody.displayName = "AlertDialogBody";

export const AlertDialogFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="alert-dialog-footer"
    className={cn(
      "flex shrink-0 flex-row items-center justify-end gap-2 border-t border-border/60 px-5 py-4 max-[820px]:flex-col-reverse max-[820px]:items-stretch max-[820px]:px-3.5 max-[820px]:py-3",
      className,
    )}
    {...props}
  />
));
AlertDialogFooter.displayName = "AlertDialogFooter";

export const AlertDialogActions = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="alert-dialog-actions"
    className={cn(
      "flex min-w-0 items-center justify-end gap-2 max-[820px]:w-full max-sm:grid max-sm:grid-cols-2 max-sm:has-[>:only-child]:grid-cols-1 max-sm:[&>button]:w-full",
      className,
    )}
    {...props}
  />
));
AlertDialogActions.displayName = "AlertDialogActions";

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
