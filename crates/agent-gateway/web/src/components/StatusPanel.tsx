import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ComponentProps } from "react";

export const statusPanelSurfaceClass =
  "relative overflow-hidden border border-border bg-[linear-gradient(135deg,color-mix(in_oklab,_var(--color-white)_9%,_transparent),color-mix(in_oklab,_var(--color-white)_2.6%,_transparent)),hsl(var(--card)/0.72)] shadow-[0_var(--spacing-24px)_var(--spacing-70px)_color-mix(in_oklab,_var(--color-black)_32%,_transparent),inset_0_var(--spacing-1px)_0_color-mix(in_oklab,_var(--color-white)_8%,_transparent),inset_0_0_var(--spacing-56px)_rgba(var(--status-cyan),0.035)] backdrop-blur-22px before:pointer-events-none before:absolute before:inset-0 before:bg-[linear-gradient(125deg,color-mix(in_oklab,_var(--color-white)_13%,_transparent),transparent_30%,rgba(var(--status-cyan),0.045)),linear-gradient(90deg,transparent,rgba(var(--status-cyan),0.1),transparent)] before:opacity-(--ui-opacity-0p72) before:content-[''] after:pointer-events-none after:absolute after:top-0 after:inset-x-18px after:h-1px after:bg-[linear-gradient(90deg,transparent,rgba(var(--status-cyan),0.62),transparent)] after:shadow-[0_0_var(--spacing-18px)_rgba(var(--status-cyan),0.48)] after:content-[''] [&>*]:relative [&>*]:z-1";

export function StatusPanel({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      {...props}
      className={cn(
        statusPanelSurfaceClass,
        "flex min-h-0 flex-col rounded-22px p-14px status-compact:p-10px",
        className,
      )}
    />
  );
}
