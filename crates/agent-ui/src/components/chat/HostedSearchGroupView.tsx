import { ChevronDown, Globe, Link2, Search } from "@liveagent/ui/components/IconSet";
import { useMemo, useState } from "react";
import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";

export type HostedSearchBlockView = {
  status: "searching" | "completed" | "failed";
  queries: string[];
  sources: Array<{ url: string; title?: string }>;
};

const COLLAPSED_SOURCE_COUNT = 5;

function getGroupStatus(items: HostedSearchBlockView[]): HostedSearchBlockView["status"] {
  if (items.some((item) => item.status === "searching")) return "searching";
  if (items.every((item) => item.status === "failed")) return "failed";
  return "completed";
}

function safeWebUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function getSourceHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getUniqueQueries(items: HostedSearchBlockView[]) {
  const queries = new Set<string>();
  for (const item of items) {
    for (const query of item.queries) {
      const text = query.trim();
      if (text) queries.add(text);
    }
  }
  return [...queries];
}

function getUniqueSources(items: HostedSearchBlockView[]) {
  const sources = new Map<string, HostedSearchBlockView["sources"][number]>();
  for (const item of items) {
    for (const source of item.sources) {
      const url = safeWebUrl(source.url);
      if (url && !sources.has(url)) sources.set(url, { ...source, url });
    }
  }
  return [...sources.values()];
}

function faviconUrls(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    const remoteFallback = `https://a.favicon.im/${encodeURIComponent(url.hostname)}?larger=true`;
    return url.protocol === "https:"
      ? [`${url.origin}/favicon.ico`, remoteFallback]
      : [remoteFallback];
  } catch {
    return [];
  }
}

function SourceFavicon({ url }: { url: string }) {
  const candidates = useMemo(() => faviconUrls(url), [url]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const candidate = candidates[candidateIndex];

  if (!candidate) {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Link2 className="h-2.5 w-2.5" />
      </span>
    );
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 rounded-xs bg-muted object-contain"
      decoding="async"
      loading="lazy"
      onError={() => setCandidateIndex((current) => current + 1)}
      referrerPolicy="no-referrer"
      src={candidate}
    />
  );
}

function completedLabel(locale: "zh-CN" | "en-US", searchCount: number, sourceCount: number) {
  if (locale === "en-US") {
    if (searchCount === 0) {
      return sourceCount > 0 ? `Search complete · ${sourceCount} sources` : "Search complete";
    }
    return `Searched ${searchCount} ${searchCount === 1 ? "time" : "times"}${sourceCount > 0 ? ` · ${sourceCount} sources` : ""}`;
  }
  if (searchCount === 0) {
    return sourceCount > 0 ? `联网搜索完成 · ${sourceCount} 个来源` : "联网搜索完成";
  }
  return `已搜索 ${searchCount} 次${sourceCount > 0 ? ` · ${sourceCount} 个来源` : ""}`;
}

export function HostedSearchGroupView({
  items,
  isLive = false,
}: {
  items: HostedSearchBlockView[];
  isLive?: boolean;
  readOnly?: boolean;
}) {
  const { locale, t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const queries = useMemo(() => getUniqueQueries(items), [items]);
  const sources = useMemo(() => getUniqueSources(items), [items]);
  const status = getGroupStatus(items);
  const active = isLive && status === "searching";
  const failedCount = items.filter((item) => item.status === "failed").length;
  const visibleSources = showAll ? sources : sources.slice(0, COLLAPSED_SOURCE_COUNT);
  const hiddenSourceCount = sources.length - visibleSources.length;
  const hasDetails = queries.length > 0 || sources.length > 0 || failedCount > 0;
  const label = active
    ? locale === "en-US"
      ? "Searching the web"
      : "正在联网搜索"
    : status === "failed"
      ? locale === "en-US"
        ? "Web search failed"
        : "联网搜索失败"
      : completedLabel(locale, items.length, sources.length);

  return (
    <section
      className="group/search-trace max-w-2xl text-foreground/60"
      aria-busy={active}
      data-hosted-search-trace=""
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? t("chat.search.collapseActivity") : t("chat.search.expandActivity")}
        className="-ml-1 flex h-auto max-w-full items-center gap-2 rounded-md px-1 py-1 text-[calc(13px*var(--zone-font-scale,1))] font-[450] text-foreground/60 transition-colors hover:bg-foreground/[0.035] hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setExpanded((current) => !current)}
      >
        <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <Globe className="h-3 w-3 text-foreground/45" />
        </span>
        <span
          className={cn(
            "min-w-0 truncate",
            active && "shimmer",
            status === "failed" && "text-destructive",
          )}
        >
          {label}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-3 w-3 shrink-0 text-foreground/40 opacity-0 transition-[opacity,transform] duration-150 group-hover/search-trace:opacity-100 group-focus-within/search-trace:opacity-100 motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </button>

      {hasDetails && expanded ? (
        <div className="mt-1 ml-[7px] border-l border-border py-1 pl-[23px]">
          <section
            aria-label={locale === "en-US" ? "Web search activity" : "联网搜索过程"}
            className="max-h-64 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
          >
            <div className="flex flex-col gap-1">
              {queries.map((query) => (
                <div
                  className="flex min-h-7 items-center gap-2 rounded-md px-1.5 py-0.5"
                  key={query}
                >
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-[calc(12.5px*var(--zone-font-scale,1))] text-foreground">
                    {query}
                  </span>
                </div>
              ))}

              {visibleSources.map((source) => (
                <a
                  className="flex min-h-7 items-center gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  href={source.url}
                  key={source.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  <SourceFavicon url={source.url} />
                  <span className="min-w-0 flex-1 truncate text-[calc(12.5px*var(--zone-font-scale,1))] font-medium text-foreground">
                    {source.title || getSourceHost(source.url)}
                  </span>
                  <span className="max-w-40 shrink-0 truncate text-[calc(11.5px*var(--zone-font-scale,1))] text-muted-foreground">
                    {getSourceHost(source.url)}
                  </span>
                </a>
              ))}

              {failedCount > 0 ? (
                <p className="px-1.5 py-1 text-xs leading-5 text-destructive">
                  {locale === "en-US"
                    ? `${failedCount} ${failedCount === 1 ? "search" : "searches"} failed`
                    : `${failedCount} 次搜索失败`}
                </p>
              ) : null}

              {hiddenSourceCount > 0 ? (
                <button
                  className="ml-1 w-fit rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                  onClick={() => setShowAll(true)}
                  type="button"
                >
                  {locale === "en-US"
                    ? `Show ${hiddenSourceCount} more sources`
                    : `查看其余 ${hiddenSourceCount} 个来源`}
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
