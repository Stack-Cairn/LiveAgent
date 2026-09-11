import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";

const variants = {
  collapsible: "overflow-hidden rounded-xl border border-border/60 bg-muted/20",
  configuration: "space-y-3 rounded-xl border border-border/70 bg-muted/35 p-4",
} as const;

/** Presentation only; callers retain content, semantics and state. */
export function SettingsPanel({
  variant,
  className,
  ...props
}: ComponentProps<"div"> & { variant: keyof typeof variants }) {
  return <div {...props} className={cn(variants[variant], className)} />;
}

export function SettingsHint({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      {...props}
      className={cn(
        "rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground",
        className,
      )}
    />
  );
}
