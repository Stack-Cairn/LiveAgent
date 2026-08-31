import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState, useSyncExternalStore } from "react";
import {
  CONTEXT_USAGE_WARN_RATIO,
  canManualCompact,
  contextUsageLevel,
  contextUsageRatio,
} from "../../lib/chat/contextUsage";
import { ConfirmActionPopover } from "../ui/confirm-action-popover";
import { LabelTooltip } from "../ui/label-tooltip";
import { Meter } from "../ui/meter";

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

const COARSE_POINTER_QUERY = "(hover: none), (pointer: coarse)";

// 触屏形态可热切换（iPad 插拔键鼠、可翻转本翻转），订阅 matchMedia change
// 而非挂载时一次性求值，交互模式（两段点按 vs 悬停）随设备形态实时切换。
function subscribeCoarsePointer(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(COARSE_POINTER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isCoarsePointerNow(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(COARSE_POINTER_QUERY).matches
  );
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
  /**
   * 占用低于警戒线（50%，即手动压缩尚不可用）时整枚环不渲染。展示样式改为
   * 三档后 composer 仍不传此项——"ring" / "both" 模式环都必须 0% 起常显
   * （docs/design/composer-context-stats-bar.md §4.7）。保留为共享环的通用显示
   * 选项，供未来低占用需让位的挂载点使用。
   */
  hideBelowWarn?: boolean;
}) {
  const { totalTokens, contextWindow, disabled, onConfirm, className, hideBelowWarn } = props;
  const { t, locale } = useLocale();
  const isCoarsePointer = useSyncExternalStore(
    subscribeCoarsePointer,
    isCoarsePointerNow,
    () => false,
  );
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ratio = contextUsageRatio(totalTokens, contextWindow);
  const compactAvailable = canManualCompact(ratio) && !disabled && Boolean(onConfirm);
  // 确认弹层只在可压缩分支渲染，而可压缩状态可能在弹层打开期间翻回 false
  //（他端开始压缩/发消息使 disabled 置位、他端压缩完成后占用掉回阈值下）。
  // 此时弹层随分支切换直接卸载，confirmOpen 若残留 true：恢复可压缩后弹层
  // 会无操作自动弹开，残留期间还会经 tooltip 互斥守卫一直吞掉 tooltip 的
  // 打开请求。渲染期归位（adjust-state-during-render）在绘制前完成，不闪现。
  if (!compactAvailable && confirmOpen) {
    setConfirmOpen(false);
  }
  // 低占用隐藏：环整枚不渲染，但组件仍挂载着 tooltipOpen。残留 true 会让占用
  // 回到警戒线以上时 tooltip 无悬停自动弹开——与上面 confirmOpen 同一类问题，
  // 同样在渲染期归位。
  const hiddenByLowUsage = hideBelowWarn === true && ratio < CONTEXT_USAGE_WARN_RATIO;
  if (hiddenByLowUsage && tooltipOpen) {
    setTooltipOpen(false);
  }
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  if (hiddenByLowUsage) return null;

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
    <Meter
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
    </Meter>
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
