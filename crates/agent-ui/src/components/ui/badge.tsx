import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/shared/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium leading-none transition-colors",
  {
    variants: {
      size: {
        default: "",
        compact: "rounded-full border-0 px-1.5 text-tiny leading-none",
        "filter-count":
          "h-4 min-w-4 rounded-full px-1 text-tiny font-semibold tabular-nums group-data-[active]:bg-foreground/[0.08] group-data-[active]:text-foreground",
      },
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border bg-background text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        success: "border-success/25 bg-success/10 text-success",
        destructive: "border-destructive/25 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type BadgeProps = Omit<React.HTMLAttributes<HTMLSpanElement>, "className"> &
  VariantProps<typeof badgeVariants> & {
    className?: string;
    render?: React.ReactElement;
  };

export const Badge = React.forwardRef<HTMLElement, BadgeProps>(
  ({ className, variant, size, render, ...props }, ref) =>
    useRender({
      defaultTagName: "span",
      render,
      ref,
      props: {
        ...props,
        className: cn(badgeVariants({ variant, size }), className),
      },
    }),
);

Badge.displayName = "Badge";

export { badgeVariants };
