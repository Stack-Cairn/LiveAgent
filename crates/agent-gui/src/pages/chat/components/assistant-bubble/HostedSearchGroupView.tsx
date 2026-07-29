import { useMemo, useState } from "react";

import { ChevronRight, Globe } from "../../../../components/icons";
import { useLocale } from "../../../../i18n";
import type { HostedSearchBlock } from "../../../../lib/chat/messages/hostedSearch";
import { cn } from "../../../../lib/shared/utils";
import { LazyCollapse } from "./LazyCollapse";
import { AssistantStatus } from "./StatusText";

function getHostedSearchStatusLabel(
  t: (key: string) => string,
  status: HostedSearchBlock["status"],
) {
  switch (status) {
    case "failed":
      return t("chat.search.failed");
    case "completed":
      return t("chat.search.completed");
    default:
      return t("chat.search.searching");
  }
}

function getSourceHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getHostedSearchGroupStatus(items: HostedSearchBlock[]): HostedSearchBlock["status"] {
  if (items.some((item) => item.status === "searching")) return "searching";
  if (items.every((item) => item.status === "failed")) return "failed";
  return "completed";
}

function getUniqueHostedSearchQueries(items: HostedSearchBlock[]) {
  const out: string[] = [];
  for (const item of items) {
    for (const query of item.queries) {
      const text = query.trim();
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

function getUniqueHostedSearchSources(items: HostedSearchBlock[]) {
  const out = new Map<string, HostedSearchBlock["sources"][number]>();
  for (const item of items) {
    for (const source of item.sources) {
      if (!source.url || out.has(source.url)) continue;
      out.set(source.url, source);
    }
  }
  return [...out.values()];
}

function getLatestHostedSearchTitle(
  items: HostedSearchBlock[],
  t: (key: string) => string,
  status: HostedSearchBlock["status"],
) {
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    for (let queryIndex = item.queries.length - 1; queryIndex >= 0; queryIndex -= 1) {
      const query = item.queries[queryIndex]?.trim();
      if (query) return query;
    }
    const latestSource = item.sources[item.sources.length - 1];
    if (latestSource?.title) return latestSource.title;
    if (latestSource?.url) return getSourceHost(latestSource.url);
  }
  if (status !== "searching") return getHostedSearchStatusLabel(t, status);
  return t("chat.search.noQuery");
}

function getHostedSearchCountLabel(count: number, t: (key: string) => string) {
  return count <= 1 ? t("chat.search.oneSearch") : `${count} ${t("chat.search.searches")}`;
}

export function HostedSearchGroupView({
  items,
  isLive = false,
}: {
  items: HostedSearchBlock[];
  isLive?: boolean;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const queries = useMemo(() => getUniqueHostedSearchQueries(items), [items]);
  const sources = useMemo(() => getUniqueHostedSearchSources(items), [items]);
  const visibleSources = sources.slice(0, 10);
  const status = getHostedSearchGroupStatus(items);
  const statusLabel = getHostedSearchStatusLabel(t, status);
  const latestTitle = getLatestHostedSearchTitle(items, t, status);
  const hasDetails = queries.length > 0 || visibleSources.length > 0;

  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.search.collapseActivity") : t("chat.search.expandActivity")}
        className="group/search flex w-full cursor-pointer select-none items-center justify-between gap-3 py-1.5 text-left"
        onClick={() => setOpen((prev) => !prev)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover/search:text-foreground/75" />
          <div
            key={latestTitle}
            className="min-w-0 truncate text-[calc(11px*var(--zone-font-scale,1))] leading-5 text-muted-foreground/55"
            title={latestTitle}
          >
            <span className="font-sans text-[calc(13px*var(--zone-font-scale,1))] text-muted-foreground/80 group-hover/search:text-foreground">
              {t("chat.search.webSearch")}
            </span>
            <span className="ml-2">{getHostedSearchCountLabel(items.length, t)}</span>
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
              open ? "rotate-90" : "",
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

              {visibleSources.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="text-[calc(11px*var(--zone-font-scale,1))] font-medium uppercase tracking-normal text-muted-foreground/70">
                    {t("chat.search.sources")}
                  </div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {visibleSources.map((source) => {
                      const label = source.title || getSourceHost(source.url);
                      return (
                        <a
                          key={source.url}
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="block min-w-0 max-w-full py-0.5 text-[calc(12px*var(--zone-font-scale,1))] hover:text-foreground"
                          title={source.url}
                        >
                          <span className="block truncate font-medium text-foreground/85">
                            {label}
                          </span>
                          <span className="block truncate text-muted-foreground">
                            {getSourceHost(source.url)}
                          </span>
                        </a>
                      );
                    })}
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
