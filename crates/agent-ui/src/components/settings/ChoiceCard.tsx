import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";

/** Preserve native button behavior; selection and its colors belong to the caller. */
export function ChoiceCard({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      {...props}
      className={cn(
        "group relative flex items-start gap-3 rounded-xl border-2 p-4",
        "text-left transition-all",
        className,
      )}
    />
  );
}
