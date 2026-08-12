import { Tooltip } from "@base-ui/react";
import type { ReactNode } from "react";

/**
 * 纯文本标签气泡（Base UI）：composer 运行时控件与上下文用量环共用同一视觉。
 * z-index 必须挂在 Positioner 上（Popup 上无效，见弹层拓扑约定）。
 * 默认非受控（悬停展示）；触屏点按驱动的调用方（上下文用量环）传入
 * open/onOpenChange 受控，并禁用 closeOnClick——trigger 按压关闭发生在
 * pointerdown，早于调用方 click 阶段的开合裁决，保留会让二段点按判据失效。
 */
export function LabelTooltip(props: {
  label: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  closeOnClick?: boolean;
  children: ReactNode;
}) {
  const { onOpenChange } = props;
  return (
    <Tooltip.Root
      open={props.open}
      onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined}
    >
      <Tooltip.Trigger
        delay={0}
        closeOnClick={props.closeOnClick ?? true}
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
          <Tooltip.Popup className="label-tooltip-popup max-w-64 rounded-xl border border-border/60 bg-popover px-3 py-2 text-xs font-medium leading-4 text-popover-foreground shadow-lg outline-hidden">
            {props.label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
