import { Meter, Tooltip } from "@base-ui/react";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ReactNode } from "react";
import {
  canManualCompact,
  contextUsageLevel,
  contextUsageRatio,
} from "../../lib/chat/contextUsage";
import { ConfirmActionPopover } from "../ui/confirm-action-popover";

const RING_STROKE_BY_LEVEL = {
  ok: "stroke-emerald-500 dark:stroke-emerald-400",
  warn: "stroke-amber-500 dark:stroke-amber-400",
  danger: "stroke-red-500 dark:stroke-red-400",
} as const;

// 与 ChatComposerBar 的 RuntimeControlTooltip 同款视觉；组件自带 tooltip
// 以保持自包含（该封装未导出，且 label 依赖内部计算的用量数字）。
function UsageTooltip(props: { label: string; children: ReactNode }) {
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

/**
 * 上下文用量环：composer 内展示当前会话上下文占用百分比，占用 ≥ 50%（黄档）
 * 起可点击弹出确认后触发手动压缩。数据口径见 lib/chat/contextUsage.ts。
 * 语义用 Meter（静态量度）而非 Progress（任务进度）。
 */
export function ContextUsageRing(props: {
  totalTokens?: number;
  contextWindow?: number;
  disabled?: boolean;
  onConfirm?: (() => void) | (() => Promise<unknown>);
  className?: string;
}) {
  const { totalTokens, contextWindow, disabled, onConfirm, className } = props;
  const { t, locale } = useLocale();
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }

  const ratio = contextUsageRatio(totalTokens, contextWindow);
  const percentage = Math.round(ratio * 100);
  const displayedPercentage = Math.min(999, percentage);
  const ringPercentage = Math.min(100, Math.max(0, ratio * 100));
  const formatTokens = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const usageLabel = `${displayedPercentage}% · ${t("chat.usageTotal")} ${formatTokens.format(
    Math.max(0, Math.floor(totalTokens ?? 0)),
  )} · ${t("chat.contextWindow")} ${formatTokens.format(contextWindow)}`;
  const compactAvailable = canManualCompact(ratio) && !disabled && Boolean(onConfirm);

  const ring = (
    <Meter.Root
      value={Math.min(100, percentage)}
      aria-valuetext={usageLabel}
      className="relative flex h-8 w-8 items-center justify-center text-[8px] font-semibold leading-none tabular-nums text-foreground/75"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="absolute inset-0 h-8 w-8 -rotate-90">
        <circle
          cx="12"
          cy="12"
          r="9.5"
          fill="none"
          strokeWidth="2.25"
          className="stroke-foreground/10 dark:stroke-white/10"
        />
        <circle
          cx="12"
          cy="12"
          r="9.5"
          fill="none"
          pathLength="100"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeDasharray="100"
          strokeDashoffset={100 - ringPercentage}
          className={cn(
            "transition-[stroke-dashoffset,stroke] duration-300",
            RING_STROKE_BY_LEVEL[contextUsageLevel(ratio)],
          )}
        />
      </svg>
      <span className="relative">{displayedPercentage}%</span>
    </Meter.Root>
  );

  if (!compactAvailable) {
    return (
      <UsageTooltip label={usageLabel}>
        <span className={cn("inline-flex h-8 w-8 shrink-0 cursor-default opacity-90", className)}>
          {ring}
        </span>
      </UsageTooltip>
    );
  }

  return (
    <UsageTooltip label={usageLabel}>
      <ConfirmActionPopover
        title={t("chat.manualCompactTitle")}
        description={t("chat.manualCompactDescription")}
        confirmLabel={t("chat.manualCompactConfirm")}
        tone="default"
        side="top"
        onConfirm={() => void onConfirm?.()}
      >
        {(open) => (
          <button
            type="button"
            onClick={open}
            aria-label={t("chat.manualCompactTitle")}
            className={cn(
              "inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full outline-hidden transition-[background-color,opacity] hover:bg-muted/60 focus-visible:bg-muted/60",
              className,
            )}
          >
            {ring}
          </button>
        )}
      </ConfirmActionPopover>
    </UsageTooltip>
  );
}
