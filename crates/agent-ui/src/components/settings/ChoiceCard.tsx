import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";

const selectedClasses = {
  command: "border-blue-500/50 bg-blue-500/5",
  http: "border-emerald-500/50 bg-emerald-500/5",
  prompt: "border-violet-500/50 bg-violet-500/5",
} as const;

/** Selection is presentational; native button behavior stays with the caller. */
export function ChoiceCard({
  className,
  selected,
  kind,
  ...props
}: ComponentProps<"button"> & {
  selected?: boolean;
  kind?: keyof typeof selectedClasses;
}) {
  return (
    <button
      {...props}
      className={cn(
        "group relative flex items-start gap-3 rounded-xl border-2 p-4",
        "text-left transition-all",
        kind &&
          (selected
            ? selectedClasses[kind]
            : "border-border/60 bg-background hover:border-border hover:bg-muted/20"),
        className,
      )}
    />
  );
}
