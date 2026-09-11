import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";

const emptyStateVariants = cva("", {
  variants: {
    size: { default: "", compact: "" },
    variant: {
      workspace:
        "flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground",
      settings:
        "flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 bg-muted/20 py-14 text-center",
    },
  },
  compoundVariants: [{ variant: "settings", size: "compact", className: "gap-3 py-12" }],
  defaultVariants: { variant: "workspace", size: "default" },
});

/** Layout only; the caller owns content, actions and loading/error semantics. */
export function EmptyState({
  variant,
  size,
  className,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof emptyStateVariants>) {
  return <div {...props} className={cn(emptyStateVariants({ variant, size }), className)} />;
}
