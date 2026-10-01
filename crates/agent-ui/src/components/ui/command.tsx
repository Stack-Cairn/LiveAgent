// Command palette composition following https://coss.com/ui/docs/components/command.
// Uses the project's Base UI primitives and semantic colors.
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/shared/utils";
import { Search } from "../IconSet";

export const CommandDialog = DialogPrimitive.Root;
export const CommandDialogTrigger = DialogPrimitive.Trigger;
export const CommandDialogTitle = DialogPrimitive.Title;
export const CommandDialogDescription = DialogPrimitive.Description;

export function CommandDialogPopup({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="layer-modal fixed inset-0 bg-black/30 backdrop-blur-sm transition-opacity duration-200 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-reduce:transition-none" />
      <DialogPrimitive.Viewport className="layer-modal fixed inset-0 flex flex-col items-center justify-center px-4 py-[4vh] sm:py-[6vh]">
        <DialogPrimitive.Popup
          data-slot="command-dialog-popup"
          className={cn(
            "relative flex max-h-full min-h-0 w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-settings-tile text-popover-foreground shadow-xl outline-none transition-[opacity,scale] duration-200 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 motion-reduce:transition-none",
            className,
          )}
          {...props}
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}

export function Command<Item>(
  props: Omit<Autocomplete.Root.Props<Item>, "items"> & { items?: readonly Item[] },
) {
  return <Autocomplete.Root autoHighlight="always" keepHighlight inline open {...props} />;
}

export function CommandInput({
  className,
  startAddon,
  ...props
}: Autocomplete.Input.Props & { startAddon?: ReactNode }) {
  return (
    <div className="relative flex h-14 shrink-0 items-center gap-3 px-4">
      {startAddon ?? <Search className="size-4 shrink-0 text-muted-foreground" />}
      <Autocomplete.Input
        autoFocus
        data-slot="command-input"
        className={cn(
          "h-full min-w-0 flex-1 border-0 bg-transparent text-base outline-none placeholder:text-muted-foreground",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandPanel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="command-panel"
      className={cn(
        "relative flex min-h-0 flex-1 flex-col rounded-t-xl border-t border-foreground/5 bg-popover",
        className,
      )}
      {...props}
    />
  );
}
export function CommandList({ className, ...props }: Autocomplete.List.Props) {
  return (
    <Autocomplete.List
      data-slot="command-list"
      className={cn("min-h-0 overflow-y-auto overscroll-contain scroll-py-2 p-2", className)}
      {...props}
    />
  );
}
export const CommandGroup = Autocomplete.Group;
export function CommandGroupLabel({ className, ...props }: Autocomplete.GroupLabel.Props) {
  return (
    <Autocomplete.GroupLabel
      className={cn(
        "flex items-center gap-2 px-2 py-2 text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
export function CommandItem({ className, ...props }: Autocomplete.Item.Props) {
  return (
    <Autocomplete.Item
      data-slot="command-item"
      className={cn(
        "flex cursor-default select-none flex-col items-start rounded-lg px-3 py-2 text-left text-sm outline-none data-[highlighted]:bg-settings-active dark:data-[highlighted]:bg-settings-tile-hover data-[highlighted]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
export function CommandFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        "relative flex shrink-0 items-center justify-between gap-2 border-t border-foreground/5 px-4 py-3 text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
