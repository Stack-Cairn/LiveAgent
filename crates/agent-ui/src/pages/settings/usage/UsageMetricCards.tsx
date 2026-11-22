import {
  CalendarDays,
  Cpu,
  Flame,
  MessageSquare,
  Sigma,
  Timer,
  Wallet,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { cn } from "../../../lib/shared/utils";
import {
  formatCompact,
  formatCostUSD,
  formatInteger,
  type UsageLocale,
  type UsageStats,
} from "../../../lib/usage/usageStats";
import { CompactAmount, Digits, Template } from "./usageUi";

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  testId,
  className,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  testId: string;
  className?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn("min-w-0 rounded-xl bg-settings-tile px-3.5 py-3", className)}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 min-w-0 truncate text-xl font-semibold leading-7 tracking-tight text-foreground">
        {value}
      </div>
      {detail ? (
        <div className="mt-0.5 min-w-0 truncate text-2xs leading-4 text-muted-foreground">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

/** The headline numbers; cost only when K-brain could price the usage. */
export function UsageMetricCards({ stats }: { stats: UsageStats }) {
  const { t, locale } = useLocale();
  const usageLocale = locale as UsageLocale;
  const { totals, summary } = stats;
  const smallDays = (count: number) =>
    // "{count} 天" with the number in the large value style but the unit small.
    t("settings.usage.days")
      .split(/(\{count\})/)
      .map((part) =>
        part === "{count}" ? (
          <Digits key="count">{formatInteger(count, usageLocale)}</Digits>
        ) : part.trim() ? (
          <span key={part} className="ml-0.5 text-sm font-normal text-muted-foreground">
            {part.trim()}
          </span>
        ) : null,
      );

  const priced = totals.costUSD !== null;
  return (
    // Two columns when narrow. Wide: six cards fill 3 + 3; with cost, seven cards fill
    // 4 + 4 because the total spans two columns. No row is left half empty.
    <div className="@container" data-testid="usage-metrics">
      <div
        className={cn(
          "grid grid-cols-2 gap-2.5",
          priced ? "@[40rem]:grid-cols-4" : "@[36rem]:grid-cols-3",
        )}
      >
        <MetricCard
          className={cn(priced ? "col-span-2" : "col-span-2 @[36rem]:col-span-1")}
          testId="usage-metric-total"
          icon={Sigma}
          label={t("settings.usage.metricTotal")}
          value={<CompactAmount value={totals.total} locale={usageLocale} />}
          detail={
            <Template
              template={t("settings.usage.metricTotalDetail")}
              values={{
                input: <Digits>{formatCompact(totals.input, usageLocale)}</Digits>,
                output: <Digits>{formatCompact(totals.output, usageLocale)}</Digits>,
              }}
            />
          }
        />
        <MetricCard
          testId="usage-metric-sessions"
          icon={MessageSquare}
          label={t("settings.usage.metricSessions")}
          value={<Digits>{formatInteger(totals.sessions, usageLocale)}</Digits>}
          detail={
            <Template
              template={t("settings.usage.metricSessionsDetail")}
              values={{ turns: <Digits>{formatInteger(totals.turns, usageLocale)}</Digits> }}
            />
          }
        />
        <MetricCard
          testId="usage-metric-active-days"
          icon={CalendarDays}
          label={t("settings.usage.metricActiveDays")}
          value={smallDays(summary.activeDays)}
          detail={
            <Template
              template={t("settings.usage.metricActiveDaysDetail")}
              values={{
                days: <Digits>{formatInteger(summary.longestStreak, usageLocale)}</Digits>,
              }}
            />
          }
        />
        <MetricCard
          testId="usage-metric-top-model"
          icon={Cpu}
          label={t("settings.usage.metricTopModel")}
          value={
            summary.topModel ? (
              <span className="font-mono text-base" title={summary.topModel}>
                {summary.topModel}
              </span>
            ) : (
              <span className="text-base text-muted-foreground">{t("settings.usage.none")}</span>
            )
          }
          detail={(() => {
            const entries = stats.models.filter((model) => model.model === summary.topModel);
            return entries.length > 0 ? (
              <CompactAmount
                value={entries.reduce((sum, model) => sum + model.total, 0)}
                locale={usageLocale}
                suffix="tokens"
              />
            ) : undefined;
          })()}
        />
        <MetricCard
          testId="usage-metric-longest-session"
          icon={Timer}
          label={t("settings.usage.metricLongestSession")}
          value={
            summary.longestSession ? (
              <CompactAmount
                value={summary.longestSession.total}
                locale={usageLocale}
                suffix="tokens"
                suffixClassName="text-sm font-normal"
              />
            ) : (
              <span className="text-base text-muted-foreground">{t("settings.usage.none")}</span>
            )
          }
          detail={
            summary.longestSession ? (
              <span title={summary.longestSession.title || summary.longestSession.id}>
                {summary.longestSession.title || t("settings.usage.untitledSession")}
              </span>
            ) : undefined
          }
        />
        <MetricCard
          testId="usage-metric-streak"
          icon={Flame}
          label={t("settings.usage.metricStreak")}
          value={smallDays(summary.currentStreak)}
        />
        {priced ? (
          <MetricCard
            testId="usage-metric-cost"
            icon={Wallet}
            label={t("settings.usage.metricCost")}
            value={<Digits>{formatCostUSD(totals.costUSD ?? 0, usageLocale)}</Digits>}
            detail={t("settings.usage.metricCostDetail")}
          />
        ) : null}
      </div>
    </div>
  );
}
