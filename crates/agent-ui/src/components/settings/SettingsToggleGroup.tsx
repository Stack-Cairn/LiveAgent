import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

export function SettingsToggleGroup({ className, ...props }: ComponentProps<typeof ToggleGroup>) {
  return (
    <ToggleGroup
      className={cn(
        "gap-0.5 rounded-xl bg-segmented-track p-1",
        "ring-1 ring-foreground/5",
        className,
      )}
      {...props}
    />
  );
}

export function SettingsToggleGroupItem({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupItem>) {
  return (
    <ToggleGroupItem
      className={cn(
        "h-7 min-w-9 rounded-lg px-2.5 text-xs font-normal text-muted-foreground",
        "hover:bg-control-surface hover:text-foreground",
        "data-[pressed]:bg-segmented-selected data-[pressed]:font-medium data-[pressed]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
