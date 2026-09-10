import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";

export function StepMarker({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "flex size-6 items-center justify-center rounded-md bg-primary/10 text-11px font-bold text-primary",
        className,
      )}
    />
  );
}
