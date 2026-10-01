import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";
import { SelectContent, SelectTrigger } from "../ui/select";

export const SETTINGS_PICKER_TRIGGER_CLASS = cn(
  "inline-flex h-8 w-fit max-w-260px items-center gap-1.5",
  "whitespace-nowrap rounded-lg border-0 bg-control-surface px-3 py-0",
  "text-sm font-normal leading-none",
  "transition-colors duration-150 hover:bg-settings-tile-hover",
  "dark:ring-1 dark:ring-inset dark:ring-foreground/15 dark:hover:bg-settings-active",
  "focus-visible:ring-2 focus-visible:ring-ring",
  "[&_svg]:size-3.5 [&_svg]:opacity-70",
);

export function SettingsSelectTrigger({
  className,
  ...props
}: ComponentProps<typeof SelectTrigger>) {
  return <SelectTrigger className={cn(SETTINGS_PICKER_TRIGGER_CLASS, className)} {...props} />;
}

export function SettingsSelectContent({
  className,
  ...props
}: ComponentProps<typeof SelectContent>) {
  return (
    <SelectContent
      className={cn(
        "[&_[role=option]]:min-h-8 [&_[role=option]]:rounded-lg",
        "[&_[role=option]]:px-2.5 [&_[role=option]]:text-sm",
        "[&_[role=option]+[role=option]]:mt-0.5",
        "[&_[role=option][data-highlighted]]:bg-settings-tile-hover",
        "[&_[role=option][data-selected]]:bg-settings-active",
        className,
      )}
      {...props}
    />
  );
}
