import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ComponentProps } from "react";

export const statusPanelSurfaceClass =
  "relative overflow-hidden border border-[rgba(var(--status-cyan),0.16)] bg-[linear-gradient(135deg,var(--ui-color-rgba-255-255-255-0p09),var(--ui-color-rgba-255-255-255-0p026)),var(--status-panel)] shadow-[0_var(--spacing-24px)_var(--spacing-70px)_var(--ui-color-rgba-0-0-0-0p32),inset_0_var(--spacing-1px)_0_var(--ui-color-hsl-0-0-100-0p08),inset_0_0_var(--spacing-56px)_rgba(var(--status-cyan),0.035)] backdrop-blur-22px before:pointer-events-none before:absolute before:inset-0 before:bg-[linear-gradient(125deg,var(--ui-color-rgba-255-255-255-0p13),transparent_30%,rgba(var(--status-cyan),0.045)),linear-gradient(90deg,transparent,rgba(var(--status-cyan),0.1),transparent)] before:opacity-(--ui-opacity-0p72) before:content-[''] after:pointer-events-none after:absolute after:top-0 after:inset-x-18px after:h-1px after:bg-[linear-gradient(90deg,transparent,rgba(var(--status-cyan),0.62),transparent)] after:shadow-[0_0_var(--spacing-18px)_rgba(var(--status-cyan),0.48)] after:content-[''] [&>*]:relative [&>*]:z-1";

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
