import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * 纯文本标签气泡（Base UI）：composer 运行时控件与上下文用量环共用同一视觉。
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
    <Tooltip
      open={props.open}
      onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined}
    >
      <TooltipTrigger
        delay={0}
        closeOnClick={props.closeOnClick ?? true}
        render={<span className="inline-flex shrink-0">{props.children}</span>}
      />
      <TooltipContent className="label-tooltip-popup rounded-xl px-3 py-2">
        {props.label}
      </TooltipContent>
    </Tooltip>
  );
}
