import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";
import { Label } from "../ui/label";

/** Layout only: callers retain labels, control IDs, validation and field state. */
export function FormField({
  density = "default",
  className,
  ...props
}: ComponentProps<"div"> & { density?: "default" | "compact" }) {
  return (
    <div
      {...props}
      className={cn(density === "compact" ? "space-y-1.5" : "space-y-2", className)}
    />
  );
}

export function FormFieldLabel({
  size = "default",
  className,
  ...props
}: ComponentProps<typeof Label> & { size?: "default" | "compact" }) {
  return (
    <Label
      {...props}
      className={cn(size === "compact" && "text-xs", "text-muted-foreground", className)}
    />
  );
}

export function FormFieldDescription({ className, ...props }: ComponentProps<"p">) {
  return <p {...props} className={cn("text-xs leading-5 text-muted-foreground", className)} />;
}
