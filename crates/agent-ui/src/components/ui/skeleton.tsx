import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";

const skeletonVariants = cva("motion-reduce:animate-none!", {
  variants: {
    variant: {
      shimmer: "bg-skills-skeleton-shimmer bg-size-[200%_100%] animate-skills-skeleton-shimmer",
      pulse:
        "bg-hsl-muted-foreground-10 animate-skills-skeleton-pulse nth-2:[animation-delay:var(--ui-duration-80ms)] nth-3:[animation-delay:var(--ui-duration-160ms)] nth-4:[animation-delay:var(--ui-duration-240ms)] nth-5:[animation-delay:var(--ui-duration-320ms)] nth-6:[animation-delay:var(--ui-duration-400ms)]",
    },
  },
  defaultVariants: { variant: "shimmer" },
});

/** Presentation only: callers retain the original dimensions, DOM attributes and content. */
export function Skeleton({
  variant,
  className,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return <div {...props} className={cn(skeletonVariants({ variant }), className)} />;
}
