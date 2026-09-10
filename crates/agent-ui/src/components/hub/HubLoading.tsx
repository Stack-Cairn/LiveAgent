import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";
import { Loader2 } from "../IconSet";

const loadingSurfaceVariants = cva("relative overflow-hidden rounded-14px border", {
  variants: {
    variant: {
      hero: "border-hsl-border-55 bg-hub-frost-hero backdrop-blur-24px backdrop-saturate-180 shadow-hub-frost-hero dark:border-hsl-0-0-100-0p08 dark:bg-hub-frost-hero-dark dark:shadow-hub-frost-hero-dark",
      skeleton:
        "border-hsl-border-35 bg-hsl-background-50 backdrop-blur-18px backdrop-saturate-170",
    },
  },
  defaultVariants: { variant: "skeleton" },
});

export function LoadingSurface({
  variant,
  className,
  ...props
}: ComponentProps<"div"> & VariantProps<typeof loadingSurfaceVariants>) {
  return <div {...props} className={cn(loadingSurfaceVariants({ variant }), className)} />;
}

export function LoadingTrack({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "relative h-2px w-full overflow-hidden rounded-full bg-hsl-muted-foreground-10",
        "after:absolute after:inset-y-0 after:left-0 after:w-2/5 after:rounded-[inherit] after:bg-primary/35 after:animate-hub-loading-progress after:content-['']",
        "motion-reduce:after:animate-none!",
        className,
      )}
    />
  );
}

export function FrostSpinner() {
  return (
    <Loader2
      className="size-18px shrink-0 animate-spin text-hsl-foreground-72 motion-reduce:animate-none"
      aria-hidden="true"
    />
  );
}
