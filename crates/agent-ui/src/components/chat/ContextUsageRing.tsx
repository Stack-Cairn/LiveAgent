import { Meter } from "@base-ui/react";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useMemo, useState } from "react";
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
 * 起可点击弹出确认后触发手动压缩。阈值与 WebUI 补算口径见 lib/chat/contextUsage.ts。
 * 语义用 Meter（静态量度）而非 Progress（任务进度）。
 *
 * 触屏（无 hover）环境没有悬停，tooltip 与压缩确认改为点按分段：首次点按只弹
 * 用量 tooltip，≥50% 时第二次点按收起 tooltip 再弹压缩确认——两个弹层同侧
 * 定位，必须互斥展示。桌面端保持悬停出 tooltip、点击出确认的原行为。
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
  const isCoarsePointer = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none), (pointer: coarse)").matches,
    [],
  );
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }

  const ratio = contextUsageRatio(totalTokens, contextWindow);
  // 只保留两个口径：展示值（取整、封顶 999）与画环/量度值（0-100 钳制，
  // 二者共用避免 a11y 量度与弧线漂移）。contextUsageRatio 不会返回负数。
  const displayedPercentage = Math.min(999, Math.round(ratio * 100));
  const clampedPercentage = Math.min(100, ratio * 100);
  const formatTokens = getTokenFormatter(locale);
  const usageLine = `${displayedPercentage}% · ${t("chat.usageTotal")} ${formatTokens.format(
    Math.max(0, Math.floor(totalTokens ?? 0)),
  )}`;
  const windowLine = `${t("chat.contextWindow")} ${formatTokens.format(contextWindow)}`;
  // a11y 量度/无障碍标签仍是单行字符串；tooltip 视觉上分两行（百分比+总计 /
  // 上下文窗口），窄屏不再挤成一长条折行。
  const usageLabel = `${usageLine} · ${windowLine}`;
  const usageTooltip = (
    <span className="flex flex-col gap-0.5">
      <span>{usageLine}</span>
      <span className="text-muted-foreground">{windowLine}</span>
    </span>
  );
  const compactAvailable = canManualCompact(ratio) && !disabled && Boolean(onConfirm);

  const handleTooltipOpenChange = (nextOpen: boolean) => {
    // 确认弹层展示期间抑制 tooltip 的打开请求（悬停/点按），保证不重叠。
    if (nextOpen && confirmOpen) return;
    setTooltipOpen(nextOpen);
  };

  const handleConfirmOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setConfirmOpen(false);
      return;
    }
    // 触屏端首次点按只弹用量 tooltip；tooltip 已可见的第二次点按才进入确认。
    if (isCoarsePointer && !tooltipOpen) {
      setTooltipOpen(true);
      return;
    }
    setTooltipOpen(false);
    setConfirmOpen(true);
  };

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

  // 触屏端一律禁用 closeOnClick：trigger 按压关闭发生在 pointerdown，早于
  // click 阶段的开合裁决——保留会让第二次点按先关掉 tooltip，裁决误判为
  // "首次点按"而永远进不了确认弹层（span 分支同理会点按即关又即开）。
  if (!compactAvailable) {
    return (
      <LabelTooltip
        label={usageTooltip}
        open={tooltipOpen}
        onOpenChange={handleTooltipOpenChange}
        closeOnClick={!isCoarsePointer}
      >
        {isCoarsePointer ? (
          <button
            type="button"
            aria-label={usageLabel}
            onClick={() => handleTooltipOpenChange(!tooltipOpen)}
            className={cn("inline-flex h-8 w-8 shrink-0 opacity-90 outline-hidden", className)}
          >
            {ring}
          </button>
        ) : (
          <span className={cn("inline-flex h-8 w-8 shrink-0 cursor-default opacity-90", className)}>
            {ring}
          </span>
        )}
      </LabelTooltip>
    );
  }

  return (
    <LabelTooltip
      label={usageTooltip}
      open={tooltipOpen}
      onOpenChange={handleTooltipOpenChange}
      closeOnClick={!isCoarsePointer}
    >
      <ConfirmActionPopover
        title={t("chat.manualCompactTitle")}
        description={t("chat.manualCompactDescription")}
        confirmLabel={t("chat.manualCompactConfirm")}
        tone="default"
        side="top"
        open={confirmOpen}
        onOpenChange={handleConfirmOpenChange}
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
