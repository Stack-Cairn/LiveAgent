import { ChartColumn, RefreshCw } from "@liveagent/ui/components/IconSet";
import { SettingsSection } from "@liveagent/ui/components/settings/SettingsLayout";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import { Button } from "@liveagent/ui/components/ui/button";
import { EmptyState } from "@liveagent/ui/components/ui/empty-state";
import { useLocale } from "@liveagent/ui/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/shared/utils";
import {
  browserTimeZone,
  hasUsage,
  parseUsageStats,
  todayIn,
  USAGE_STATS_DAYS,
  type UsageStats,
} from "../../lib/usage/usageStats";
import type { KBrainSettingsAdapter } from "./kbrainSettingsAdapter";
import { UsageHeatmap } from "./usage/UsageHeatmap";
import { UsageMetricCards } from "./usage/UsageMetricCards";
import { UsageModelChart } from "./usage/UsageModelChart";
import { UsageTrendChart } from "./usage/UsageTrendChart";
import { fill, USAGE_PALETTE_CLASS } from "./usage/usageUi";

type LoadState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "ready"; stats: UsageStats; today: string };

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function formatUpdated(value: string, locale: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? ""
    : time.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Settings → 用量统计: K-brain's token usage across all sessions. Read-only; loads
 * when the page opens and on Refresh. A K-brain without `capabilities.usage_stats`
 * gets an update notice instead of an error.
 */
export function UsageStatsSection({ kbrain }: { kbrain: KBrainSettingsAdapter }) {
  const { t, locale } = useLocale();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const epoch = useRef(0);

  const load = useCallback(async () => {
    const getUsageStats = kbrain.getUsageStats;
    if (!getUsageStats) return;
    const ticket = ++epoch.current;
    setRefreshing(true);
    const timezone = browserTimeZone();
    try {
      const answer = await getUsageStats({ days: USAGE_STATS_DAYS, timezone });
      if (ticket !== epoch.current) return;
      if (!answer.available) {
        setState({ kind: "unavailable" });
        return;
      }
      const stats = parseUsageStats(answer.stats);
      setState({ kind: "ready", stats, today: todayIn(stats.timezone || timezone) });
    } catch (reason) {
      if (ticket !== epoch.current) return;
      setState({ kind: "error", message: messageOf(reason) });
    } finally {
      if (ticket === epoch.current) setRefreshing(false);
    }
  }, [kbrain]);

  useEffect(() => {
    void load();
    return () => {
      ++epoch.current;
    };
  }, [load]);

  const refreshButton = (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => void load()}
      disabled={refreshing}
      data-testid="usage-refresh"
    >
      <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
      {refreshing ? t("settings.usage.refreshing") : t("settings.usage.refresh")}
    </Button>
  );

  const updated =
    state.kind === "ready" && state.stats.generatedAt
      ? formatUpdated(state.stats.generatedAt, locale)
      : "";

  return (
    <SettingsSection
      data-settings-anchor="usage-stats"
      data-testid="usage-stats-settings"
      title={t("settings.usage.title")}
      description={
        updated
          ? `${t("settings.usage.description")} ${fill(t("settings.usage.updatedAt"), { time: updated })}`
          : t("settings.usage.description")
      }
      actions={refreshButton}
      className={USAGE_PALETTE_CLASS}
    >
      {state.kind === "loading" ? (
        <div
          role="status"
          className="flex items-center justify-center gap-2 rounded-xl bg-settings-tile py-10 text-xs text-muted-foreground"
        >
          <RefreshCw className="size-3.5 animate-spin" />
          {t("settings.usage.loading")}
        </div>
      ) : state.kind === "unavailable" ? (
        <SettingsNotice variant="warning" role="status" data-testid="usage-unavailable">
          {t("settings.usage.unavailable")}
        </SettingsNotice>
      ) : state.kind === "error" ? (
        <SettingsNotice variant="action-error" role="alert" data-testid="usage-error">
          <span className="min-w-0 flex-1 break-words">
            {fill(t("settings.usage.loadFailed"), { error: state.message })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0"
            onClick={() => void load()}
            disabled={refreshing}
          >
            {t("settings.usage.retry")}
          </Button>
        </SettingsNotice>
      ) : !hasUsage(state.stats) ? (
        <EmptyState variant="settings" data-testid="usage-empty">
          <ChartColumn className="size-8 text-muted-foreground/50" />
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-foreground">{t("settings.usage.empty")}</p>
            <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
              {t("settings.usage.emptyHint")}
            </p>
          </div>
        </EmptyState>
      ) : (
        <div className="space-y-3" data-testid="usage-content">
          <UsageMetricCards stats={state.stats} />
          <UsageHeatmap daily={state.stats.daily} today={state.today} />
          <UsageTrendChart stats={state.stats} today={state.today} />
          <UsageModelChart stats={state.stats} />
        </div>
      )}
    </SettingsSection>
  );
}
