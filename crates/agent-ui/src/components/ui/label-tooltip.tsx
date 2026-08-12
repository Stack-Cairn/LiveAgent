import { Tooltip } from "@base-ui/react";
import type { ReactNode } from "react";

/**
 * 纯文本标签气泡（Base UI）：composer 运行时控件与上下文用量环共用同一视觉。
 * z-index 必须挂在 Positioner 上（Popup 上无效，见弹层拓扑约定）。
 */
export function LabelTooltip(props: { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={0}
        closeOnClick
        render={<span className="inline-flex shrink-0">{props.children}</span>}
      />
      <Tooltip.Portal>
        <Tooltip.Positioner
          side="top"
          align="center"
          sideOffset={6}
          collisionPadding={8}
          className="z-[9999]"
        >
          <Tooltip.Popup className="max-w-64 rounded-xl border border-border/60 bg-popover px-3 py-2 text-xs font-medium leading-4 text-popover-foreground shadow-lg outline-hidden data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95">
            {props.label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
