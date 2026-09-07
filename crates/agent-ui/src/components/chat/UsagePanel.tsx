import { useLocale } from "../../i18n/index";
import { formatTokenCount } from "../../lib/chat/formatTokenCount";
import { cn } from "../../lib/shared/utils";
import { Info } from "../IconSet";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../ui/popover";

export type UsagePanelUsage = {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageDetailEntry = {
  key: string;
  usage: UsagePanelUsage;
};

function hasDisplayableUsage(usage: UsagePanelUsage | undefined): usage is UsagePanelUsage {
  if (!usage) return false;
  return (
    usage.totalTokens > 0 ||
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0
  );
}

function buildUsageStats(
  usage: UsagePanelUsage | undefined,
  contextWindow: number | undefined,
  locale: string,
  t: ReturnType<typeof useLocale>["t"],
) {
  return [
    ...(typeof contextWindow === "number" && contextWindow > 0
      ? [
          {
            key: "context-window",
            label: t("chat.contextWindow"),
            value: formatTokenCount(contextWindow, locale),
          },
        ]
      : []),
    ...(hasDisplayableUsage(usage)
      ? [
          {
            key: "total",
            label: t("chat.usageTotal"),
            value: formatTokenCount(usage.totalTokens, locale),
          },
          {
            key: "input",
            label: t("chat.usageInput"),
            value: formatTokenCount(usage.input, locale),
          },
          {
            key: "output",
            label: t("chat.usageOutput"),
            value: formatTokenCount(usage.output, locale),
          },
          ...(usage.cacheRead > 0
            ? [
                {
                  key: "cache-read",
                  label: t("chat.usageCacheRead"),
                  value: formatTokenCount(usage.cacheRead, locale),
                },
              ]
            : []),
          ...(usage.cacheWrite > 0
            ? [
                {
                  key: "cache-write",
                  label: t("chat.usageCacheWrite"),
                  value: formatTokenCount(usage.cacheWrite, locale),
                },
              ]
            : []),
        ]
      : []),
  ];
}

export function UsagePanel(props: {
  usage?: UsagePanelUsage;
  contextWindow?: number;
  className?: string;
}) {
  const { usage, contextWindow, className } = props;
  const { t, locale } = useLocale();
  const stats = buildUsageStats(usage, contextWindow, locale, t);
  if (stats.length === 0) return null;

  return (
    <dl
      data-chat-usage-details
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5 text-[calc(12px*var(--zone-font-scale,1))] leading-5",
        className,
      )}
    >
      {stats.map((item) => (
        <div key={item.key} className="contents">
          <dt className="min-w-0 text-muted-foreground">{item.label}</dt>
          <dd className="text-right font-medium tabular-nums text-foreground/90">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function UsageInfoPopover(props: {
  entries?: readonly UsageDetailEntry[];
  contextWindow?: number;
  className?: string;
}) {
  const { entries, contextWindow, className } = props;
  const { t } = useLocale();
  const displayableEntries = entries?.filter((entry) => hasDisplayableUsage(entry.usage)) ?? [];
  const hasContextWindow = typeof contextWindow === "number" && contextWindow > 0;
  if (displayableEntries.length === 0 && !hasContextWindow) {
    return null;
  }

  const label = t("chat.usage");
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "chat-assistant-action inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
              className,
            )}
            title={label}
            aria-label={label}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        }
      />
      <PopoverContent side="top" align="start" sideOffset={6} className="w-60 p-3">
        <PopoverTitle className="text-xs">{label}</PopoverTitle>
        <div className="mt-2 max-h-72 space-y-2.5 overflow-y-auto">
          {displayableEntries.length > 0 ? (
            displayableEntries.map((entry, index) => (
              <div key={entry.key} className={cn(index > 0 && "border-t border-border/55 pt-2.5")}>
                {displayableEntries.length > 1 ? (
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground/75">
                    {label} {index + 1}
                  </div>
                ) : null}
                <UsagePanel
                  usage={entry.usage}
                  contextWindow={index === 0 ? contextWindow : undefined}
                />
              </div>
            ))
          ) : (
            <UsagePanel contextWindow={contextWindow} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
