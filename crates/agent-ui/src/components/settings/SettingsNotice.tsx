import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";

const variants = {
  validation:
    "flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3 py-2.5 text-xs text-destructive",
  warning:
    "rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300",
  "installation-warning": "rounded-xl border border-amber-500/30 bg-amber-500/[0.05] p-3.5",
  "inline-error": "flex items-center gap-1.5 text-xs text-destructive",
} as const;

/** Presentation only; callers retain content, semantics and state. */
export function SettingsNotice({
  variant,
  className,
  ...props
}: ComponentProps<"div"> & { variant: keyof typeof variants }) {
  return <div {...props} className={cn(variants[variant], className)} />;
}
