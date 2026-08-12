import { Meter } from "@base-ui/react";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  canManualCompact,
  contextUsageLevel,
  contextUsageRatio,
} from "../../lib/chat/contextUsage";
import { ConfirmActionPopover } from "../ui/confirm-action-popover";
import { LabelTooltip } from "../ui/label-tooltip";

const RING_STROKE_BY_LEVEL = {
  ok: "stroke-emerald-500 dark:stroke-emerald-400",
  warn: "stroke-amber-500 dark:stroke-amber-400",
  danger: "stroke-red-500 dark:stroke-red-400",
} as const;

// Intl.NumberFormat 构造含 locale 数据解析，环随流式读数逐帧重渲染，
// 必须按 locale 复用实例。
const tokenFormatterByLocale = new Map<string, Intl.NumberFormat>();

function getTokenFormatter(locale: string): Intl.NumberFormat {
  const cached = tokenFormatterByLocale.get(locale);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  tokenFormatterByLocale.set(locale, formatter);
  return formatter;
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
  // 只保留两个口径：展示值（取整、封顶 999）与画环/量度值（0-100 钳制，
  // 二者共用避免 a11y 量度与弧线漂移）。contextUsageRatio 不会返回负数。
  const displayedPercentage = Math.min(999, Math.round(ratio * 100));
  const clampedPercentage = Math.min(100, ratio * 100);
  const formatTokens = getTokenFormatter(locale);
  const usageLabel = `${displayedPercentage}% · ${t("chat.usageTotal")} ${formatTokens.format(
    Math.max(0, Math.floor(totalTokens ?? 0)),
  )} · ${t("chat.contextWindow")} ${formatTokens.format(contextWindow)}`;
  const compactAvailable = canManualCompact(ratio) && !disabled && Boolean(onConfirm);

  const ring = (
    <Meter.Root
      value={clampedPercentage}
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
          strokeDashoffset={100 - clampedPercentage}
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
      <LabelTooltip label={usageLabel}>
        <span className={cn("inline-flex h-8 w-8 shrink-0 cursor-default opacity-90", className)}>
          {ring}
        </span>
      </LabelTooltip>
    );
  }

  return (
    <LabelTooltip label={usageLabel}>
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
    </LabelTooltip>
  );
}
