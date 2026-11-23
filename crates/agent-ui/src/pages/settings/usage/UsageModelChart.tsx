import "@liveagent/ui/i18n/namespaces/usageStats";
import { useLocale } from "@liveagent/ui/i18n";
import { useMemo, useState } from "react";
import { cn } from "../../../lib/shared/utils";
import {
  buildModelSlices,
  formatInteger,
  type ModelSlice,
  type UsageLocale,
  type UsageStats,
} from "../../../lib/usage/usageStats";
import { ChartCard, CompactAmount, Digits, fill, Swatch, seriesColor } from "./usageUi";

const SIZE = 168;
const OUTER = (SIZE / 2) * 0.86;
const INNER = (SIZE / 2) * 0.56;
const CENTER = SIZE / 2;

function polar(radius: number, angle: number): [number, number] {
  return [CENTER + radius * Math.sin(angle), CENTER - radius * Math.cos(angle)];
}

/** A ring segment from `start` to `end` (radians, clockwise from 12 o'clock). */
function arcPath(start: number, end: number): string {
  const sweep = end - start;
  if (sweep >= Math.PI * 2 - 1e-6) {
    // A full ring: two half arcs (one arc cannot start and end on the same point).
    return [arcPath(0, Math.PI), arcPath(Math.PI, Math.PI * 2)].join(" ");
  }
  const large = sweep > Math.PI ? 1 : 0;
  const [x1, y1] = polar(OUTER, start);
  const [x2, y2] = polar(OUTER, end);
  const [x3, y3] = polar(INNER, end);
  const [x4, y4] = polar(INNER, start);
  return [
    `M ${x1} ${y1}`,
    `A ${OUTER} ${OUTER} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${INNER} ${INNER} 0 ${large} 0 ${x4} ${y4}`,
    "Z",
  ].join(" ");
}

function formatShare(share: number, locale: UsageLocale): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: share < 0.1 ? 1 : 0,
  }).format(share);
}

/**
 * Token share per model: a donut with the total in its center and the list beside
 * it on wide layouts (stacked when narrow). More than six models fold into the top
 * five plus "other models".
 */
export function UsageModelChart({ stats }: { stats: UsageStats }) {
  const { t, locale } = useLocale();
  const usageLocale = locale as UsageLocale;
  const slices = useMemo(() => buildModelSlices(stats), [stats]);
  const [active, setActive] = useState<string | null>(null);
  const total = slices.reduce((sum, slice) => sum + slice.total, 0);
  const focused = slices.find((slice) => slice.key === active) ?? null;
  const label = (slice: ModelSlice) => slice.model ?? t("settings.usage.otherModels");

  let angle = 0;
  const arcs = slices.map((slice) => {
    const start = angle;
    angle += slice.share * Math.PI * 2;
    return { slice, start, end: angle };
  });

  return (
    <ChartCard
      data-testid="usage-models"
      title={t("settings.usage.modelsTitle")}
      description={t("settings.usage.modelsDescription")}
    >
      <div className="@container">
        <div className="flex flex-col items-center gap-5 @[34rem]:flex-row @[34rem]:items-center @[34rem]:gap-8">
          <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
            <svg
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              role="img"
              aria-label={t("settings.usage.modelsTitle")}
            >
              {arcs.map(({ slice, start, end }) => (
                // biome-ignore lint/a11y/noStaticElementInteractions: hover mirrors the list rows
                <path
                  key={slice.key}
                  d={arcPath(start, end)}
                  fill={seriesColor(slice.colorIndex)}
                  className={cn(
                    "stroke-settings-tile transition-opacity",
                    active && active !== slice.key && "opacity-35",
                  )}
                  strokeWidth={slices.length > 1 ? 2 : 0}
                  strokeLinejoin="round"
                  onMouseEnter={() => setActive(slice.key)}
                  onMouseLeave={() => setActive(null)}
                />
              ))}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
              <span className="max-w-full truncate text-2xs text-muted-foreground">
                {focused ? label(focused) : t("settings.usage.chartTotal")}
              </span>
              <CompactAmount
                value={focused ? focused.total : total}
                locale={usageLocale}
                className="text-lg font-semibold leading-6 text-foreground"
              />
              <span className="text-2xs text-muted-foreground">tokens</span>
            </div>
          </div>
          <table className="w-full min-w-0 table-fixed border-separate border-spacing-0 text-xs">
            <thead className="sr-only">
              <tr>
                <th scope="col">{t("settings.usage.tableModel")}</th>
                <th scope="col">{t("settings.usage.tableShare")}</th>
                <th scope="col">{t("settings.usage.tableTokens")}</th>
              </tr>
            </thead>
            <tbody>
              {slices.map((slice) => (
                <tr
                  key={slice.key}
                  onMouseEnter={() => setActive(slice.key)}
                  onMouseLeave={() => setActive(null)}
                  className={cn(
                    "transition-colors [&>td]:py-1.5 [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg",
                    active === slice.key && "[&>td]:bg-foreground/[0.05]",
                  )}
                >
                  <td className="pl-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Swatch color={seriesColor(slice.colorIndex)} />
                      <div className="min-w-0">
                        <div
                          className={cn(
                            "truncate text-foreground",
                            slice.model ? "font-mono" : "font-sans",
                          )}
                          title={label(slice)}
                        >
                          {label(slice)}
                        </div>
                        {slice.model === null ? (
                          <div className="truncate text-2xs text-muted-foreground">
                            {fill(t("settings.usage.otherModelsCount"), {
                              count: formatInteger(slice.merged, usageLocale),
                            })}
                          </div>
                        ) : slice.provider ? (
                          <div className="truncate text-2xs text-muted-foreground">
                            {slice.provider}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="w-16 text-right text-muted-foreground">
                    <Digits>{formatShare(slice.share, usageLocale)}</Digits>
                  </td>
                  <td className="w-24 pr-2 text-right text-foreground">
                    <CompactAmount value={slice.total} locale={usageLocale} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </ChartCard>
  );
}
