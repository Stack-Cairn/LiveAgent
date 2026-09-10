import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ComponentProps } from "react";

/** Dashboard panel layout; decorative layers stay in status-board.css. */
export function StatusPanel({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      {...props}
      className={cn(
        "status-board-card flex min-h-0 flex-col p-14px status-compact:p-10px relative overflow-hidden rounded-22px",
        className,
      )}
    />
  );
}
