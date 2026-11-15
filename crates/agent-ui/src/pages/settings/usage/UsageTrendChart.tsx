import { useLocale } from "@liveagent/ui/i18n";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  buildTrend,
  formatCompact,
  formatDay,
  type TrendRange,
  type UsageLocale,
  type UsageStats,
} from "../../../lib/usage/usageStats";
import {
  ChartCard,
  ChartTooltip,
  CompactAmount,
  PillTabs,
  Swatch,
  seriesColor,
  type TooltipAnchor,
} from "./usageUi";

const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 24, left: 48 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Tokens per day for the range's top models, one line each, gap-filled so a day
 * without usage is a 0 point. The Y axis tops out at the largest single point among
 * the shown lines.
 */
export function UsageTrendChart({ stats, today }: { stats: UsageStats; today: string }) {
  const { t, locale } = useLocale();
  const usageLocale = locale as UsageLocale;
  const [range, setRange] = useState<TrendRange>(30);
  const [hover, setHover] = useState<number | null>(null);
  const [frameRef, width] = useWidth<HTMLDivElement>();
  const trend = useMemo(() => buildTrend(stats, today, range), [stats, today, range]);
  const count = trend.days.length;
  const plotWidth = Math.max(width - PAD.left - PAD.right, 1);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number) =>
    PAD.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number) => PAD.top + plotHeight - (value / trend.yMax) * plotHeight;
  const ticks = [trend.yMax, trend.yMax / 2, 0];
  // As many evenly spaced dates as fit (about one per 72px), always the last one; a
  // date too close to the last is skipped so the two never collide.
  const fitting = Math.max(2, Math.floor(plotWidth / 72));
  const labelEvery = Math.max(1, Math.ceil((count - 1) / (fitting - 1)));
  const labelIndexes = new Set<number>([count - 1]);
  for (let index = 0; index < count - 1; index += labelEvery) {
    if (count - 1 - index >= labelEvery * 0.8) labelIndexes.add(index);
  }
  const empty = trend.series.length === 0;

  function pointer(event: PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / Math.max(box.width, 1);
    setHover(Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1)))));
  }

  const hoveredDay = hover === null ? undefined : trend.days[hover];
  const anchor: TooltipAnchor | null =
    hover === null || !hoveredDay
      ? null
      : { left: x(hover), top: PAD.top, bottom: HEIGHT - PAD.bottom };
  const hoveredLines =
    hover === null
      ? []
      : trend.series
          .map((line) => ({ ...line, value: line.values[hover] ?? 0 }))
          .sort((a, b) => b.value - a.value);

  return (
    <ChartCard
      data-testid="usage-trend"
      title={t("settings.usage.trendTitle")}
      description={t("settings.usage.trendDescription")}
      actions={
        <PillTabs
          label={t("settings.usage.trendTitle")}
          value={range}
          onChange={(next) => {
            setRange(next);
            setHover(null);
          }}
          options={[
            { value: 7, label: t("settings.usage.trend7") },
            { value: 30, label: t("settings.usage.trend30") },
          ]}
        />
      }
    >
      {!empty ? (
        <ul className="mb-2 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {trend.series.map((line) => (
            <li key={line.model} className="flex min-w-0 items-center gap-1.5">
              <Swatch color={seriesColor(line.colorIndex)} />
              <span className="truncate font-mono text-foreground">{line.model}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div ref={frameRef} className="relative" style={{ height: HEIGHT }}>
        {empty ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t("settings.usage.trendEmpty")}
          </div>
        ) : width > 0 ? (
          <svg
            width={width}
            height={HEIGHT}
            className="block overflow-visible"
            role="img"
            aria-label={t("settings.usage.trendTitle")}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  className="stroke-foreground/10"
                  strokeDasharray={tick === 0 ? undefined : "3 4"}
                />
                <text
                  x={PAD.left - 8}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground font-mono text-[10px]"
                >
                  {formatCompact(tick, usageLocale)}
                </text>
              </g>
            ))}
            {trend.days.map((day, index) =>
              labelIndexes.has(index) ? (
                <text
                  key={day.date}
                  x={x(index)}
                  y={HEIGHT - 6}
                  textAnchor={index === count - 1 ? "end" : index === 0 ? "start" : "middle"}
                  className="fill-muted-foreground text-[10px]"
                >
                  {formatDay(day.date, usageLocale)}
                </text>
              ) : null,
            )}
            {hover !== null ? (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={HEIGHT - PAD.bottom}
                className="stroke-foreground/25"
              />
            ) : null}
            {[...trend.series].reverse().map((line) => (
              <polyline
                key={line.model}
                fill="none"
                stroke={seriesColor(line.colorIndex)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={line.values.map((value, index) => `${x(index)},${y(value)}`).join(" ")}
              />
            ))}
            {hover !== null
              ? trend.series.map((line) => (
                  <circle
                    key={line.model}
                    cx={x(hover)}
                    cy={y(line.values[hover] ?? 0)}
                    r={4}
                    fill={seriesColor(line.colorIndex)}
                    className="stroke-settings-tile"
                    strokeWidth={2}
                  />
                ))
              : null}
            <rect
              x={PAD.left}
              y={PAD.top}
              width={plotWidth}
              height={plotHeight}
              fill="transparent"
              onPointerMove={pointer}
              onPointerDown={pointer}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        ) : null}
        <ChartTooltip anchor={anchor} placement="side">
          {hoveredDay ? (
            <>
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-medium text-foreground">
                  {formatDay(hoveredDay.date, usageLocale, true)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4 text-muted-foreground">
                <span>{t("settings.usage.trendTotal")}</span>
                <CompactAmount
                  value={hoveredDay.total}
                  locale={usageLocale}
                  suffix="tokens"
                  className="text-foreground"
                />
              </div>
              {hoveredLines.map((line) => (
                <div key={line.model} className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Swatch color={seriesColor(line.colorIndex)} />
                    <span className="truncate font-mono">{line.model}</span>
                  </span>
                  <CompactAmount value={line.value} locale={usageLocale} suffix="tokens" />
                </div>
              ))}
            </>
          ) : null}
        </ChartTooltip>
      </div>
    </ChartCard>
  );
}
