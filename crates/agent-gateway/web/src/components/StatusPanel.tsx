import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ComponentProps } from "react";

export const statusPanelSurfaceClass =
  "relative overflow-hidden border border-border bg-[linear-gradient(135deg,color-mix(in_oklab,_var(--color-white)_9%,_transparent),color-mix(in_oklab,_var(--color-white)_2.6%,_transparent)),hsl(var(--card)/0.72)] shadow-status-board-panel backdrop-blur-22px before:pointer-events-none before:absolute before:inset-0 before:bg-[linear-gradient(125deg,color-mix(in_oklab,_var(--color-white)_13%,_transparent),transparent_30%,rgba(var(--status-cyan),0.045)),linear-gradient(90deg,transparent,rgba(var(--status-cyan),0.1),transparent)] before:opacity-(--ui-opacity-0p72) before:content-[''] after:pointer-events-none after:absolute after:top-0 after:inset-x-18px after:h-1px after:bg-[linear-gradient(90deg,transparent,rgba(var(--status-cyan),0.62),transparent)] after:shadow-status-board-panel-line after:content-[''] [&>*]:relative [&>*]:z-1";

export function StatusPanel({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      {...props}
      className={cn(
        statusPanelSurfaceClass,
        "flex min-h-0 flex-col rounded-3xl p-14px status-compact:p-10px",
        className,
      )}
    />
  );
}
