import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "@liveagent/ui/components/IconSet";
import * as React from "react";

import { cn } from "../../lib/shared/utils";
import { Button } from "./button";

export function Dialog(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogPortal(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

export function DialogTrigger(
  props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>,
) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export function DialogClose(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

const DialogOverlay = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Backdrop
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      "layer-modal fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

type DialogLayout = "center" | "fullscreen-mobile" | "bottom-sheet-mobile";

type DialogContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Popup> & {
  closeDisabled?: boolean;
  closeLabel?: string;
  layout?: DialogLayout;
  showCloseButton?: boolean;
};

export const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      className,
      children,
      closeDisabled = false,
      closeLabel = "Close",
      layout = "center",
      showCloseButton = false,
      ...props
    },
    ref,
  ) => (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Viewport
        data-slot="dialog-viewport"
        data-layout={layout}
        className={cn(
          "layer-modal fixed inset-0 flex min-h-0 flex-col items-center overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]",
          layout === "fullscreen-mobile" &&
            "max-[720px]:items-stretch max-[720px]:overflow-hidden max-[720px]:p-0",
          layout === "bottom-sheet-mobile" &&
            "items-stretch justify-end overflow-hidden p-0 sm:items-center sm:justify-start sm:overflow-y-auto sm:px-4 sm:pb-[max(1rem,env(safe-area-inset-bottom))] sm:pt-[max(1rem,env(safe-area-inset-top))]",
        )}
      >
        <DialogPrimitive.Popup
          ref={ref}
          data-slot="dialog-content"
          data-layout={layout}
          data-has-close-button={showCloseButton ? "true" : undefined}
          className={cn(
            "group/dialog relative my-auto w-full max-w-lg rounded-2xl border border-border/70 bg-background p-6 text-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 ease-out data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
            layout === "fullscreen-mobile" &&
              "max-[720px]:my-0 max-[720px]:h-full max-[720px]:max-w-none max-[720px]:rounded-none max-[720px]:border-0",
            layout === "bottom-sheet-mobile" &&
              "my-0 max-w-none rounded-b-none sm:my-auto sm:max-w-2xl sm:rounded-b-2xl",
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton ? (
            <DialogCloseButton disabled={closeDisabled} label={closeLabel} />
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPortal>
  ),
);
DialogContent.displayName = "DialogContent";

type DialogCloseButtonProps = {
  className?: string;
  disabled?: boolean;
  label: string;
};

export function DialogCloseButton({ className, disabled, label }: DialogCloseButtonProps) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close-button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn(
        "absolute right-4 top-4 z-10 group-data-[layout=fullscreen-mobile]/dialog:max-[720px]:top-[max(1rem,env(safe-area-inset-top))]",
        className,
      )}
      render={<Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" />}
    >
      <X className="h-4 w-4" />
    </DialogPrimitive.Close>
  );
}

export const DialogHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="dialog-header"
      className={cn(
        "relative flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-5 py-4 max-[820px]:px-3.5 max-[820px]:py-3 group-data-[layout=fullscreen-mobile]/dialog:max-[720px]:pt-[max(0.75rem,env(safe-area-inset-top))]",
        className,
        "group-data-[has-close-button=true]/dialog:pr-14 group-data-[has-close-button=true]/dialog:max-[820px]:pr-12",
      )}
      {...props}
    />
  ),
);
DialogHeader.displayName = "DialogHeader";

export const DialogSubheader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="dialog-subheader"
    className={cn(
      "shrink-0 border-b border-border/40 px-5 py-4 max-[820px]:px-3.5 max-[820px]:py-3",
      className,
    )}
    {...props}
  />
));
DialogSubheader.displayName = "DialogSubheader";

export const DialogBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="dialog-body"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 max-[820px]:px-3.5 max-[820px]:py-3.5",
        className,
      )}
      {...props}
    />
  ),
);
DialogBody.displayName = "DialogBody";

export const DialogSectionHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="dialog-section-header"
    className={cn(
      "mb-4 flex items-center justify-between gap-2 max-[820px]:items-start max-[820px]:flex-col",
      className,
    )}
    {...props}
  />
));
DialogSectionHeader.displayName = "DialogSectionHeader";

export const DialogFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-row items-center justify-end gap-2 border-t border-border/60 px-5 py-4 max-[820px]:flex-col-reverse max-[820px]:items-stretch max-[820px]:px-3.5 max-[820px]:py-3 group-data-[layout=bottom-sheet-mobile]/dialog:max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))] group-data-[layout=fullscreen-mobile]/dialog:max-[720px]:pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        className,
      )}
      {...props}
    />
  ),
);
DialogFooter.displayName = "DialogFooter";

export const DialogActions = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="dialog-actions"
      className={cn(
        "flex min-w-0 items-center justify-end gap-2 max-[820px]:w-full max-sm:grid max-sm:grid-cols-2 max-sm:has-[>:only-child]:grid-cols-1 max-sm:[&>button]:w-full",
        className,
      )}
      {...props}
    />
  ),
);
DialogActions.displayName = "DialogActions";

export const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="dialog-title"
    className={cn("text-base font-semibold leading-none text-foreground", className)}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="dialog-description"
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";
