import "@liveagent/ui/i18n/namespaces/usageStats";
import { useLocale } from "@liveagent/ui/i18n";
import { useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/shared/utils";
import {
  buildHeatmap,
  formatDay,
  formatInteger,
  formatMonth,
  HEATMAP_LEVELS,
  HEATMAP_WEEKS,
  type HeatmapMode,
  type UsageDay,
  type UsageLocale,
} from "../../../lib/usage/usageStats";
import {
  anchorFor,
  ChartCard,
  ChartTooltip,
  CompactAmount,
  Digits,
  fill,
  heatColor,
  PillTabs,
  Template,
  type TooltipAnchor,
} from "./usageUi";

const COLUMNS = { gridTemplateColumns: `repeat(${HEATMAP_WEEKS}, minmax(0, 1fr))` };
/** Weekday labels on alternate rows (Sunday first), like a wall calendar. */
const WEEKDAY_ROWS = [
  "settings.usage.weekdaySun",
  "",
  "settings.usage.weekdayTue",
  "",
  "settings.usage.weekdayThu",
  "",
  "settings.usage.weekdaySat",
];

type Hover = { column: number; row: number; anchor: TooltipAnchor };

/**
 * Last 52 weeks, one column per week and Sunday on the first row. Weekly and
 * cumulative views color each column by its week's (running) total and highlight
 * the whole column on hover.
 */
export function UsageHeatmap({ daily, today }: { daily: readonly UsageDay[]; today: string }) {
  const { t, locale } = useLocale();
  const usageLocale = locale as UsageLocale;
  const [mode, setMode] = useState<HeatmapMode>("daily");
  const [hover, setHover] = useState<Hover | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const heatmap = useMemo(() => buildHeatmap(daily, today, mode), [daily, today, mode]);
  const byColumn = mode !== "daily";

  const hoveredWeek = hover ? heatmap.weeks[hover.column] : undefined;
  const hoveredCell = hover ? hoveredWeek?.cells[hover.row] : undefined;

  function point(column: number, row: number, element: Element) {
    const cell = heatmap.weeks[column]?.cells[row];
    if (!cell || cell.future) {
      setHover(null);
      return;
    }
    // The tooltip follows the pointer's cell even when the whole column is highlighted,
    // so it never lands past the grid's edge.
    const anchor = anchorFor(element, frameRef.current);
    setHover(anchor ? { column, row, anchor } : null);
  }

  let heading = "";
  let total = 0;
  let turns = 0;
  if (hoveredWeek && hoveredCell) {
    if (mode === "daily") {
      heading = formatDay(hoveredCell.date, usageLocale, true);
      total = hoveredCell.total;
      turns = hoveredCell.turns;
    } else if (mode === "weekly") {
      heading = fill(t("settings.usage.weekRange"), {
        start: formatDay(hoveredWeek.start, usageLocale, true),
        end: formatDay(hoveredWeek.end, usageLocale),
      });
      total = hoveredWeek.total;
      turns = hoveredWeek.turns;
    } else {
      heading = fill(t("settings.usage.cumulativeThrough"), {
        date: formatDay(hoveredWeek.end, usageLocale, true),
      });
      total = hoveredWeek.cumulativeTotal;
      turns = hoveredWeek.cumulativeTurns;
    }
  }

  return (
    <ChartCard
      data-testid="usage-heatmap"
      title={t("settings.usage.heatmapTitle")}
      description={t("settings.usage.heatmapDescription")}
      actions={
        <PillTabs
          label={t("settings.usage.heatmapTitle")}
          value={mode}
          onChange={(next) => {
            setMode(next);
            setHover(null);
          }}
          options={[
            { value: "daily", label: t("settings.usage.heatmapDaily") },
            { value: "weekly", label: t("settings.usage.heatmapWeekly") },
            { value: "cumulative", label: t("settings.usage.heatmapCumulative") },
          ]}
        />
      }
    >
      <div ref={frameRef} className="relative">
        <div className="flex min-w-0 gap-1.5">
          {/* Out of flow so the labels never make the column taller than the cells. */}
          <div className="relative w-6 shrink-0 text-tiny leading-none text-muted-foreground">
            <div className="absolute inset-x-0 bottom-0 top-4 grid grid-rows-7 gap-3px">
              {WEEKDAY_ROWS.map((key, row) => (
                <span key={key || row} className="flex items-center justify-end pr-0.5">
                  {key ? t(key) : ""}
                </span>
              ))}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="grid h-4 text-tiny leading-none text-muted-foreground" style={COLUMNS}>
              {heatmap.monthLabels.map((label) => (
                <span
                  key={`${label.year}-${label.month}`}
                  className="truncate"
                  style={{ gridColumn: `${label.column + 1} / span ${label.span}` }}
                >
                  {formatMonth(label.month, usageLocale)}
                </span>
              ))}
            </div>
            <div
              className="grid gap-3px"
              style={COLUMNS}
              onMouseLeave={() => setHover(null)}
              aria-hidden="true"
            >
              {heatmap.weeks.map((week, column) => (
                <div
                  key={week.start}
                  className={cn(
                    "grid grid-rows-7 gap-3px rounded-xs",
                    byColumn &&
                      hover?.column === column &&
                      "outline outline-1 outline-offset-1 outline-foreground/50",
                  )}
                >
                  {week.cells.map((cell, row) => (
                    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only detail
                    <div
                      key={cell.date}
                      onMouseEnter={(event) => point(column, row, event.currentTarget)}
                      className={cn(
                        "aspect-square w-full rounded-xs",
                        cell.future ? "bg-transparent" : cell.level === 0 && "bg-foreground/[0.07]",
                        !byColumn &&
                          hover?.column === column &&
                          hover.row === row &&
                          "outline outline-1 outline-offset-1 outline-foreground/60",
                      )}
                      style={{ backgroundColor: cell.future ? undefined : heatColor(cell.level) }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-2.5 flex items-center justify-end gap-1.5 text-tiny text-muted-foreground">
          <span>{t("settings.usage.heatmapLess")}</span>
          {Array.from({ length: HEATMAP_LEVELS + 1 }, (_, level) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed legend steps
              key={level}
              className={cn("size-2.5 rounded-xs", level === 0 && "bg-foreground/[0.07]")}
              style={{ backgroundColor: heatColor(level) }}
            />
          ))}
          <span>{t("settings.usage.heatmapMore")}</span>
        </div>
        <ChartTooltip anchor={hover?.anchor ?? null}>
          <div className="font-medium text-foreground">{heading}</div>
          <div className="text-muted-foreground">
            <CompactAmount
              value={total}
              locale={usageLocale}
              suffix="tokens"
              className="text-foreground"
            />
            {" · "}
            <Template
              template={t("settings.usage.turns")}
              values={{ count: <Digits>{formatInteger(turns, usageLocale)}</Digits> }}
            />
          </div>
        </ChartTooltip>
      </div>
    </ChartCard>
  );
}
