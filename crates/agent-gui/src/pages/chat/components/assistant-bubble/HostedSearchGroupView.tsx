import { useMemo, useState } from "react";

import { ChevronRight, Search } from "../../../../components/icons";
import { useLocale } from "../../../../i18n";
import type { HostedSearchBlock } from "../../../../lib/chat/messages/hostedSearch";
import { cn } from "../../../../lib/shared/utils";

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

export function HostedSearchGroupView({ items }: { items: HostedSearchBlock[] }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const queries = useMemo(() => getUniqueHostedSearchQueries(items), [items]);
  const sources = useMemo(() => getUniqueHostedSearchSources(items), [items]);
  const visibleSources = sources.slice(0, 10);
  const status = getHostedSearchGroupStatus(items);
  const statusLabel = getHostedSearchStatusLabel(t, status);
  const latestTitle = getLatestHostedSearchTitle(items, t, status);
  const isSearching = status === "searching";
  const hasDetails = queries.length > 0 || visibleSources.length > 0;
  const statusBgClass =
    status === "failed"
      ? "bg-[hsl(var(--chat-error)/0.1)] text-[hsl(var(--chat-error))]"
      : status === "searching"
        ? "bg-[hsl(var(--chat-running)/0.1)] text-[hsl(var(--chat-running))]"
        : "bg-[hsl(var(--chat-success)/0.1)] text-[hsl(var(--chat-success))]";
  const dotClass =
    status === "failed"
      ? "bg-[hsl(var(--chat-error))]"
      : status === "searching"
        ? "bg-[hsl(var(--chat-running))] animate-pulse"
        : "bg-[hsl(var(--chat-success))]";

  return (
    <div className="tool-card-enter min-w-0 max-w-full overflow-hidden rounded-[12px] border border-black/[0.06] bg-white/[0.72] shadow-[0_0_0_0.5px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.02)] backdrop-blur-xl backdrop-saturate-[1.8] transition-shadow duration-200 hover:shadow-[0_0_0_0.5px_rgba(0,0,0,0.04),0_1px_3px_rgba(0,0,0,0.05),0_4px_14px_rgba(0,0,0,0.04)] dark:border-white/[0.1] dark:bg-white/[0.06] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.2),0_3px_8px_rgba(0,0,0,0.12)] dark:backdrop-saturate-[1.4] dark:hover:shadow-[0_0_0_0.5px_rgba(255,255,255,0.06),0_1px_3px_rgba(0,0,0,0.25),0_4px_14px_rgba(0,0,0,0.18)]">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.search.collapseActivity") : t("chat.search.expandActivity")}
        className="grid w-full cursor-pointer select-none grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 px-2.5 py-2 text-left transition-colors hover:bg-black/[0.018] active:bg-black/[0.035] dark:hover:bg-white/[0.025] dark:active:bg-white/[0.045] sm:items-center"
        onClick={() => setOpen((prev) => !prev)}
      >
        <div
          className="relative mt-0.5 flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[7px] sm:mt-0"
          style={{
            background:
              "linear-gradient(135deg, hsl(var(--tool-search-accent) / 0.13), hsl(var(--tool-search-accent) / 0.06))",
          }}
        >
          {isSearching ? (
            <span className="absolute inset-0 animate-ping rounded-[7px] bg-[hsl(var(--tool-search-accent)/0.16)]" />
          ) : null}
          <Search className="relative h-3.5 w-3.5 text-[hsl(var(--tool-search-accent))]" />
        </div>

        <div className="min-w-0 space-y-0.5 sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-2 sm:space-y-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="inline-flex h-5 shrink-0 items-center text-[calc(12.5px*var(--zone-font-scale,1))] font-semibold leading-none text-foreground/90">
              {t("chat.search.webSearch")}
            </span>
            <span className="inline-flex h-5 max-w-[5.75rem] shrink-0 items-center truncate rounded-full bg-black/[0.04] px-1.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-semibold leading-none text-muted-foreground/70 dark:bg-white/[0.06]">
              {getHostedSearchCountLabel(items.length, t)}
            </span>
          </div>
          <span
            key={latestTitle}
            className={cn(
              "block h-4 min-w-0 truncate text-[calc(11px*var(--zone-font-scale,1))] leading-4 text-muted-foreground/60 transition-opacity duration-200 sm:inline-flex sm:h-5 sm:items-center sm:leading-none",
              isSearching ? "animate-pulse" : "",
            )}
            title={latestTitle}
          >
            {latestTitle}
          </span>
        </div>

        <div className="flex h-5 min-w-0 shrink-0 items-center gap-1.5 justify-self-end">
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotClass)} />
          <span
            className={cn(
              "inline-flex h-5 max-w-[5.5rem] items-center truncate rounded-full px-1.5 text-[calc(10px*var(--zone-font-scale,1))] font-semibold leading-none",
              statusBgClass,
            )}
          >
            {statusLabel}
          </span>
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground/35 transition-transform duration-200 ease-out",
              open ? "rotate-90" : "",
            )}
          />
        </div>
      </button>

      {open && hasDetails ? (
        <div className="tool-trace-group-body space-y-2 border-t border-black/[0.04] px-2.5 py-2.5 dark:border-white/[0.05]">
          {queries.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {queries.map((query) => (
                <span
                  key={query}
                  className="tool-arg-pill min-w-0 max-w-full truncate rounded-[6px] border border-border/35 bg-background/65 px-2 py-1 text-[calc(12px*var(--zone-font-scale,1))] text-foreground/85"
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
                      className="block min-w-0 max-w-full rounded-[6px] border border-transparent px-2 py-1 text-[calc(12px*var(--zone-font-scale,1))] transition-colors hover:border-border/45 hover:bg-background/60"
                      title={source.url}
                    >
                      <span className="block truncate font-medium text-foreground/85">{label}</span>
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
      ) : null}
    </div>
  );
}
