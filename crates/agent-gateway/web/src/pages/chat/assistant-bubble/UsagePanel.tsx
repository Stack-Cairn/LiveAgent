import { useLocale } from "../../../i18n";
import type { Usage } from "../../../lib/agentTypes";

function hasDisplayableUsage(usage: Usage | undefined): usage is Usage {
  if (!usage) return false;

  return (
    usage.totalTokens > 0 ||
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0
  );
}

function formatUsageNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(value);
}

export function UsagePanel(props: { usage?: Usage; contextWindow?: number }) {
  const { usage, contextWindow } = props;
  const { t, locale } = useLocale();

  if (!hasDisplayableUsage(usage)) return null;

  const stats: Array<{ key: string; label: string; value: string }> = [
    ...(typeof contextWindow === "number" && contextWindow > 0
      ? [
          {
            key: "context-window",
            label: t("chat.contextWindow"),
            value: formatUsageNumber(contextWindow, locale),
          },
        ]
      : []),
    {
      key: "total",
      label: t("chat.usageTotal"),
      value: formatUsageNumber(usage.totalTokens, locale),
    },
    {
      key: "input",
      label: t("chat.usageInput"),
      value: formatUsageNumber(usage.input, locale),
    },
    {
      key: "output",
      label: t("chat.usageOutput"),
      value: formatUsageNumber(usage.output, locale),
    },
    ...(usage.cacheRead > 0
      ? [
          {
            key: "cache-read",
            label: t("chat.usageCacheRead"),
            value: formatUsageNumber(usage.cacheRead, locale),
          },
        ]
      : []),
    ...(usage.cacheWrite > 0
      ? [
          {
            key: "cache-write",
            label: t("chat.usageCacheWrite"),
            value: formatUsageNumber(usage.cacheWrite, locale),
          },
        ]
      : []),
  ];

  return (
    <div className="overflow-x-auto pt-0.5 text-[calc(12px*var(--zone-font-scale,1))] leading-5 whitespace-nowrap text-muted-foreground/80">
      {stats.map((item, index) => (
        <span key={item.key}>
          {index > 0 ? <span className="px-1.5 text-muted-foreground/45">·</span> : null}
          <span>{item.label}</span>
          <span className="ml-1 font-medium text-foreground/85">{item.value}</span>
        </span>
      ))}
    </div>
  );
}
