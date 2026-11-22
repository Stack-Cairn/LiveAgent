import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../../lib/shared/utils";

const statusDotVariants = cva("inline-block shrink-0 rounded-full", {
  variants: {
    tone: {
      success: "bg-success",
      warning: "bg-warning",
      info: "bg-info",
      destructive: "bg-destructive",
      primary: "bg-primary",
      muted: "bg-muted-foreground/40",
    },
    size: {
      sm: "size-1.5",
      md: "size-2",
    },
    pulse: {
      true: "animate-pulse",
      false: "",
    },
  },
  defaultVariants: { tone: "muted", size: "sm", pulse: false },
});

/**
 * Small state indicator (running, saved, connected). Decorative: the caller
 * keeps the state in text or an accessible label next to it.
 */
export function StatusDot({
  tone,
  size,
  pulse,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & VariantProps<typeof statusDotVariants>) {
  return (
    <span
      aria-hidden="true"
      {...props}
      className={cn(statusDotVariants({ tone, size, pulse }), className)}
    />
  );
}
