import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";

const loadingSurfaceVariants = cva(
  "relative overflow-hidden rounded-14px border after:pointer-events-none after:absolute after:inset-0 after:content-[''] motion-reduce:after:animate-none!",
  {
    variants: {
      variant: {
        hero: "border-hsl-border-55 bg-hub-frost-hero backdrop-blur-24px backdrop-saturate-180 shadow-hub-frost-hero after:w-1/2 after:bg-hub-frost-hero-after after:animate-hub-frost-hero-after dark:border-hsl-0-0-100-0p08 dark:bg-hub-frost-hero-dark dark:shadow-hub-frost-hero-dark dark:after:bg-hub-frost-hero-after-dark",
        skeleton:
          "border-hsl-border-35 bg-hsl-background-50 backdrop-blur-18px backdrop-saturate-170 after:bg-hub-frost-skeleton-after after:bg-size-[200%_100%] after:animate-hub-frost-skeleton-after",
      },
    },
    defaultVariants: { variant: "skeleton" },
  },
);

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
        "relative h-2px w-full overflow-hidden rounded-9999px bg-hsl-muted-foreground-10 before:absolute before:inset-y-0 before:left-0 before:w-[38%] before:rounded-[inherit] before:bg-hub-frost-track-before before:animate-hub-frost-track-before before:content-[''] motion-reduce:before:animate-none!",
        className,
      )}
    />
  );
}

const SPINNER_SEGMENTS = [
  "[transform:rotate(0deg)] [animation-delay:var(--ui-duration-minus-917ms)]",
  "[transform:rotate(30deg)] [animation-delay:var(--ui-duration-minus-833ms)]",
  "[transform:rotate(60deg)] [animation-delay:var(--ui-duration-minus-750ms)]",
  "[transform:rotate(90deg)] [animation-delay:var(--ui-duration-minus-667ms)]",
  "[transform:rotate(120deg)] [animation-delay:var(--ui-duration-minus-583ms)]",
  "[transform:rotate(150deg)] [animation-delay:var(--ui-duration-minus-500ms)]",
  "[transform:rotate(180deg)] [animation-delay:var(--ui-duration-minus-417ms)]",
  "[transform:rotate(210deg)] [animation-delay:var(--ui-duration-minus-333ms)]",
  "[transform:rotate(240deg)] [animation-delay:var(--ui-duration-minus-250ms)]",
  "[transform:rotate(270deg)] [animation-delay:var(--ui-duration-minus-167ms)]",
  "[transform:rotate(300deg)] [animation-delay:var(--ui-duration-minus-83ms)]",
  "[transform:rotate(330deg)] [animation-delay:0ms]",
] as const;

export function FrostSpinner() {
  return (
    <span className="relative size-18px shrink-0 text-hsl-foreground-72" aria-hidden="true">
      {SPINNER_SEGMENTS.map((segment) => (
        <i
          key={segment}
          className={cn(
            "absolute top-0 left-1/2 h-5px w-1p6px -ml-0p8px rounded-1px bg-current origin-[var(--spacing-0p8px)_var(--spacing-9px)] animate-hub-frost-spinner-segment opacity-0 motion-reduce:animate-none! motion-reduce:opacity-40",
            segment,
          )}
        />
      ))}
    </span>
  );
}
