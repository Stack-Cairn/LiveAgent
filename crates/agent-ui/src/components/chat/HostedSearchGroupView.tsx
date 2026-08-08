import { ChevronRight, Globe } from "@liveagent/app/components/icons";
import { useMemo, useState } from "react";
import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import { AssistantStatus } from "./AssistantStatus";
import { LazyCollapse } from "./LazyCollapse";

export type HostedSearchBlockView = {
  status: "searching" | "completed" | "failed";
  queries: string[];
  sources: Array<{ url: string; title?: string }>;
};

function getStatusLabel(t: (key: string) => string, status: HostedSearchBlockView["status"]) {
  if (status === "failed") return t("chat.search.failed");
  if (status === "completed") return t("chat.search.completed");
  return t("chat.search.searching");
}

function getSourceHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getGroupStatus(items: HostedSearchBlockView[]): HostedSearchBlockView["status"] {
  if (items.some((item) => item.status === "searching")) return "searching";
  if (items.every((item) => item.status === "failed")) return "failed";
  return "completed";
}

function getUniqueQueries(items: HostedSearchBlockView[]) {
  const queries: string[] = [];
  for (const item of items) {
    for (const query of item.queries) {
      const text = query.trim();
      if (text && !queries.includes(text)) queries.push(text);
    }
  }
  return queries;
}

function getUniqueSources(items: HostedSearchBlockView[]) {
  const sources = new Map<string, HostedSearchBlockView["sources"][number]>();
  for (const item of items) {
    for (const source of item.sources) {
      if (source.url && !sources.has(source.url)) sources.set(source.url, source);
    }
  }
  return [...sources.values()];
}

function getLatestTitle(
  items: HostedSearchBlockView[],
  t: (key: string) => string,
  status: HostedSearchBlockView["status"],
) {
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    for (let queryIndex = item.queries.length - 1; queryIndex >= 0; queryIndex -= 1) {
      const query = item.queries[queryIndex]?.trim();
      if (query) return query;
    }
    const source = item.sources[item.sources.length - 1];
    if (source?.title) return source.title;
    if (source?.url) return getSourceHost(source.url);
  }
  return status === "searching" ? t("chat.search.noQuery") : getStatusLabel(t, status);
}

export function HostedSearchGroupView({
  items,
  isLive = false,
  readOnly = false,
}: {
  items: HostedSearchBlockView[];
  isLive?: boolean;
  readOnly?: boolean;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const queries = useMemo(() => getUniqueQueries(items), [items]);
  const sources = useMemo(() => getUniqueSources(items).slice(0, 10), [items]);
  const status = getGroupStatus(items);
  const statusLabel = getStatusLabel(t, status);
  const latestTitle = getLatestTitle(items, t, status);
  const hasDetails = queries.length > 0 || sources.length > 0;

  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.search.collapseActivity") : t("chat.search.expandActivity")}
        className={cn(
          "group/search flex w-full select-none items-center justify-between gap-3 py-1.5 text-left",
          !readOnly && "cursor-pointer",
        )}
        onClick={() => setOpen((previous) => !previous)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover/search:text-foreground/75" />
          <div
            className="min-w-0 truncate text-[calc(11px*var(--zone-font-scale,1))] leading-5 text-muted-foreground/55"
            title={latestTitle}
          >
            <span className="font-sans text-[calc(13px*var(--zone-font-scale,1))] text-muted-foreground/80 group-hover/search:text-foreground">
              {t("chat.search.webSearch")}
            </span>
            <span className="ml-2">
              {items.length <= 1
                ? t("chat.search.oneSearch")
                : `${items.length} ${t("chat.search.searches")}`}
            </span>
            <span className="ml-2">{latestTitle}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status === "searching" ? (
            <AssistantStatus
              className="min-h-0 gap-1.5 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground/60"
              iconClassName="h-3 w-3"
            >
              {statusLabel}
            </AssistantStatus>
          ) : (
            <span className="text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground/60">
              {statusLabel}
            </span>
          )}
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out",
              open && "rotate-90",
            )}
          />
        </div>
      </button>
      {hasDetails ? (
        <LazyCollapse open={open} retainWhileClosed={isLive && status === "searching"}>
          {() => (
            <div className="space-y-2 pb-2 pt-1.5">
              {queries.length > 0 ? (
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {queries.map((query) => (
                    <span
                      key={query}
                      className="min-w-0 max-w-full truncate text-[calc(12px*var(--zone-font-scale,1))] leading-5 text-muted-foreground/75"
                      title={query}
                    >
                      {query}
                    </span>
                  ))}
                </div>
              ) : null}
              {sources.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="text-[calc(11px*var(--zone-font-scale,1))] font-medium uppercase tracking-normal text-muted-foreground/70">
                    {t("chat.search.sources")}
                  </div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {sources.map((source) => (
                      <a
                        key={source.url}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block min-w-0 max-w-full py-0.5 text-[calc(12px*var(--zone-font-scale,1))] hover:text-foreground"
                        title={source.url}
                      >
                        <span className="block truncate font-medium text-foreground/85">
                          {source.title || getSourceHost(source.url)}
                        </span>
                        <span className="block truncate text-muted-foreground">
                          {getSourceHost(source.url)}
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </LazyCollapse>
      ) : null}
    </div>
  );
}
