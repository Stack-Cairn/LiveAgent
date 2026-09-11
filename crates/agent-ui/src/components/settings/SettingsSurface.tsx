import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";

/** Shared surface for grouped settings and setup steps. */
export function SettingsSurface({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "overflow-hidden rounded-2xl border border-border/75 bg-card shadow-settings-surface",
        className,
      )}
    />
  );
}
