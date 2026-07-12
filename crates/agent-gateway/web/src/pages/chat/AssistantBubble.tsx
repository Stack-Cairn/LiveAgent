import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileChangeBadge } from "../../components/chat/FileChangeBadge";
import { ImagePreview, type ImagePreviewSlide } from "../../components/chat/ImagePreview";
import type { IconComponent } from "../../components/icons";
import {
  Bot,
  Brain,
  ChevronRight,
  Clock3,
  Eye,
  FilePenLine,
  FileText,
  FolderTree,
  ImageIcon,
  ImageOff,
  Link2,
  Loader2,
  Plug,
  Search,
  Server,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
} from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { useLocale } from "../../i18n";
import type { ImageContent, ToolResultMessage, Usage } from "../../lib/agentTypes";
import { normalizeLiveToolStatus, VIBING_STATUS } from "../../lib/chat/chatPageHelpers";
import { deriveFileChangeStats } from "../../lib/chat/fileChangeStats";
import type { HostedSearchBlock } from "../../lib/chat/hostedSearch";
import { deriveFileToolPreview, FILE_TOOL_TEXT_FIELDS } from "../../lib/chat/toolPreview";
import {
  previewText,
  safeStringify,
  shouldDisplayToolTraceItem,
  summarizeToolCall,
  type ToolTraceItem,
  toolCallArgsForDisplay,
  toolResultMessageToText,
  type UiRound,
} from "../../lib/chat/uiMessages";
import { prepareImageProxyUrl } from "../../lib/providers/proxy";
import { cn } from "../../lib/shared/utils";
import type {
  SubagentBatchDetails,
  SubagentCardDetails,
  SubagentMessageDetails,
  SubagentReportDetails,
} from "../../lib/subagents/protocol";
import type {
  DeleteResultDetails,
  DisplayImageItemDetails,
  DisplayImageResultDetails,
  EditResultDetails,
  GlobResultDetails,
  GrepResultDetails,
  ListResultDetails,
  McpManagerResultDetails,
  ReadDocumentResultDetails,
  ReadImageResultDetails,
  ReadNotebookResultDetails,
  ReadPdfResultDetails,
  ReadTextResultDetails,
  SkillsManagerResultDetails,
  WriteResultDetails,
} from "../../lib/tools/builtinTypes";
import { EditDiffView } from "./EditDiffView";
import { FileToolArgsDisplay } from "./FileToolArgs";
import {
  type MetaTag,
  MetaTags,
  PathDisplay,
  ToolFactGrid,
  ToolScrollablePre,
  ToolSection,
  ToolSurface,
  ToolSurfaceLabel,
} from "./ToolSurfaces";
export function AssistantAvatar(props: { className?: string }) {
  const { className } = props;
  return (
    <div
      className={cn(
        "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 shadow-sm dark:bg-background/70",
        className,
      )}
    >
      <img
        src="/icon-simple.png"
        alt=""
        aria-hidden="true"
        draggable={false}
        className="h-6 w-6 select-none object-contain"
      />
    </div>
  );
}

function hasDisplayableUsage(usage: Usage | undefined): usage is Usage {
  if (!usage) return false;

  return (
    usage.totalTokens > 0 ||
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    (usage.cost?.total ?? 0) > 0
  );
}

function formatUsageNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatUsageCost(value: number, locale: string) {
  if (value <= 0) return "$0";

  const maximumFractionDigits = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  return `$${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value)}`;
}

function UsagePanel(props: { usage?: Usage; contextWindow?: number }) {
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
    ...((usage.cost?.total ?? 0) > 0
      ? [
          {
            key: "cost",
            label: t("chat.usageCost"),
            value: formatUsageCost(usage.cost?.total ?? 0, locale),
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

export function VibingText({ className }: { className?: string }) {
  return <AnimatedStatusText text={VIBING_STATUS} className={className} />;
}

export function CompactingText({ className }: { className?: string }) {
  const { t } = useLocale();
  return <AnimatedStatusText text={t("chat.compactingContext")} className={className} />;
}

function AnimatedStatusText(props: { text: string; className?: string }) {
  const { text, className } = props;
  return (
    <span className={cn("vibing-status", className)} aria-label={text}>
      {Array.from(text).map((char, idx) => (
        <span
          key={`${char}-${idx}`}
          aria-hidden="true"
          className="vibing-status-char"
          style={{ animationDelay: `${idx * 0.08}s` }}
        >
          {char === " " ? "\u00A0" : char}
        </span>
      ))}
    </span>
  );
}

const THINKING_SCROLL_BOTTOM_THRESHOLD_PX = 2;
const THINKING_USER_SCROLL_INTENT_WINDOW_MS = 500;

function getThinkingScrollBottomGap(viewport: HTMLElement) {
  return Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
}

function isThinkingScrollAtBottom(viewport: HTMLElement) {
  return getThinkingScrollBottomGap(viewport) <= THINKING_SCROLL_BOTTOM_THRESHOLD_PX;
}

function hasThinkingScrollOverflow(viewport: HTMLElement) {
  return viewport.scrollHeight - viewport.clientHeight > THINKING_SCROLL_BOTTOM_THRESHOLD_PX;
}

function useStickyBottomScroll(
  viewportRef: { current: HTMLPreElement | null },
  options: { enabled: boolean; contentKey: string },
) {
  const { enabled, contentKey } = options;
  const shouldStickRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const userScrollIntentUntilRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  const previousContentKeyRef = useRef(contentKey);

  const cancelScheduledScroll = useCallback(() => {
    if (scrollFrameRef.current === null || typeof window === "undefined") {
      scrollFrameRef.current = null;
      return;
    }
    window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = null;
  }, []);

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    shouldStickRef.current = true;
  }, [viewportRef]);

  const scheduleScrollToBottom = useCallback(() => {
    if (scrollFrameRef.current !== null || typeof window === "undefined") {
      return;
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (!shouldStickRef.current) return;
      scrollToBottom();
    });
  }, [scrollToBottom]);

  useEffect(() => {
    if (!enabled) {
      shouldStickRef.current = true;
      cancelScheduledScroll();
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;

    shouldStickRef.current = true;
    scheduleScrollToBottom();

    const markUserScrollIntent = () => {
      userScrollIntentUntilRef.current = Date.now() + THINKING_USER_SCROLL_INTENT_WINDOW_MS;
    };

    const hasRecentUserScrollIntent = () => Date.now() <= userScrollIntentUntilRef.current;

    const syncStickyState = () => {
      if (isThinkingScrollAtBottom(viewport)) {
        shouldStickRef.current = true;
      } else if (hasRecentUserScrollIntent()) {
        shouldStickRef.current = false;
      }
    };

    const handleScroll = () => {
      syncStickyState();
    };

    const handleWheel = (event: WheelEvent) => {
      markUserScrollIntent();
      if (event.deltaY < 0 && hasThinkingScrollOverflow(viewport)) {
        shouldStickRef.current = false;
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      touchYRef.current = event.touches[0]?.clientY ?? null;
      markUserScrollIntent();
    };

    const handleTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      const previousY = touchYRef.current;
      markUserScrollIntent();
      if (
        hasThinkingScrollOverflow(viewport) &&
        (previousY === null ||
          nextY === null ||
          nextY > previousY + 1 ||
          !isThinkingScrollAtBottom(viewport))
      ) {
        shouldStickRef.current = false;
      }
      touchYRef.current = nextY;
    };

    const handlePointerDown = () => {
      markUserScrollIntent();
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    viewport.addEventListener("touchstart", handleTouchStart, { passive: true });
    viewport.addEventListener("touchmove", handleTouchMove, { passive: true });
    viewport.addEventListener("pointerdown", handlePointerDown, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("touchstart", handleTouchStart);
      viewport.removeEventListener("touchmove", handleTouchMove);
      viewport.removeEventListener("pointerdown", handlePointerDown);
      cancelScheduledScroll();
      touchYRef.current = null;
    };
  }, [cancelScheduledScroll, enabled, scheduleScrollToBottom, viewportRef]);

  useEffect(() => {
    const contentChanged = previousContentKeyRef.current !== contentKey;
    previousContentKeyRef.current = contentKey;
    if (!contentChanged || !enabled || !shouldStickRef.current) return;
    scheduleScrollToBottom();
  });

  useEffect(() => () => cancelScheduledScroll(), [cancelScheduledScroll]);
}

function ThinkingBlock({ text, open }: { text: string; open?: boolean }) {
  const hasText = /\S/.test(text || "");
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(typeof open === "boolean" ? open : false);
  const userInteractedRef = useRef(false);
  const thinkingPreRef = useRef<HTMLPreElement | null>(null);

  useStickyBottomScroll(thinkingPreRef, { enabled: isOpen && hasText, contentKey: text });

  useEffect(() => {
    if (!userInteractedRef.current && typeof open === "boolean") {
      setIsOpen(open);
    }
  }, [open]);

  if (!hasText) return null;

  return (
    <div className="group/think rounded-lg border border-border/40 bg-muted/30">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          userInteractedRef.current = true;
          setIsOpen((prev) => !prev);
        }}
        className="thinking-block-toggle flex w-full cursor-pointer select-none items-center gap-2 px-3 py-2 text-[calc(13px*var(--zone-font-scale,1))] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground/70" />
        <span className="thinking-block-label font-medium">{t("chat.thinkingProcess")}</span>
        <ChevronRight
          className={`ml-auto h-3 w-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
        />
      </button>
      {isOpen ? (
        <div className="border-t border-border/30 px-3 pb-3 pt-2">
          <pre
            ref={thinkingPreRef}
            className="thinking-block-pre max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-[calc(12.5px*var(--zone-font-scale,1))] leading-relaxed text-muted-foreground"
          >
            {text}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function getHostedSearchStatusLabel(
  t: (key: string) => string,
  status: HostedSearchBlock["status"],
) {
  switch (status) {
    case "failed":
      return t("chat.search.failed");
    case "completed":
      return t("chat.search.completed");
    case "searching":
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

function HostedSearchGroupView({
  items,
  readOnly = false,
}: {
  items: HostedSearchBlock[];
  readOnly?: boolean;
}) {
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
    <div
      className={cn(
        "tool-card-enter min-w-0 max-w-full overflow-hidden rounded-[12px] border border-black/[0.06] bg-white/[0.72] shadow-[0_0_0_0.5px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.02)] backdrop-blur-xl backdrop-saturate-[1.8] transition-shadow duration-200 dark:border-white/[0.1] dark:bg-white/[0.06] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.2),0_3px_8px_rgba(0,0,0,0.12)] dark:backdrop-saturate-[1.4]",
        !readOnly &&
          "hover:shadow-[0_0_0_0.5px_rgba(0,0,0,0.04),0_1px_3px_rgba(0,0,0,0.05),0_4px_14px_rgba(0,0,0,0.04)] dark:hover:shadow-[0_0_0_0.5px_rgba(255,255,255,0.06),0_1px_3px_rgba(0,0,0,0.25),0_4px_14px_rgba(0,0,0,0.18)]",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.search.collapseActivity") : t("chat.search.expandActivity")}
        className={cn(
          "grid w-full select-none grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 px-2.5 py-2 text-left transition-colors sm:items-center",
          "cursor-pointer hover:bg-black/[0.018] active:bg-black/[0.035] dark:hover:bg-white/[0.025] dark:active:bg-white/[0.045]",
        )}
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

function getToolMeta(name: string): { Icon: IconComponent; accent: string; category: string } {
  switch (name) {
    case "Bash":
    case "ManagedProcess":
      return { Icon: Terminal, accent: "var(--tool-bash-accent)", category: "terminal" };
    case "Read":
      return { Icon: Eye, accent: "var(--tool-file-accent)", category: "file" };
    case "Image":
      return { Icon: ImageIcon, accent: "var(--tool-file-accent)", category: "file" };
    case "SkillsManager":
      return { Icon: Eye, accent: "var(--tool-file-accent)", category: "file" };
    case "CronTaskManager":
      return { Icon: Clock3, accent: "var(--tool-list-accent)", category: "system" };
    case "MemoryManager":
      return { Icon: Brain, accent: "var(--tool-list-accent)", category: "system" };
    case "McpManager":
      return { Icon: Plug, accent: "var(--tool-list-accent)", category: "mcp" };
    case "TunnelManager":
      return { Icon: Link2, accent: "var(--tool-list-accent)", category: "system" };
    case "SSHManager":
    case "SshManager":
      return { Icon: Server, accent: "var(--tool-bash-accent)", category: "terminal" };
    case "Agent":
      return { Icon: Bot, accent: "var(--tool-list-accent)", category: "system" };
    case "SendMessage":
      return { Icon: Bot, accent: "var(--tool-list-accent)", category: "system" };
    case "Write":
      return { Icon: FileText, accent: "var(--tool-file-accent)", category: "file" };
    case "Edit":
      return { Icon: FilePenLine, accent: "var(--tool-file-accent)", category: "file" };
    case "Delete":
      return { Icon: Trash2, accent: "var(--tool-file-accent)", category: "file" };
    case "Glob":
      return { Icon: Search, accent: "var(--tool-search-accent)", category: "search" };
    case "Grep":
      return { Icon: Search, accent: "var(--tool-search-accent)", category: "search" };
    case "List":
      return { Icon: FolderTree, accent: "var(--tool-list-accent)", category: "list" };
    default:
      return { Icon: Wrench, accent: "var(--tool-file-accent)", category: "other" };
  }
}

function displayString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function compactInlineText(value: unknown, maxChars = 120) {
  const text = displayString(value).replace(/\s+/g, " ");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function isSubagentCardToolCall(toolCall: { name: string; arguments?: Record<string, unknown> }) {
  return toolCall.name === "Agent" && toolCall.arguments?.subagent_card === true;
}

function getSubagentTask(agent: { prompt?: unknown }) {
  return displayString(agent.prompt);
}

function getSubagentInlineSummary(item: ToolTraceItem) {
  const details = item.toolResult?.details as Partial<SubagentCardDetails> | undefined;
  const agent = details?.kind === "subagent_card" ? details.agent : undefined;
  const args = item.toolCall.arguments || {};
  const name = displayString(agent?.name) || displayString(args.name) || displayString(args.id);
  const task = agent ? getSubagentTask(agent) : displayString(args.prompt);

  if (name && task) return `${name} - ${compactInlineText(task, 96)}`;
  return name || compactInlineText(task, 120);
}

function shouldShowSubagentApplyStatus(agent: SubagentReportDetails) {
  if (!agent.applyStatus) return false;
  if (agent.applyStatus === "applied" || agent.applyStatus === "failed") return true;
  return Boolean(agent.applySkippedReason && agent.applySkippedReason !== "no_changes");
}

function shouldShowSubagentCleanupStatus(agent: SubagentReportDetails) {
  return Boolean(
    agent.worktreeCleanupStatus &&
      agent.worktreeCleanupStatus !== "removed" &&
      agent.worktreeCleanupStatus !== "skipped",
  );
}

function shouldShowSubagentWorktreeLocation(agent: SubagentReportDetails) {
  return Boolean(
    agent.worktreeRoot &&
      (agent.status !== "completed" ||
        agent.worktreeCleanupStatus === "retained" ||
        agent.worktreeCleanupStatus === "failed"),
  );
}

type GroupedRoundBlock =
  | {
      kind: "thinking";
      key: string;
      text: string;
    }
  | {
      kind: "text";
      key: string;
      text: string;
    }
  | {
      kind: "tool";
      key: string;
      item: ToolTraceItem;
    }
  | {
      kind: "hostedSearch";
      key: string;
      item: HostedSearchBlock;
    }
  | {
      kind: "hostedSearchGroup";
      key: string;
      items: HostedSearchBlock[];
    }
  | {
      kind: "toolGroup";
      key: string;
      items: ToolTraceItem[];
    };

type ShellResultDetails = {
  exit_code: number;
  shell: string;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
  cancelled?: boolean;
  effective_timeout_ms?: number;
  duration_ms: number;
};

function isShellResultDetails(value: unknown): value is ShellResultDetails {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.exit_code === "number" &&
    typeof candidate.shell === "string" &&
    typeof candidate.stdout === "string" &&
    typeof candidate.stderr === "string" &&
    typeof candidate.stdout_truncated === "boolean" &&
    typeof candidate.stderr_truncated === "boolean" &&
    typeof candidate.timed_out === "boolean" &&
    typeof candidate.duration_ms === "number"
  );
}

function summarizeShellStream(text: string, truncated: boolean) {
  const length = text.length;
  if (length === 0) return "empty";
  return truncated ? `${length} chars, truncated` : `${length} chars`;
}

const stableValueSignatureCache = new WeakMap<object, string>();

function getStableValueSignature(value: unknown) {
  if (value && typeof value === "object") {
    const cached = stableValueSignatureCache.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const signature = safeStringify(value);
    stableValueSignatureCache.set(value, signature);
    return signature;
  }
  return safeStringify(value);
}

function areStableValuesEqual(previous: unknown, next: unknown) {
  return previous === next || getStableValueSignature(previous) === getStableValueSignature(next);
}

function getToolTraceKey(item: ToolTraceItem, index: number) {
  const id = item.toolCall.id?.trim();
  if (id) return id;
  return `${item.toolCall.name}-${index}-${getStableValueSignature(item.toolCall.arguments)}`;
}

function isAgentToolName(name: string) {
  return name === "Agent";
}

function getToolDisplayName(name: string) {
  if (name === "SshManager") return "SSHManager";
  return name;
}

const TOOL_CARD_ACTION_NAMES = new Set([
  "SkillsManager",
  "CronTaskManager",
  "McpManager",
  "MemoryManager",
  "TunnelManager",
  "SSHManager",
  "ManagedProcess",
]);

function getManagerToolActionName(toolCall: { name: string; arguments?: Record<string, unknown> }) {
  const name = getToolDisplayName(toolCall.name);
  if (!TOOL_CARD_ACTION_NAMES.has(name)) return "";
  const args = toolCall.arguments || {};
  const action = displayString(args.action);
  if (action) return action;
  if (name === "SkillsManager") {
    return displayString(args.path) ? "read" : "list";
  }
  return "";
}

function getToolDisplayTitle(toolCall: { name: string; arguments?: Record<string, unknown> }) {
  const name = getToolDisplayName(toolCall.name);
  const action = getManagerToolActionName(toolCall);
  return { name, action };
}

function groupRoundBlocks(blocks: UiRound["blocks"]): GroupedRoundBlock[] {
  const groupedBlocks: GroupedRoundBlock[] = [];
  let pendingTools: ToolTraceItem[] = [];
  let pendingStartIndex = 0;
  let pendingSearches: HostedSearchBlock[] = [];
  let pendingSearchStartIndex = 0;
  const hasHostedSearch = blocks.some((block) => block.kind === "hostedSearch");

  const flushPendingTools = () => {
    if (pendingTools.length === 0) return;
    if (pendingTools.length === 1) {
      const item = pendingTools[0];
      groupedBlocks.push({
        kind: "tool",
        key: `tool-${getToolTraceKey(item, pendingStartIndex)}`,
        item,
      });
    } else {
      groupedBlocks.push({
        kind: "toolGroup",
        // Anchored to the group's start only: appending tools to a streaming
        // group must keep the key stable, or the remount would wipe the
        // user's manual expand/collapse state mid-run.
        key: `tool-group-${pendingStartIndex}-${getToolTraceKey(pendingTools[0], pendingStartIndex)}`,
        items: pendingTools,
      });
    }
    pendingTools = [];
  };

  const flushPendingSearches = () => {
    if (pendingSearches.length === 0) return;
    const firstSearch = pendingSearches[0];
    groupedBlocks.push({
      kind: "hostedSearchGroup",
      key: `hosted-search-group-${firstSearch?.id || pendingSearchStartIndex}`,
      items: pendingSearches,
    });
    pendingSearches = [];
  };

  blocks.forEach((block, index) => {
    if (block.kind === "tool") {
      if (!shouldDisplayToolTraceItem(block.item, { hasHostedSearch })) {
        return;
      }
      flushPendingSearches();
      if (block.item.toolCall.name === "Image" || isAgentToolName(block.item.toolCall.name)) {
        flushPendingTools();
        groupedBlocks.push({
          kind: "tool",
          key: `tool-${getToolTraceKey(block.item, index)}`,
          item: block.item,
        });
        return;
      }
      if (pendingTools.length === 0) {
        pendingStartIndex = index;
      }
      pendingTools.push(block.item);
      return;
    }

    flushPendingTools();
    if (block.kind === "hostedSearch") {
      if (pendingSearches.length === 0) {
        pendingSearchStartIndex = index;
      }
      pendingSearches.push(block.item);
      return;
    }
    flushPendingSearches();
    if (block.kind === "thinking") {
      groupedBlocks.push({ kind: "thinking", key: `thinking-${index}`, text: block.text });
      return;
    }
    groupedBlocks.push({ kind: "text", key: `text-${index}`, text: block.text });
  });

  flushPendingTools();
  flushPendingSearches();
  return groupedBlocks;
}

function getToolGroupCounts(items: ToolTraceItem[], runningToolCallIds: string[]) {
  const runningIds = new Set(runningToolCallIds);
  let running = 0;
  let failed = 0;
  let completed = 0;
  let waiting = 0;

  for (const item of items) {
    if (item.toolCall.id && runningIds.has(item.toolCall.id)) {
      running += 1;
      continue;
    }
    if (!item.toolResult) {
      waiting += 1;
      continue;
    }
    if (item.toolResult.isError) {
      failed += 1;
      continue;
    }
    completed += 1;
  }

  return { running, failed, completed, waiting };
}

function getToolGroupComposition(items: ToolTraceItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = getToolDisplayName(item.toolCall.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
}

function getDominantToolName(items: ToolTraceItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.toolCall.name, (counts.get(item.toolCall.name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Tool";
}

function buildPagedResultTags(params: {
  label: string;
  returned: number;
  total: number;
  offset: number;
  hasMore: boolean;
}) {
  const { label, returned, total, offset, hasMore } = params;
  return [
    { label, value: `${returned}/${total}` },
    ...(offset > 0 ? [{ label: "offset", value: String(offset) }] : []),
    { label: "state", value: hasMore ? "partial" : "complete" },
  ];
}

/** Extract tool-specific display info */
function getToolDisplay(toolCall: { name: string; arguments?: Record<string, unknown> }) {
  const args = toolCall.arguments || {};
  const name = toolCall.name;
  const path = typeof args.path === "string" ? (args.path as string) : null;
  const pattern = typeof args.pattern === "string" ? (args.pattern as string) : null;
  const tags: MetaTag[] = [];

  switch (name) {
    case "Read":
      if (typeof args.start_line === "number")
        tags.push({ label: "start", value: String(args.start_line) });
      if (typeof args.limit === "number") tags.push({ label: "limit", value: String(args.limit) });
      if (typeof args.page_start === "number")
        tags.push({ label: "page", value: String(args.page_start) });
      if (typeof args.page_limit === "number")
        tags.push({ label: "pages", value: String(args.page_limit) });
      if (typeof args.cell_start === "number")
        tags.push({ label: "cell", value: String(args.cell_start) });
      if (typeof args.cell_limit === "number")
        tags.push({ label: "cells", value: String(args.cell_limit) });
      return { type: "file" as const, path, tags };
    case "SkillsManager":
      if (typeof args.offset === "number")
        tags.push({ label: "start", value: String(args.offset + 1) });
      if (typeof args.length === "number")
        tags.push({ label: "limit", value: String(args.length) });
      return { type: "file" as const, path, tags };
    case "MemoryManager":
      if (typeof args.action === "string")
        tags.push({ label: "action", value: args.action as string });
      if (typeof args.slug === "string") tags.push({ label: "slug", value: args.slug as string });
      if (typeof args.scope === "string")
        tags.push({ label: "scope", value: args.scope as string });
      if (typeof args.type === "string") tags.push({ label: "type", value: args.type as string });
      return { type: "generic" as const, path: null, pattern: null, tags };
    case "McpManager":
      if (typeof args.action === "string")
        tags.push({ label: "action", value: args.action as string });
      if (typeof args.server_id === "string")
        tags.push({ label: "server", value: args.server_id as string });
      if (Array.isArray(args.server_ids))
        tags.push({ label: "servers", value: String(args.server_ids.length) });
      if (typeof args.conflict === "string")
        tags.push({ label: "conflict", value: args.conflict as string });
      if (args.include_schema === true) tags.push({ label: "schema", value: "true" });
      return { type: "generic" as const, path: null, pattern: null, tags };
    case "SendMessage":
      if (typeof args.to === "string") tags.push({ label: "to", value: args.to as string });
      if (typeof args.channel === "string")
        tags.push({ label: "channel", value: args.channel as string });
      if (typeof args.subject === "string")
        tags.push({ label: "subject", value: args.subject as string });
      if (typeof args.summary === "string" && typeof args.subject !== "string")
        tags.push({ label: "subject", value: args.summary as string });
      if (typeof args.message === "string")
        tags.push({ label: "message", value: `${(args.message as string).length} chars` });
      return { type: "generic" as const, path: null, pattern: null, tags };
    case "Delete":
      return { type: "file" as const, path, tags };
    case "List":
      if (typeof args.depth === "number") tags.push({ label: "depth", value: String(args.depth) });
      if (typeof args.offset === "number")
        tags.push({ label: "offset", value: String(args.offset) });
      if (typeof args.max_results === "number")
        tags.push({ label: "max", value: String(args.max_results) });
      return { type: "file" as const, path: path || "/", tags };
    case "Glob":
      if (typeof args.offset === "number")
        tags.push({ label: "offset", value: String(args.offset) });
      if (typeof args.max_results === "number")
        tags.push({ label: "max", value: String(args.max_results) });
      return { type: "search" as const, path, pattern, tags };
    case "Grep":
      if (typeof args.file_pattern === "string")
        tags.push({ label: "filter", value: args.file_pattern as string });
      if (typeof args.output_mode === "string")
        tags.push({ label: "mode", value: args.output_mode as string });
      if (typeof args.ignore_case === "boolean" && args.ignore_case)
        tags.push({ label: "flag", value: "-i" });
      if (typeof args.context === "number" && args.context > 0)
        tags.push({ label: "ctx", value: String(args.context) });
      if (typeof args.head_limit === "number")
        tags.push({ label: "head", value: String(args.head_limit) });
      if (args.multiline === true) tags.push({ label: "multi", value: "true" });
      return { type: "search" as const, path, pattern, tags };
    case "Bash":
      return { type: "bash" as const, path: null, pattern: null, tags };
    case "ManagedProcess": {
      if (typeof args.action === "string") tags.push({ label: "action", value: args.action });
      if (typeof args.process_id === "string")
        tags.push({ label: "process", value: args.process_id as string });
      if (typeof args.label === "string")
        tags.push({ label: "label", value: args.label as string });
      if (typeof args.cwd === "string") tags.push({ label: "cwd", value: args.cwd as string });
      if (args.isolated === true) tags.push({ label: "isolated", value: "true" });
      if (typeof args.max_bytes === "number")
        tags.push({ label: "max_bytes", value: String(args.max_bytes) });
      const command = typeof args.command === "string" ? (args.command as string).trim() : "";
      return command
        ? { type: "bash" as const, path: null, pattern: null, tags }
        : { type: "generic" as const, path: null, pattern: null, tags };
    }
    default: {
      // Generic: collect all string/number/boolean args
      const entries: MetaTag[] = [];
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === "string")
          entries.push({ label: k, value: v.length > 60 ? `${v.slice(0, 60)}…` : v });
        else if (typeof v === "number" || typeof v === "boolean")
          entries.push({ label: k, value: String(v) });
      }
      return { type: "generic" as const, path: null, pattern: null, tags: entries };
    }
  }
}

/** Expanded args display — tool-aware layout */
function ToolArgsDisplay({ item }: { item: ToolTraceItem }) {
  const toolCall = item.toolCall;

  const filePreview = deriveFileToolPreview(toolCall);
  if (filePreview) {
    return <FileToolArgsDisplay preview={filePreview} />;
  }

  const display = getToolDisplay(toolCall);

  if (isSubagentCardToolCall(toolCall)) {
    const args = toolCall.arguments || {};
    const name = displayString(args.name) || displayString(args.id);
    const role = displayString(args.role);
    const task = displayString(args.prompt);

    return (
      <div className="tool-expand flex flex-col gap-2">
        {name ? (
          <ToolSurface>
            <ToolSurfaceLabel label="agent" />
            <div className="break-words text-[calc(11.5px*var(--zone-font-scale,1))] font-semibold leading-[1.55] text-foreground/86">
              {name}
            </div>
          </ToolSurface>
        ) : null}
        {role ? (
          <ToolSurface>
            <ToolSurfaceLabel label="role" />
            <div className="break-words text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.55] text-foreground/78">
              {role}
            </div>
          </ToolSurface>
        ) : null}
        {task ? (
          <ToolSurface>
            <ToolSurfaceLabel label="task" />
            <div className="break-words text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6] text-foreground/82">
              {task}
            </div>
          </ToolSurface>
        ) : null}
      </div>
    );
  }

  // Bash / ManagedProcess(start): terminal block
  if (display.type === "bash") {
    const cmd =
      typeof toolCall.arguments?.command === "string"
        ? (toolCall.arguments.command as string).trim()
        : "";
    if (!cmd) return null;
    return (
      <div className="tool-expand flex flex-col gap-2">
        <ToolSurface className="overflow-hidden border-emerald-500/15 bg-zinc-950/90 px-0 py-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark:border-white/[0.08] dark:bg-zinc-950/90">
          <ToolScrollablePre className="max-h-44 rounded-none text-emerald-300/90">
            <span className="mr-1 select-none text-emerald-500/30">$</span>
            {cmd}
          </ToolScrollablePre>
        </ToolSurface>
        {display.tags.length > 0 ? <MetaTags tags={display.tags} /> : null}
      </div>
    );
  }

  // File tools: target path + compact request facts
  if (display.type === "file" && (display.path || display.tags.length > 0)) {
    return (
      <div className="tool-expand flex flex-col gap-2">
        {display.path ? (
          <ToolSurface>
            <ToolSurfaceLabel label="path" />
            <PathDisplay
              path={display.path}
              className="block min-w-0 break-all font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6]"
            />
          </ToolSurface>
        ) : null}
        {display.tags.length > 0 ? <MetaTags tags={display.tags} /> : null}
      </div>
    );
  }

  // Search tools: query, scope, and request facts
  if (display.type === "search" && (display.pattern || display.path || display.tags.length > 0)) {
    return (
      <div className="tool-expand flex flex-col gap-2">
        {display.pattern ? (
          <ToolSurface>
            <ToolSurfaceLabel label="query" />
            <div className="flex items-start gap-2">
              <Search className="mt-[2px] h-3.5 w-3.5 shrink-0 text-muted-foreground/35" />
              <span className="min-w-0 break-all font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6] text-foreground/82">
                {display.pattern}
              </span>
            </div>
          </ToolSurface>
        ) : null}
        {display.path ? (
          <ToolSurface>
            <ToolSurfaceLabel label="scope" />
            <PathDisplay
              path={display.path}
              className="block min-w-0 break-all font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6]"
            />
          </ToolSurface>
        ) : null}
        {display.tags.length > 0 ? <MetaTags tags={display.tags} /> : null}
      </div>
    );
  }

  // Generic: key-value grid
  if (display.type === "generic" && display.tags.length > 0) {
    return <ToolFactGrid tags={display.tags} />;
  }

  // Fallback: raw JSON
  return (
    <ToolSurface className="overflow-hidden px-0 py-0">
      <ToolScrollablePre className="max-h-44 rounded-none">
        {safeStringify(toolCallArgsForDisplay(toolCall))}
      </ToolScrollablePre>
    </ToolSurface>
  );
}

function getBuiltinResultKind(result?: ToolResultMessage) {
  if (!result?.details || typeof result.details !== "object") return null;
  const kind = (result.details as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

function getToolResultImages(result?: ToolResultMessage) {
  if (!result) return [];
  return result.content.filter((block): block is ImageContent => block.type === "image");
}

type NativeDisplayImageEntry = {
  detail: DisplayImageItemDetails;
  image?: ImageContent;
};

type NativeDisplayImageProxyRequest = {
  index: number;
  source: string;
};

type NativeDisplayImageSourceState = {
  src: string;
  status: "loading" | "ready" | "error";
};

type ToolImageLoadState = "loading" | "loaded" | "error";

function getImageDataUrl(image: ImageContent) {
  return `data:${image.mimeType};base64,${image.data}`;
}

function isDisplayImageItemDetails(value: unknown): value is DisplayImageItemDetails {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

function getDisplayImageDetails(result: ToolResultMessage): DisplayImageItemDetails[] {
  const details = result.details as DisplayImageResultDetails | undefined;
  if (!details || details.kind !== "display_image" || !Array.isArray(details.images)) {
    return [];
  }
  return details.images.filter(isDisplayImageItemDetails);
}

function shouldRenderDisplayImageThroughProxy(detail: DisplayImageItemDetails) {
  return detail.renderMode === "proxy" || detail.sourceType === "url";
}

function getProxyImageSource(detail: DisplayImageItemDetails) {
  if (!shouldRenderDisplayImageThroughProxy(detail)) return "";
  const source = (detail.sourceUrl || detail.path || "").trim();
  return /^https?:\/\//i.test(source) ? source : "";
}

function getNativeDisplayImageEntries(result: ToolResultMessage): NativeDisplayImageEntry[] {
  const inlineImages = getToolResultImages(result);
  const detailImages = getDisplayImageDetails(result);
  if (detailImages.length > 0) {
    let inlineImageIndex = 0;
    const entries = detailImages
      .map((detail) => {
        if (shouldRenderDisplayImageThroughProxy(detail)) {
          return { detail, image: undefined };
        }
        const image = inlineImages[inlineImageIndex];
        inlineImageIndex += 1;
        return { detail, image };
      })
      .filter((entry) => Boolean(entry.image) || Boolean(getProxyImageSource(entry.detail)));
    if (entries.length > 0) return entries;
  }
  return inlineImages.map((image, index) => ({
    image,
    detail: {
      path: `inline-image-${index + 1}`,
      renderMode: "inline",
      mimeType: image.mimeType,
      sizeBytes: Math.ceil((image.data.length * 3) / 4),
    },
  }));
}

function getNativeDisplayImageProxyKey(entries: NativeDisplayImageEntry[]) {
  const requests = entries
    .map((entry, index) => {
      const source = getProxyImageSource(entry.detail);
      return source ? { index, source } : null;
    })
    .filter((request): request is NativeDisplayImageProxyRequest => request !== null);
  return JSON.stringify(requests);
}

function parseNativeDisplayImageProxyKey(proxyKey: string): NativeDisplayImageProxyRequest[] {
  if (!proxyKey || proxyKey === "[]") return [];
  try {
    const parsed = JSON.parse(proxyKey);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is NativeDisplayImageProxyRequest =>
        item !== null &&
        typeof item === "object" &&
        typeof item.index === "number" &&
        Number.isInteger(item.index) &&
        item.index >= 0 &&
        typeof item.source === "string" &&
        item.source.length > 0,
    );
  } catch {
    return [];
  }
}

function useNativeDisplayImageSources(entries: NativeDisplayImageEntry[]) {
  const proxyKey = getNativeDisplayImageProxyKey(entries);
  const [proxySources, setProxySources] = useState<Record<number, NativeDisplayImageSourceState>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    const pending = parseNativeDisplayImageProxyKey(proxyKey);

    if (pending.length === 0) {
      setProxySources({});
      return;
    }

    setProxySources(
      Object.fromEntries(
        pending.map(({ index }) => [index, { src: "", status: "loading" as const }]),
      ),
    );
    void Promise.all(
      pending.map(async ({ index, source }) => {
        try {
          const preparedSource = await prepareImageProxyUrl(source);
          return [
            index,
            preparedSource
              ? { src: preparedSource, status: "ready" as const }
              : { src: "", status: "error" as const },
          ] as const;
        } catch {
          return [index, { src: "", status: "error" as const }] as const;
        }
      }),
    ).then((items) => {
      if (cancelled) return;
      const next: Record<number, NativeDisplayImageSourceState> = {};
      for (const [index, source] of items) {
        next[index] = source;
      }
      setProxySources(next);
    });

    return () => {
      cancelled = true;
    };
  }, [proxyKey]);

  return entries.map((entry, index) => {
    if (entry.image) {
      return { src: getImageDataUrl(entry.image), status: "ready" as const };
    }
    if (!getProxyImageSource(entry.detail)) {
      return { src: "", status: "error" as const };
    }
    return proxySources[index] ?? { src: "", status: "loading" as const };
  });
}

function extractResultText(result?: ToolResultMessage) {
  return result ? toolResultMessageToText(result) : "";
}

const LARGE_TOOL_IMAGE_INLINE_THRESHOLD_BYTES = 2 * 1024 * 1024;

function estimateBase64Bytes(data: string) {
  return Math.ceil((data.length * 3) / 4);
}

function formatToolResultBytes(sizeBytes: number) {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${Math.round(sizeBytes / 1024)} KB`;
  }
  return `${sizeBytes} B`;
}

function getInitialImageLoadState(source: NativeDisplayImageSourceState): ToolImageLoadState {
  if (source.status === "error") return "error";
  if (source.status === "ready" && !source.src) return "error";
  return "loading";
}

function getCompletedImageLoadState(image: HTMLImageElement | null): ToolImageLoadState | null {
  if (!image?.complete) return null;
  return image.naturalWidth > 0 || image.naturalHeight > 0 ? "loaded" : "error";
}

function formatDisplayImageLabel(t: (key: string) => string, imageCount: number, index: number) {
  if (imageCount <= 1) return t("chat.image.display");
  return t("chat.image.displayNumber").replace("{index}", String(index + 1));
}

function ToolImageStatusCard(props: {
  status: "loading" | "error";
  title?: string;
  detail?: string;
  className?: string;
}) {
  const { status, title, detail, className } = props;
  const { t } = useLocale();
  const isError = status === "error";
  const Icon = isError ? ImageOff : Loader2;

  return (
    <div
      className={cn(
        "relative flex min-h-28 w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-[8px] border border-dashed px-4 py-5 text-center",
        isError
          ? "border-red-500/25 bg-red-500/[0.04] text-red-700 dark:border-red-400/25 dark:bg-red-400/[0.06] dark:text-red-300"
          : "border-black/[0.08] bg-black/[0.025] text-muted-foreground dark:border-white/[0.1] dark:bg-white/[0.035]",
        className,
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-[8px] border bg-white/80 shadow-sm dark:bg-black/20",
          isError ? "border-red-500/20" : "border-black/[0.06] dark:border-white/[0.08]",
        )}
      >
        <Icon className={cn("h-4 w-4", !isError && "animate-spin text-primary")} />
      </div>
      <div className="max-w-full space-y-1">
        <div className="text-[calc(12px*var(--zone-font-scale,1))] font-medium">
          {title ?? (isError ? t("chat.image.unavailable") : t("chat.image.loading"))}
        </div>
        {detail ? (
          <div
            className={cn(
              "max-w-full truncate text-[calc(11px*var(--zone-font-scale,1))]",
              isError ? "text-red-700/75 dark:text-red-200/75" : "text-muted-foreground",
            )}
            title={detail}
          >
            {detail}
          </div>
        ) : null}
      </div>
      {!isError ? (
        <div className="h-1 w-24 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-primary/55" />
        </div>
      ) : null}
    </div>
  );
}

function ToolResultImagePreview(props: {
  image: ImageContent;
  alt: string;
  id: string;
  sizeBytes?: number;
  readOnly?: boolean;
}) {
  const { image, alt, id, sizeBytes, readOnly = false } = props;
  const { t } = useLocale();
  const estimatedBytes = sizeBytes ?? estimateBase64Bytes(image.data);
  const shouldDeferImage = estimatedBytes > LARGE_TOOL_IMAGE_INLINE_THRESHOLD_BYTES;
  const [shouldLoad, setShouldLoad] = useState(readOnly ? true : !shouldDeferImage);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageStatus, setImageStatus] = useState<ToolImageLoadState>("loading");
  const imageRef = useRef<HTMLImageElement | null>(null);
  const src = getImageDataUrl(image);
  const imageDetail = `${alt} · ${formatToolResultBytes(estimatedBytes)}`;
  const slides = useMemo<ImagePreviewSlide[]>(
    () => [
      {
        src,
        alt,
        title: alt,
      },
    ],
    [alt, src],
  );

  useEffect(() => {
    setShouldLoad(readOnly ? true : !shouldDeferImage);
    setImageStatus(src ? "loading" : "error");
    setPreviewOpen(false);
  }, [readOnly, shouldDeferImage, src]);

  useEffect(() => {
    if (!shouldLoad || !src) return;
    const completedState = getCompletedImageLoadState(imageRef.current);
    if (completedState) {
      setImageStatus(completedState);
    }
  }, [shouldLoad, src]);

  if (!shouldLoad) {
    return (
      <button
        type="button"
        className="group flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-black/[0.12] bg-black/[0.025] px-4 py-5 text-center text-muted-foreground transition-colors hover:border-black/[0.2] hover:bg-black/[0.04] hover:text-foreground dark:border-white/[0.14] dark:bg-white/[0.035] dark:hover:border-white/[0.22] dark:hover:bg-white/[0.055]"
        onClick={() => setShouldLoad(true)}
        title={alt}
        aria-label={`${t("chat.image.load")} ${alt}`}
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-black/[0.06] bg-white/80 shadow-sm transition-colors group-hover:border-black/[0.12] dark:border-white/[0.08] dark:bg-black/20 dark:group-hover:border-white/[0.16]">
          <Eye className="h-4 w-4" />
        </div>
        <div className="max-w-full space-y-1">
          <div className="text-[calc(12px*var(--zone-font-scale,1))] font-medium">
            {t("chat.image.clickToLoad")}
          </div>
          <div
            className="max-w-full truncate text-[calc(11px*var(--zone-font-scale,1))]"
            title={imageDetail}
          >
            {imageDetail}
          </div>
        </div>
      </button>
    );
  }

  const canPreview = imageStatus === "loaded";
  const imageFrame = (
    <div className={cn("relative w-full", imageStatus !== "loaded" && "min-h-32")}>
      {imageStatus !== "loaded" ? (
        <ToolImageStatusCard
          status={imageStatus === "error" ? "error" : "loading"}
          title={imageStatus === "error" ? t("chat.image.unavailable") : t("chat.image.loading")}
          detail={imageStatus === "error" ? t("chat.image.checkGenerated") : imageDetail}
          className="absolute inset-0 min-h-32"
        />
      ) : null}
      {imageStatus !== "error" ? (
        <img
          ref={imageRef}
          key={id}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className={cn(
            "max-h-[32rem] w-full rounded-[8px] object-contain transition-opacity duration-200",
            imageStatus === "loaded"
              ? "opacity-100"
              : "pointer-events-none absolute inset-0 h-full max-h-none opacity-0",
          )}
          onLoad={() => setImageStatus("loaded")}
          onError={() => setImageStatus("error")}
        />
      ) : null}
    </div>
  );

  return (
    <>
      <button
        type="button"
        className={cn(
          "relative block w-full overflow-hidden rounded-[8px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:opacity-100",
          canPreview ? "cursor-zoom-in" : "cursor-default",
        )}
        disabled={!canPreview}
        onClick={() => {
          if (canPreview) setPreviewOpen(true);
        }}
        title={alt}
        aria-label={
          canPreview ? `${t("chat.image.preview")} ${alt}` : `${t("chat.image.loading")} ${alt}`
        }
      >
        {imageFrame}
      </button>
      {previewOpen ? (
        <ImagePreview open={previewOpen} slides={slides} onClose={() => setPreviewOpen(false)} />
      ) : null}
    </>
  );
}

function getNativeDisplayImagePayload(item: ToolTraceItem) {
  const result = item.toolResult;
  if (!result || result.isError || getBuiltinResultKind(result) !== "display_image") {
    return null;
  }

  const entries = getNativeDisplayImageEntries(result);
  if (entries.length === 0) {
    return null;
  }

  return {
    details: result.details as DisplayImageResultDetails,
    entries,
  };
}

function getNativeImageGridClass(imageCount: number) {
  if (imageCount <= 1) {
    return "my-1 flex max-w-full flex-col items-start gap-2";
  }
  if (imageCount === 2) {
    return "my-1 grid w-full max-w-3xl grid-cols-2 gap-2";
  }
  if (imageCount === 3) {
    return "my-1 grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-3";
  }
  if (imageCount === 4) {
    return "my-1 grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-4";
  }
  if (imageCount === 5) {
    return "my-1 grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5";
  }
  return "my-1 grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6";
}

function isSvgDisplayImageEntry(entry: NativeDisplayImageEntry) {
  const mimeType = entry.image?.mimeType || entry.detail.mimeType || "";
  return mimeType.split(";")[0]?.trim().toLowerCase() === "image/svg+xml";
}

function NativeDisplayImageTile(props: {
  source: NativeDisplayImageSourceState;
  alt: string;
  isGallery: boolean;
  isSvgImage: boolean;
  loading: "lazy" | "eager";
  onPreview: () => void;
  readOnly?: boolean;
}) {
  const { source, alt, isGallery, isSvgImage, loading, onPreview } = props;
  const { t } = useLocale();
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageStatus, setImageStatus] = useState<ToolImageLoadState>(() =>
    getInitialImageLoadState(source),
  );

  useEffect(() => {
    setImageStatus(getInitialImageLoadState(source));
  }, [source.src, source.status]);

  useEffect(() => {
    if (source.status !== "ready" || !source.src) return;
    const completedState = getCompletedImageLoadState(imageRef.current);
    if (completedState) {
      setImageStatus(completedState);
    }
  }, [source.src, source.status]);

  const canPreview = source.status === "ready" && imageStatus === "loaded";
  const isWaiting = !canPreview;
  const statusTitle =
    imageStatus === "error"
      ? t("chat.image.unavailable")
      : source.status === "loading"
        ? t("chat.image.preparing")
        : t("chat.image.loading");

  const className = cn(
    "relative flex max-w-full items-center justify-center overflow-hidden rounded-[10px] text-left shadow-sm transition-[filter,transform]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:opacity-100",
    canPreview ? "cursor-zoom-in hover:brightness-[0.98]" : "cursor-default hover:brightness-100",
    isGallery && "aspect-square w-full bg-muted/30",
    !isGallery && (isSvgImage || isWaiting) && "min-h-28 w-full max-w-3xl bg-muted/30",
    imageStatus === "error" && "shadow-none",
  );
  const content = (
    <>
      {source.status === "ready" && source.src && imageStatus !== "error" ? (
        <img
          ref={imageRef}
          src={source.src}
          alt={alt}
          loading={loading}
          decoding="async"
          className={cn(
            "block object-contain transition-opacity duration-200",
            isGallery
              ? "absolute inset-0 h-full w-full p-1"
              : isSvgImage
                ? "h-auto max-h-[32rem] w-full max-w-full p-1"
                : "h-auto max-h-[32rem] max-w-full",
            imageStatus === "loaded"
              ? "opacity-100"
              : "pointer-events-none absolute inset-0 h-full w-full max-h-none opacity-0",
          )}
          onLoad={() => setImageStatus("loaded")}
          onError={() => setImageStatus("error")}
        />
      ) : null}
      {imageStatus !== "loaded" ? (
        <ToolImageStatusCard
          status={imageStatus === "error" ? "error" : "loading"}
          title={statusTitle}
          detail={imageStatus === "error" ? t("chat.image.checkSource") : alt}
          className={cn(
            "rounded-[10px]",
            isGallery ? "absolute inset-0 min-h-0" : "min-h-28 w-full max-w-3xl",
          )}
        />
      ) : null}
    </>
  );

  return (
    <button
      type="button"
      className={cn(className)}
      disabled={!canPreview}
      aria-label={canPreview ? `${t("chat.image.preview")} ${alt}` : statusTitle}
      onClick={() => {
        if (canPreview) onPreview();
      }}
    >
      {content}
    </button>
  );
}

function NativeDisplayImageBlock(props: {
  payload: NonNullable<ReturnType<typeof getNativeDisplayImagePayload>>;
  readOnly?: boolean;
}) {
  const { payload, readOnly = false } = props;
  const { t } = useLocale();
  const isGallery = payload.entries.length > 1;
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const imageSources = useNativeDisplayImageSources(payload.entries);
  const slides = useMemo<ImagePreviewSlide[]>(
    () =>
      payload.entries.map((_entry, index) => ({
        src: imageSources[index]?.src ?? "",
        alt: formatDisplayImageLabel(t, payload.entries.length, index),
        title: formatDisplayImageLabel(t, payload.entries.length, index),
      })),
    [imageSources, payload.entries, t],
  );

  return (
    <>
      <div className={getNativeImageGridClass(payload.entries.length)}>
        {payload.entries.map((entry, index) => {
          const id = entry.image
            ? `${entry.image.mimeType}-${entry.image.data.length}-${index}`
            : `${entry.detail.sourceUrl ?? entry.detail.path}-${index}`;
          const slide = slides[index];
          const alt = slide?.alt ?? formatDisplayImageLabel(t, payload.entries.length, index);
          const isSvgImage = isSvgDisplayImageEntry(entry);
          return (
            <NativeDisplayImageTile
              key={id}
              source={imageSources[index] ?? { src: "", status: "loading" }}
              alt={alt}
              isGallery={isGallery}
              isSvgImage={isSvgImage}
              loading={isGallery ? "eager" : "lazy"}
              onPreview={() => setPreviewIndex(index)}
              readOnly={readOnly}
            />
          );
        })}
      </div>
      {previewIndex !== null ? (
        <ImagePreview
          open={previewIndex !== null}
          slides={slides}
          index={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}
    </>
  );
}

function extractReadBody(text: string) {
  const marker = text.indexOf("\n\n");
  return marker >= 0 ? text.slice(marker + 2) : text;
}

function CodePreview(props: { text: string; maxChars?: number }) {
  const { text, maxChars = 4000 } = props;
  if (!/\S/.test(text)) return null;
  return (
    <ToolScrollablePre className="max-h-56 bg-black/[0.02] dark:bg-white/[0.03]">
      {previewText(text, maxChars)}
    </ToolScrollablePre>
  );
}

// Render-layer tolerance for historical messages: current details carry
// `scope` ("workspace" | "skill" | "external"), while old sessions may still
// carry the legacy `root` ("workspace" | "skills") or unknown scope values
// such as "temp"/"artifact". Degrade at the read site — unknown values are
// displayed verbatim; "workspace" (the default) is hidden.
function resolveFileToolScope(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  const scope =
    typeof record.scope === "string" && record.scope.trim() ? record.scope.trim() : undefined;
  const legacyRoot =
    typeof record.root === "string" && record.root.trim() ? record.root.trim() : undefined;
  const resolved = scope ?? (legacyRoot === "skills" ? "skill" : legacyRoot);
  return resolved && resolved !== "workspace" ? resolved : undefined;
}

function fileScopeTags(details: unknown): MetaTag[] {
  const scope = resolveFileToolScope(details);
  return scope ? [{ label: "scope", value: scope }] : [];
}

function ToolResultDisplay({
  item,
  result,
  readOnly = false,
}: {
  item: ToolTraceItem;
  result: ToolResultMessage;
  readOnly?: boolean;
}) {
  const kind = getBuiltinResultKind(result);
  const text = extractResultText(result);
  const images = getToolResultImages(result);
  const shellDetails = isShellResultDetails(result.details) ? result.details : null;

  if (item.toolCall.name === "Bash") {
    if (!shellDetails) return null;

    return (
      <ToolSurface>
        <MetaTags
          tags={[
            { label: "shell", value: shellDetails.shell || "unknown" },
            { label: "exit", value: String(shellDetails.exit_code) },
            { label: "duration", value: `${shellDetails.duration_ms} ms` },
            ...(typeof shellDetails.effective_timeout_ms === "number"
              ? [{ label: "timeout_ms", value: `${shellDetails.effective_timeout_ms}` }]
              : []),
            {
              label: "stdout",
              value: summarizeShellStream(shellDetails.stdout, shellDetails.stdout_truncated),
            },
            {
              label: "stderr",
              value: summarizeShellStream(shellDetails.stderr, shellDetails.stderr_truncated),
            },
            ...(shellDetails.timed_out ? [{ label: "timeout", value: "true" }] : []),
            ...(shellDetails.cancelled ? [{ label: "cancelled", value: "true" }] : []),
          ]}
        />
      </ToolSurface>
    );
  }

  if (kind === "read_text") {
    const details = result.details as ReadTextResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...fileScopeTags(details),
              {
                label: "lines",
                value:
                  details.numLines > 0
                    ? `${details.startLine}-${details.startLine + details.numLines - 1}/${details.totalLines}`
                    : `empty/${details.totalLines}`,
              },
              { label: "view", value: details.isPartialView ? "partial" : "full" },
              ...(details.truncated ? [{ label: "truncated", value: "true" }] : []),
              ...(details.reusedExisting ? [{ label: "cache", value: "unchanged" }] : []),
            ]}
          />
        </ToolSurface>
        {!details.reusedExisting ? (
          <CodePreview text={extractReadBody(text)} maxChars={8000} />
        ) : null}
      </div>
    );
  }

  if (kind === "read_skill") {
    const details = result.details as SkillsManagerResultDetails;
    if (details.kind !== "read_skill") return null;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              {
                label: "lines",
                value:
                  details.numLines > 0
                    ? `${details.startLine}-${details.startLine + details.numLines - 1}`
                    : `empty @ ${details.startLine}`,
              },
              ...(details.truncated ? [{ label: "truncated", value: "true" }] : []),
            ]}
          />
        </ToolSurface>
        <CodePreview text={extractReadBody(text)} maxChars={8000} />
      </div>
    );
  }

  if (kind === "manage_skill") {
    const details = result.details as Extract<SkillsManagerResultDetails, { kind: "manage_skill" }>;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              { label: "action", value: details.action },
              { label: "root", value: details.rootDir },
              ...(typeof details.skillsCount === "number"
                ? [{ label: "skills", value: String(details.skillsCount) }]
                : []),
              ...(typeof details.installedCount === "number"
                ? [{ label: "installed", value: String(details.installedCount) }]
                : []),
              ...(details.createdName ? [{ label: "created", value: details.createdName }] : []),
              ...(typeof details.clawhubResultCount === "number"
                ? [{ label: "clawhub", value: String(details.clawhubResultCount) }]
                : []),
              ...(details.clawhubSlug ? [{ label: "slug", value: details.clawhubSlug }] : []),
              ...(typeof details.validationOk === "boolean"
                ? [{ label: "valid", value: details.validationOk ? "true" : "false" }]
                : []),
              ...(details.packageArchive
                ? [{ label: "archive", value: details.packageArchive }]
                : []),
              ...(details.clawhubNextCursor
                ? [{ label: "cursor", value: details.clawhubNextCursor }]
                : []),
              ...(typeof details.invalidCount === "number" && details.invalidCount > 0
                ? [{ label: "invalid", value: String(details.invalidCount) }]
                : []),
              ...(details.backup ? [{ label: "backup", value: details.backup }] : []),
            ]}
          />
        </ToolSurface>
        <CodePreview text={text} maxChars={8000} />
      </div>
    );
  }

  if (kind === "manage_mcp") {
    const details = result.details as McpManagerResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              { label: "action", value: details.action },
              ...(details.serverId ? [{ label: "server", value: details.serverId }] : []),
              ...(details.transport ? [{ label: "transport", value: details.transport }] : []),
              ...(typeof details.ok === "boolean"
                ? [{ label: "ok", value: details.ok ? "true" : "false" }]
                : []),
              ...(details.phase ? [{ label: "phase", value: details.phase }] : []),
              ...(typeof details.serverCount === "number"
                ? [{ label: "servers", value: String(details.serverCount) }]
                : []),
              ...(typeof details.enabledCount === "number"
                ? [{ label: "enabled", value: String(details.enabledCount) }]
                : []),
              ...(typeof details.toolsCount === "number"
                ? [{ label: "tools", value: String(details.toolsCount) }]
                : []),
              ...(typeof details.changed === "boolean"
                ? [{ label: "changed", value: details.changed ? "true" : "false" }]
                : []),
              ...(typeof details.stopped === "boolean"
                ? [{ label: "stopped", value: details.stopped ? "true" : "false" }]
                : []),
            ]}
          />
        </ToolSurface>
        <CodePreview text={text} maxChars={8000} />
      </div>
    );
  }

  if (kind === "read_image") {
    const details = result.details as ReadImageResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...fileScopeTags(details),
              { label: "mime", value: details.mimeType },
              { label: "size", value: `${details.sizeBytes} bytes` },
              ...(details.reusedExisting ? [{ label: "cache", value: "unchanged" }] : []),
            ]}
          />
        </ToolSurface>
        {!details.reusedExisting && images.length > 0 ? (
          <div className="overflow-hidden rounded-[10px] border border-black/[0.06] bg-white/[0.55] p-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
            {images.map((image, index) => (
              <ToolResultImagePreview
                key={`${details.path}-${index}`}
                id={`${details.path}-${index}`}
                image={image}
                alt={details.path}
                sizeBytes={details.sizeBytes}
                readOnly={readOnly}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (kind === "read_pdf") {
    const details = result.details as ReadPdfResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...fileScopeTags(details),
              {
                label: "pages",
                value:
                  details.numPages > 0
                    ? `${details.pageStart}-${details.pageStart + details.numPages - 1}/${details.totalPages}`
                    : `empty/${details.totalPages}`,
              },
              ...(details.truncated ? [{ label: "truncated", value: "true" }] : []),
              ...(details.reusedExisting ? [{ label: "cache", value: "unchanged" }] : []),
            ]}
          />
        </ToolSurface>
        {!details.reusedExisting ? (
          <CodePreview text={extractReadBody(text)} maxChars={8000} />
        ) : null}
      </div>
    );
  }

  if (kind === "read_notebook") {
    const details = result.details as ReadNotebookResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...fileScopeTags(details),
              {
                label: "cells",
                value:
                  details.numCells > 0
                    ? `${details.cellStart}-${details.cellStart + details.numCells - 1}/${details.totalCells}`
                    : `empty/${details.totalCells}`,
              },
              ...(details.truncated ? [{ label: "truncated", value: "true" }] : []),
              ...(details.reusedExisting ? [{ label: "cache", value: "unchanged" }] : []),
            ]}
          />
        </ToolSurface>
        {!details.reusedExisting ? (
          <CodePreview text={extractReadBody(text)} maxChars={8000} />
        ) : null}
      </div>
    );
  }

  if (kind === "read_word" || kind === "read_spreadsheet" || kind === "read_archive") {
    const details = result.details as ReadDocumentResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...fileScopeTags(details),
              ...(details.mimeType ? [{ label: "mime", value: details.mimeType }] : []),
              ...(typeof details.sizeBytes === "number"
                ? [{ label: "size", value: `${details.sizeBytes} bytes` }]
                : []),
              ...(details.truncated ? [{ label: "truncated", value: "true" }] : []),
              ...(details.reusedExisting ? [{ label: "cache", value: "unchanged" }] : []),
            ]}
          />
        </ToolSurface>
        {!details.reusedExisting ? (
          <CodePreview text={extractReadBody(text)} maxChars={8000} />
        ) : null}
      </div>
    );
  }

  if (kind === "write") {
    const details = result.details as WriteResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...fileScopeTags(details),
              { label: "target", value: details.existedBefore ? "existing" : "new" },
              { label: "bytes", value: String(details.bytesWritten) },
              { label: "lines", value: String(details.totalLines) },
            ]}
          />
        </ToolSurface>
        <CodePreview text={details.preview} />
      </div>
    );
  }

  if (kind === "edit") {
    const details = result.details as EditResultDetails;
    return (
      <EditDiffView
        beforeText={details.oldPreview}
        afterText={details.newPreview}
        filePath={
          details.displayPath ||
          (resolveFileToolScope(details) === "skill" ? `skills:${details.path}` : details.path)
        }
      />
    );
  }

  if (kind === "delete") {
    const details = result.details as DeleteResultDetails;
    return (
      <ToolSurface>
        <MetaTags
          tags={[...fileScopeTags(details), { label: "kind", value: details.targetKind }]}
        />
      </ToolSurface>
    );
  }

  if (kind === "list") {
    const details = result.details as ListResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={buildPagedResultTags({
              label: "items",
              returned: details.entries.length,
              total: details.total,
              offset: details.offset,
              hasMore: details.hasMore,
            }).concat(fileScopeTags(details))}
          />
        </ToolSurface>
        <ToolSurface className="max-h-56 overflow-auto">
          <div className="space-y-1">
            {details.entries.map((entry) => (
              <div
                key={`${entry.kind}-${entry.path}`}
                className="flex items-start gap-2 rounded-[8px] px-1.5 py-1 text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] even:bg-black/[0.02] dark:even:bg-white/[0.03]"
              >
                <span className="mt-[1px] shrink-0 text-[calc(10px*var(--zone-font-scale,1))] font-semibold uppercase text-muted-foreground/35">
                  {entry.kind}
                </span>
                <PathDisplay
                  path={entry.path}
                  className="min-w-0 break-all font-mono text-[calc(11px*var(--zone-font-scale,1))]"
                />
              </div>
            ))}
          </div>
        </ToolSurface>
      </div>
    );
  }

  if (kind === "glob") {
    const details = result.details as GlobResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={buildPagedResultTags({
              label: "matches",
              returned: details.paths.length,
              total: details.total,
              offset: details.offset,
              hasMore: details.hasMore,
            }).concat(fileScopeTags(details))}
          />
        </ToolSurface>
        <ToolSurface className="max-h-56 overflow-auto">
          <div className="space-y-1">
            {details.paths.map((entry) => (
              <PathDisplay
                key={entry}
                path={entry}
                className="block rounded-[8px] px-1.5 py-1 break-all font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5] even:bg-black/[0.02] dark:even:bg-white/[0.03]"
              />
            ))}
          </div>
        </ToolSurface>
      </div>
    );
  }

  if (kind === "grep") {
    const details = result.details as GrepResultDetails;
    return (
      <div className="space-y-2">
        <ToolSurface>
          <MetaTags
            tags={[
              ...fileScopeTags(details),
              { label: "mode", value: details.outputMode },
              { label: "matches", value: String(details.matchCount) },
              { label: "files", value: String(details.fileCount) },
              ...(details.offset > 0 ? [{ label: "offset", value: String(details.offset) }] : []),
              { label: "state", value: details.hasMore ? "partial" : "complete" },
            ]}
          />
        </ToolSurface>
        {details.outputMode === "count" ? null : details.outputMode === "files" ? (
          <ToolSurface className="max-h-56 overflow-auto">
            <div className="space-y-1.5">
              {details.files.map((file) => (
                <div
                  key={file.path}
                  className="space-y-1 rounded-[8px] px-1.5 py-1 even:bg-black/[0.02] dark:even:bg-white/[0.03]"
                >
                  <PathDisplay
                    path={file.path}
                    className="block break-all font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5]"
                  />
                  <MetaTags
                    tags={[
                      { label: "count", value: String(file.count) },
                      ...(typeof file.firstLine === "number"
                        ? [{ label: "first", value: String(file.firstLine) }]
                        : []),
                    ]}
                  />
                </div>
              ))}
            </div>
          </ToolSurface>
        ) : (
          <ToolSurface className="max-h-64 overflow-auto space-y-2">
            {details.matches.map((match, index) => (
              <div
                key={`${match.path}:${match.line}:${index}`}
                className="rounded-[8px] border border-black/[0.05] bg-white/[0.55] p-2 dark:border-white/[0.06] dark:bg-white/[0.03]"
              >
                <div className="flex items-start gap-2">
                  <PathDisplay
                    path={match.path}
                    className="min-w-0 break-all font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-[1.5]"
                  />
                  <span className="shrink-0 rounded bg-black/[0.04] px-1.5 py-[1px] text-[calc(10px*var(--zone-font-scale,1))] font-semibold text-muted-foreground/60 dark:bg-white/[0.05]">
                    line {match.line}
                  </span>
                </div>
                {match.before.length > 0 ? (
                  <CodePreview text={match.before.join("\n")} maxChars={1500} />
                ) : null}
                <CodePreview text={match.text} maxChars={1500} />
                {match.after.length > 0 ? (
                  <CodePreview text={match.after.join("\n")} maxChars={1500} />
                ) : null}
              </div>
            ))}
          </ToolSurface>
        )}
      </div>
    );
  }

  if (kind === "subagent_batch") {
    const details = result.details as SubagentBatchDetails;
    if (details.status !== "rejected" && result.isError !== true) {
      // The successful parent batch is rendered as per-agent cards.
      return null;
    }
    const issues = details.issues ?? [];
    return (
      <ToolSurface className="space-y-2">
        <MetaTags
          tags={[
            { label: "agent", value: "rejected" },
            { label: "issues", value: String(issues.length) },
          ]}
        />
        <div className="text-[calc(12px*var(--zone-font-scale,1))] font-semibold leading-[1.45] text-foreground/90">
          Agent call rejected — no subagents were started
        </div>
        {issues.length > 0 ? (
          <CodePreview
            text={issues
              .map(
                (item, index) =>
                  `${index + 1}. [${item.code}]${item.agentId ? ` agent=${item.agentId}` : ""} ${item.message}`,
              )
              .join("\n")}
            maxChars={2400}
          />
        ) : (
          <CodePreview
            text={result.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("\n")}
            maxChars={2400}
          />
        )}
      </ToolSurface>
    );
  }

  if (kind === "subagent_card") {
    const details = result.details as SubagentCardDetails;
    const agent = details.agent;
    const agentDisplayName = agent.name || agent.id;
    const agentTask = getSubagentTask(agent);
    const tags: MetaTag[] = [
      { label: "agent", value: `${details.index + 1}/${details.total}` },
      { label: "status", value: agent.status },
    ];
    if (agent.mode === "worktree") {
      tags.push({ label: "mode", value: agent.mode });
    }
    if (shouldShowSubagentApplyStatus(agent) && agent.applyStatus) {
      tags.push({ label: "apply", value: agent.applyStatus });
    }
    if (shouldShowSubagentCleanupStatus(agent) && agent.worktreeCleanupStatus) {
      tags.push({ label: "cleanup", value: agent.worktreeCleanupStatus });
    }

    const untrackedFiles = agent.untrackedFiles ?? [];
    const candidateArtifacts = agent.candidateArtifacts ?? [];
    const showUntrackedFiles = agent.applyStatus !== "applied" && untrackedFiles.length > 0;
    const showCandidateArtifacts = Boolean(
      candidateArtifacts.length > 0 &&
        agent.applySkippedReason &&
        agent.applySkippedReason !== "no_changes",
    );

    return (
      <ToolSurface className="space-y-2">
        <MetaTags tags={tags} />
        <div className="space-y-2">
          <div className="text-[calc(12px*var(--zone-font-scale,1))] font-semibold leading-[1.45] text-foreground/90">
            {agentDisplayName}
          </div>
          {agent.role ? (
            <div className="text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-[1.55] text-foreground/78">
              <span className="text-muted-foreground">role</span> {agent.role}
            </div>
          ) : null}
          {agentTask ? (
            <div className="break-words text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-[1.6] text-foreground/80">
              <span className="text-muted-foreground">task</span> {agentTask}
            </div>
          ) : null}
          {shouldShowSubagentWorktreeLocation(agent) ? (
            <div className="break-all text-[calc(10px*var(--zone-font-scale,1))] text-muted-foreground/70">
              {agent.branchName ? `${agent.branchName} | ` : ""}
              {agent.worktreeRoot}
            </div>
          ) : null}
          {agent.diffStat ? <CodePreview text={agent.diffStat} maxChars={1200} /> : null}
          {showUntrackedFiles ? (
            <CodePreview
              text={`untracked:\n${untrackedFiles.map((file) => `- ${file}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.worktreeStatusError ? (
            <CodePreview text={agent.worktreeStatusError} maxChars={1200} />
          ) : null}
          {agent.applyError ? (
            <CodePreview text={`apply failed:\n${agent.applyError}`} maxChars={1200} />
          ) : agent.applySkippedReason && agent.applySkippedReason !== "no_changes" ? (
            <CodePreview text={`apply skipped: ${agent.applySkippedReason}`} maxChars={1200} />
          ) : null}
          {agent.applyFallbackReason ? (
            <CodePreview text={`fallback reason:\n${agent.applyFallbackReason}`} maxChars={1200} />
          ) : null}
          {agent.applyCopiedFiles && agent.applyCopiedFiles.length > 0 ? (
            <CodePreview
              text={`copied:\n${agent.applyCopiedFiles.map((file) => `- ${file}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.applyDeletedFiles && agent.applyDeletedFiles.length > 0 ? (
            <CodePreview
              text={`deleted:\n${agent.applyDeletedFiles.map((file) => `- ${file}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.applyConflictFiles && agent.applyConflictFiles.length > 0 ? (
            <CodePreview
              text={`apply conflicts:\n${agent.applyConflictFiles.map((file) => `- ${file}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.worktreeCleanupError ? (
            <CodePreview
              text={`worktree cleanup failed:\n${agent.worktreeCleanupError}`}
              maxChars={1200}
            />
          ) : agent.worktreeCleanupReason && agent.worktreeCleanupStatus === "retained" ? (
            <CodePreview
              text={`worktree retained: ${agent.worktreeCleanupReason}`}
              maxChars={1200}
            />
          ) : null}
          {showCandidateArtifacts ? (
            <CodePreview
              text={`candidate artifacts:\n${candidateArtifacts.map((file) => `- ${file}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.persistenceWarnings && agent.persistenceWarnings.length > 0 ? (
            <CodePreview
              text={`persistence warning:\n${agent.persistenceWarnings.map((item) => `- ${item}`).join("\n")}`}
              maxChars={1200}
            />
          ) : null}
          {agent.error ? (
            <CodePreview text={agent.error} maxChars={1200} />
          ) : agent.summary ? (
            <CodePreview text={agent.summary} maxChars={2400} />
          ) : null}
        </div>
      </ToolSurface>
    );
  }

  if (kind === "subagent_message") {
    const details = result.details as SubagentMessageDetails;
    const from = details.senderName || details.senderId;
    const to = details.recipientName || details.recipientId;
    return (
      <ToolSurface className="space-y-2">
        <MetaTags
          tags={[
            { label: "seq", value: String(details.seq) },
            { label: "channel", value: details.channel },
            { label: "from", value: from },
            { label: "to", value: to },
          ]}
        />
        {details.subject ? (
          <div className="break-words text-[calc(11.5px*var(--zone-font-scale,1))] font-semibold leading-[1.5] text-foreground/86">
            {details.subject}
          </div>
        ) : null}
        {details.bodyPreview ? (
          <div className="rounded-[8px] border border-black/[0.05] bg-white/[0.45] px-2.5 py-2 text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6] dark:border-white/[0.07] dark:bg-white/[0.03]">
            <Markdown content={details.bodyPreview} />
          </div>
        ) : null}
      </ToolSurface>
    );
  }

  if (images.length > 0) {
    return (
      <div className="space-y-2">
        <div className="overflow-hidden rounded-[10px] border border-black/[0.06] bg-white/[0.55] p-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
          {images.map((image, index) => (
            <ToolResultImagePreview
              key={`${item.toolCall.id}-${index}`}
              id={`${item.toolCall.id}-${index}`}
              image={image}
              alt={item.toolCall.name}
              readOnly={readOnly}
            />
          ))}
        </div>
        {/\S/.test(text) ? <CodePreview text={text} maxChars={3000} /> : null}
      </div>
    );
  }

  if (result.details && typeof result.details === "object") {
    return (
      <ToolSurface className="overflow-hidden px-0 py-0">
        <ToolScrollablePre className="max-h-32 rounded-none">
          {safeStringify(result.details)}
        </ToolScrollablePre>
      </ToolSurface>
    );
  }

  return null;
}

function isBuiltinShareToolName(name: string) {
  const trimmed = name.trim();
  if (trimmed.startsWith("mcp_")) {
    return true;
  }
  return [
    "Agent",
    "Bash",
    "CronTaskManager",
    "Delete",
    "Edit",
    "Glob",
    "Grep",
    "HttpGetTest",
    "Image",
    "List",
    "ManagedProcess",
    "McpManager",
    "MemoryManager",
    "Read",
    "SkillsManager",
    "SSHManager",
    "SshManager",
    "TunnelManager",
    "Write",
  ].includes(trimmed);
}

function ToolCallItem({
  item,
  isRunning,
  variant = "standalone",
  readOnly = false,
  redactToolContent = false,
}: {
  item: ToolTraceItem;
  isRunning?: boolean;
  variant?: "standalone" | "grouped";
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const { t } = useLocale();
  const result = item.toolResult;
  const builtinResultKind = getBuiltinResultKind(result);
  const isRedactedToolContent = redactToolContent && isBuiltinShareToolName(item.toolCall.name);
  const shouldAutoOpen =
    !isRedactedToolContent &&
    (item.toolCall.name === "Image" || builtinResultKind === "display_image");
  const [open, setOpen] = useState(readOnly || isRedactedToolContent ? false : shouldAutoOpen);
  const isSubagentCard = isSubagentCardToolCall(item.toolCall);
  const hasArgs = Object.keys(item.toolCall.arguments || {}).length > 0;
  const isStreamingFilePreviewTool = FILE_TOOL_TEXT_FIELDS[item.toolCall.name] !== undefined;
  const shouldShowArgs =
    !isRedactedToolContent &&
    (!isSubagentCard || !result) &&
    (isStreamingFilePreviewTool ? !result : hasArgs);
  const isBash = item.toolCall.name === "Bash";
  const isManagedProcess = item.toolCall.name === "ManagedProcess";
  const inlineCommand =
    !isRedactedToolContent &&
    (isBash || isManagedProcess) &&
    typeof item.toolCall.arguments?.command === "string"
      ? item.toolCall.arguments.command.trim()
      : "";
  const firstLine = inlineCommand ? inlineCommand.split("\n")[0] : "";
  const toolArgsSummary =
    isRedactedToolContent || isBash || inlineCommand
      ? ""
      : isSubagentCard
        ? getSubagentInlineSummary(item)
        : summarizeToolCall(item.toolCall, {
            includeName: false,
            includeManagerAction: false,
          });
  const fileChangeStats = useMemo(
    () => (isRedactedToolContent ? undefined : deriveFileChangeStats(item.toolCall)),
    [isRedactedToolContent, item.toolCall],
  );
  const meta = getToolMeta(item.toolCall.name);
  const ToolIcon = meta.Icon;
  const title = isRedactedToolContent
    ? { name: getToolDisplayName(item.toolCall.name), action: "" }
    : getToolDisplayTitle(item.toolCall);

  const dotClass = isRunning
    ? "bg-[hsl(var(--chat-running))] animate-pulse"
    : result
      ? result.isError
        ? "bg-[hsl(var(--chat-error))]"
        : "bg-[hsl(var(--chat-success))]"
      : "bg-zinc-400";

  const statusLabel = isRunning
    ? t("chat.tool.running")
    : result
      ? result.isError
        ? t("chat.tool.failed")
        : t("chat.tool.success")
      : t("chat.tool.waiting");

  const statusBgClass = isRunning
    ? "bg-[hsl(var(--chat-running)/0.1)] text-[hsl(var(--chat-running))]"
    : result
      ? result.isError
        ? "bg-[hsl(var(--chat-error)/0.1)] text-[hsl(var(--chat-error))]"
        : "bg-[hsl(var(--chat-success)/0.1)] text-[hsl(var(--chat-success))]"
      : "bg-black/[0.05] text-muted-foreground dark:bg-white/[0.08]";

  useEffect(() => {
    if (!readOnly && !isRedactedToolContent && shouldAutoOpen) {
      setOpen(true);
    }
  }, [isRedactedToolContent, readOnly, shouldAutoOpen]);

  const canExpand = !isRedactedToolContent;
  const effectiveOpen = canExpand && open;
  const summaryClassName = cn(
    "flex select-none items-center gap-2",
    canExpand
      ? "cursor-pointer hover:bg-black/[0.015] dark:hover:bg-white/[0.025]"
      : "cursor-default",
    variant === "grouped" ? "px-2 py-[6px]" : "px-2.5 py-[7px]",
  );
  const summaryContent = (
    <>
      <div
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]"
        style={{
          background: `linear-gradient(135deg, hsl(${meta.accent} / 0.13), hsl(${meta.accent} / 0.06))`,
        }}
      >
        <ToolIcon className="h-3 w-3" style={{ color: `hsl(${meta.accent})` }} />
      </div>

      {/* Tool name + inline summary on same line. Name and summary must stay in
          one inline context (shared baseline): centering them as separate flex
          boxes drifts up to ~1.5px per device with the resolved font metrics. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {/* Container carries the summary styling so the truncation ellipsis
            (styled per the block container) matches the summary text */}
        <div
          className="min-w-0 truncate font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-5 text-muted-foreground/55"
          title={!isBash && !inlineCommand && toolArgsSummary ? toolArgsSummary : undefined}
        >
          <span className="font-sans text-[calc(12.5px*var(--zone-font-scale,1))] font-semibold tracking-[-0.01em] text-foreground/90">
            {title.name}
            {title.action ? (
              <span className="font-mono font-semibold text-muted-foreground/70">
                {" · "}
                {title.action}
              </span>
            ) : null}
          </span>

          {firstLine ? (
            <span className="ml-1.5">
              <span className="text-muted-foreground/30">$</span>{" "}
              {firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine}
            </span>
          ) : toolArgsSummary ? (
            <span className="ml-1.5">{toolArgsSummary}</span>
          ) : null}
        </div>

        {fileChangeStats ? (
          <FileChangeBadge added={fileChangeStats.added} removed={fileChangeStats.removed} />
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotClass)} />
        <span
          className={cn(
            "inline-flex items-center rounded-full px-1.5 py-[1px] text-[calc(10px*var(--zone-font-scale,1))] font-semibold",
            statusBgClass,
          )}
        >
          {statusLabel}
        </span>
        {canExpand ? (
          <ChevronRight className="h-3 w-3 text-muted-foreground/35 transition-transform duration-200 ease-out group-open/tool:rotate-90" />
        ) : null}
      </div>
    </>
  );
  const body = effectiveOpen ? (
    <div className="space-y-3 border-t border-black/[0.04] px-2.5 py-2.5 dark:border-white/[0.05]">
      {shouldShowArgs ? (
        <ToolSection label={isBash || inlineCommand ? t("chat.tool.command") : t("chat.tool.args")}>
          <ToolArgsDisplay item={item} />
        </ToolSection>
      ) : null}

      {result ? (
        <ToolSection
          label={t("chat.tool.return")}
          trailing={
            result.isError ? (
              <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-[1px] text-[calc(10px*var(--zone-font-scale,1))] font-bold text-red-500 dark:bg-red-500/15">
                {t("chat.tool.error")}
              </span>
            ) : null
          }
        >
          <div className="space-y-1.5">
            <ToolResultDisplay item={item} result={result} readOnly={readOnly} />

            {(() => {
              const resultText = toolResultMessageToText(result);
              if (!/\S/.test(resultText)) return null;
              if (builtinResultKind && builtinResultKind !== "read_image") return null;

              if (isBash || readOnly) {
                return (
                  <ToolScrollablePre
                    className={cn(
                      "max-h-56",
                      isBash
                        ? "bg-zinc-950/85 text-zinc-300/90 shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] dark:bg-zinc-900/80"
                        : "bg-black/[0.02] dark:bg-white/[0.03]",
                    )}
                  >
                    {previewText(resultText, 6000)}
                  </ToolScrollablePre>
                );
              }

              return (
                <details className="group/result">
                  <summary className="flex cursor-pointer select-none items-center gap-1 text-[calc(10.5px*var(--zone-font-scale,1))] text-muted-foreground/50 transition-colors duration-150 hover:text-foreground/60">
                    <ChevronRight className="h-2.5 w-2.5 transition-transform duration-200 group-open/result:rotate-90" />
                    {t("chat.tool.viewReturn")}
                  </summary>
                  <ToolScrollablePre className="mt-1.5 max-h-56 bg-black/[0.02] dark:bg-white/[0.03]">
                    {previewText(resultText, 6000)}
                  </ToolScrollablePre>
                </details>
              );
            })()}
          </div>
        </ToolSection>
      ) : null}
    </div>
  ) : null;
  const containerClassName = cn(
    "group/tool overflow-hidden",
    variant === "grouped" ? "tool-card-grouped rounded-[10px]" : "tool-card-enter rounded-[12px]",
    "border border-black/[0.06] bg-white/[0.72] backdrop-blur-xl backdrop-saturate-[1.8]",
    variant === "grouped"
      ? "shadow-none"
      : [
          "shadow-[0_0_0_0.5px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.02)]",
          "transition-shadow duration-200",
          !readOnly &&
            "hover:shadow-[0_0_0_0.5px_rgba(0,0,0,0.04),0_1px_3px_rgba(0,0,0,0.05),0_4px_14px_rgba(0,0,0,0.04)]",
        ],
    "dark:border-white/[0.1] dark:bg-white/[0.06] dark:backdrop-saturate-[1.4]",
    variant === "grouped"
      ? "dark:shadow-none"
      : [
          "dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.2),0_3px_8px_rgba(0,0,0,0.12)]",
          !readOnly &&
            "dark:hover:shadow-[0_0_0_0.5px_rgba(255,255,255,0.06),0_1px_3px_rgba(0,0,0,0.25),0_4px_14px_rgba(0,0,0,0.18)]",
        ],
  );

  if (!canExpand) {
    return (
      <div className={containerClassName}>
        <div className={summaryClassName}>{summaryContent}</div>
      </div>
    );
  }

  return (
    <details
      open={effectiveOpen}
      className={containerClassName}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className={summaryClassName}>{summaryContent}</summary>
      {body}
    </details>
  );
}

function areToolResultsEqual(
  previous: ToolResultMessage | undefined,
  next: ToolResultMessage | undefined,
) {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }

  return (
    previous.toolCallId === next.toolCallId &&
    previous.toolName === next.toolName &&
    previous.isError === next.isError &&
    areStableValuesEqual(previous.content, next.content) &&
    areStableValuesEqual(previous.details, next.details)
  );
}

function areToolTraceItemsEqual(previous: ToolTraceItem, next: ToolTraceItem) {
  if (previous === next) {
    return true;
  }
  return (
    previous.toolCall.id === next.toolCall.id &&
    previous.toolCall.name === next.toolCall.name &&
    areStableValuesEqual(previous.toolCall.arguments, next.toolCall.arguments) &&
    areToolResultsEqual(previous.toolResult, next.toolResult)
  );
}

const MemoToolCallItem = memo(
  ToolCallItem,
  (previousProps, nextProps) =>
    previousProps.isRunning === nextProps.isRunning &&
    previousProps.variant === nextProps.variant &&
    previousProps.readOnly === nextProps.readOnly &&
    previousProps.redactToolContent === nextProps.redactToolContent &&
    areToolTraceItemsEqual(previousProps.item, nextProps.item),
);

function ToolTraceGroup(props: {
  items: ToolTraceItem[];
  runningToolCallIds?: string[];
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const { items, runningToolCallIds = [], readOnly = false, redactToolContent = false } = props;
  const { t } = useLocale();
  const counts = useMemo(
    () => getToolGroupCounts(items, runningToolCallIds),
    [items, runningToolCallIds],
  );
  const composition = useMemo(() => getToolGroupComposition(items), [items]);
  const dominantToolName = useMemo(() => getDominantToolName(items), [items]);
  const allBash = useMemo(() => items.every((item) => item.toolCall.name === "Bash"), [items]);
  const meta = useMemo(
    () => (allBash ? getToolMeta("Bash") : getToolMeta(dominantToolName)),
    [allBash, dominantToolName],
  );
  const ToolIcon = allBash ? Terminal : meta.Icon;
  const shouldAutoOpen = counts.failed > 0 || (counts.running > 0 && items.length <= 3);
  // Auto-collapse is state-driven, not remount-driven: the live article keeps
  // its instance mounted after the run settles (folding only happens at the
  // next run_started), so the group must fold itself once every call has a
  // non-error result. Failed groups stay open (mirroring auto-open);
  // `waiting` keeps groups whose results never landed (e.g. aborted runs)
  // untouched.
  const shouldAutoClose = counts.running === 0 && counts.waiting === 0 && counts.failed === 0;
  const [open, setOpen] = useState(readOnly ? false : shouldAutoOpen);
  const userInteractedRef = useRef(false);

  useEffect(() => {
    if (readOnly || userInteractedRef.current) return;
    if (shouldAutoOpen) {
      setOpen(true);
    } else if (shouldAutoClose) {
      setOpen(false);
    }
  }, [readOnly, shouldAutoOpen, shouldAutoClose]);

  const statusLabel =
    counts.failed > 0
      ? `${counts.failed} ${t("chat.tool.failed")}`
      : counts.running > 0
        ? `${counts.running} ${t("chat.tool.running")}`
        : counts.waiting > 0
          ? `${counts.waiting} ${t("chat.tool.waiting")}`
          : t("chat.tool.success");

  const statusBgClass =
    counts.failed > 0
      ? "bg-[hsl(var(--chat-error)/0.1)] text-[hsl(var(--chat-error))]"
      : counts.running > 0
        ? "bg-[hsl(var(--chat-running)/0.1)] text-[hsl(var(--chat-running))]"
        : counts.waiting > 0
          ? "bg-black/[0.05] text-muted-foreground dark:bg-white/[0.08]"
          : "bg-[hsl(var(--chat-success)/0.1)] text-[hsl(var(--chat-success))]";

  const dotClass =
    counts.failed > 0
      ? "bg-[hsl(var(--chat-error))]"
      : counts.running > 0
        ? "bg-[hsl(var(--chat-running))] animate-pulse"
        : counts.waiting > 0
          ? "bg-zinc-400"
          : "bg-[hsl(var(--chat-success))]";

  const countLabel = `${items.length} tools`;
  const title = allBash ? "Bash Batch" : "Tool Activity";

  return (
    <div className="tool-trace-group overflow-hidden rounded-[12px] border border-black/[0.06] bg-white/[0.62] shadow-[0_1px_2px_rgba(0,0,0,0.03)] backdrop-blur-xl backdrop-saturate-[1.6] dark:border-white/[0.1] dark:bg-white/[0.055] dark:shadow-none">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("chat.tool.collapseActivity") : t("chat.tool.expandActivity")}
        className="grid w-full cursor-pointer select-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-black/[0.018] dark:hover:bg-white/[0.025]"
        onClick={() => {
          userInteractedRef.current = true;
          setOpen((prev) => !prev);
        }}
      >
        <div
          className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[7px]"
          style={{
            background: `linear-gradient(135deg, hsl(${meta.accent} / 0.13), hsl(${meta.accent} / 0.06))`,
          }}
        >
          <ToolIcon className="h-3.5 w-3.5" style={{ color: `hsl(${meta.accent})` }} />
        </div>

        <div className="grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2">
          <span className="min-w-0 truncate text-[calc(12.5px*var(--zone-font-scale,1))] font-semibold leading-5 text-foreground/90">
            {title}
          </span>
          <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-black/[0.04] px-1.5 text-[calc(10.5px*var(--zone-font-scale,1))] font-semibold leading-none text-muted-foreground/70 dark:bg-white/[0.06]">
            {countLabel}
          </span>
          {composition ? (
            <span className="inline-flex h-5 min-w-0 items-center truncate font-mono text-[calc(11px*var(--zone-font-scale,1))] leading-none text-muted-foreground/55">
              {composition}
            </span>
          ) : null}
        </div>

        <div className="flex h-5 shrink-0 items-center gap-1.5">
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotClass)} />
          <span
            className={cn(
              "inline-flex h-5 items-center rounded-full px-1.5 text-[calc(10px*var(--zone-font-scale,1))] font-semibold leading-none",
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

      {open ? (
        <div className="tool-trace-group-body space-y-1.5 border-t border-black/[0.04] p-1.5 dark:border-white/[0.05]">
          {items.map((item, index) => (
            <MemoToolCallItem
              key={getToolTraceKey(item, index)}
              item={item}
              variant="grouped"
              readOnly={readOnly}
              redactToolContent={redactToolContent}
              isRunning={Boolean(item.toolCall.id && runningToolCallIds.includes(item.toolCall.id))}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RoundContent(props: {
  round: UiRound;
  showLabel: boolean;
  showUsage?: boolean;
  usageContextWindow?: number;
  isLive?: boolean;
  isStreaming?: boolean;
  isActive?: boolean;
  toolStatus?: string | null;
  toolStatusVariant?: "default" | "compaction";
  runningToolCallIds?: string[];
  thinkingOpen?: boolean;
  renderMode?: "streaming" | "static";
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const {
    round,
    showLabel,
    showUsage,
    usageContextWindow,
    isLive,
    isStreaming = isLive,
    isActive,
    toolStatus,
    toolStatusVariant,
    runningToolCallIds,
    thinkingOpen,
    renderMode,
    readOnly = false,
    redactToolContent = false,
  } = props;
  const groupedBlocks = useMemo(() => groupRoundBlocks(round.blocks), [round.blocks]);
  const hasContent =
    groupedBlocks.some((block) => {
      if (
        block.kind === "tool" ||
        block.kind === "toolGroup" ||
        block.kind === "hostedSearch" ||
        block.kind === "hostedSearchGroup"
      ) {
        return true;
      }
      return block.text.trim().length > 0;
    }) ||
    (isActive && isLive);
  const normalizedToolStatus =
    isActive && isLive ? normalizeLiveToolStatus(toolStatus ?? null) : null;
  const isCompactionStatus = toolStatusVariant === "compaction";
  const isVibingStatus = normalizedToolStatus === VIBING_STATUS;
  const latestThinkingKey = useMemo(() => {
    for (let index = groupedBlocks.length - 1; index >= 0; index -= 1) {
      const block = groupedBlocks[index];
      if (block?.kind === "thinking") return block.key;
    }
    return null;
  }, [groupedBlocks]);
  const autoOpenThinking = isLive ? Boolean(isActive && thinkingOpen) : false;

  if (!hasContent) return null;

  return (
    <div className="space-y-3">
      {showLabel ? <div className="h-px bg-border/40" /> : null}

      {isActive && isLive && normalizedToolStatus ? (
        <div className="flex items-center gap-2 py-1 text-[calc(13px*var(--zone-font-scale,1))]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          {isCompactionStatus ? (
            <CompactingText className="font-medium text-muted-foreground" />
          ) : isVibingStatus ? (
            <VibingText className="font-medium text-muted-foreground" />
          ) : (
            <span className="font-medium text-muted-foreground">{normalizedToolStatus}</span>
          )}
        </div>
      ) : null}

      {groupedBlocks.map((block) => {
        if (block.kind === "thinking") {
          return (
            <ThinkingBlock
              key={block.key}
              text={block.text}
              open={autoOpenThinking && block.key === latestThinkingKey}
            />
          );
        }

        if (block.kind === "tool") {
          const isRedactedToolContent =
            redactToolContent && isBuiltinShareToolName(block.item.toolCall.name);
          const displayImagePayload = getNativeDisplayImagePayload(block.item);
          if (!isRedactedToolContent && displayImagePayload) {
            return (
              <NativeDisplayImageBlock
                key={block.key}
                payload={displayImagePayload}
                readOnly={readOnly}
              />
            );
          }

          if (
            !isRedactedToolContent &&
            block.item.toolCall.name === "Image" &&
            !block.item.toolResult?.isError
          ) {
            return null;
          }

          return (
            <MemoToolCallItem
              key={block.key}
              item={block.item}
              isRunning={Boolean(
                isLive &&
                  block.item.toolCall.id &&
                  (runningToolCallIds || []).includes(block.item.toolCall.id),
              )}
              readOnly={readOnly}
              redactToolContent={redactToolContent}
            />
          );
        }

        if (block.kind === "toolGroup") {
          return (
            <ToolTraceGroup
              key={block.key}
              items={block.items}
              runningToolCallIds={isLive ? (runningToolCallIds ?? []) : []}
              readOnly={readOnly}
              redactToolContent={redactToolContent}
            />
          );
        }

        if (block.kind === "hostedSearch" || block.kind === "hostedSearchGroup") {
          return (
            <HostedSearchGroupView
              key={block.key}
              items={block.kind === "hostedSearch" ? [block.item] : block.items}
              readOnly={readOnly}
            />
          );
        }

        if (!block.text.trim()) return null;

        return (
          <Markdown
            key={block.key}
            content={block.text}
            className="font-openai-chat"
            isAnimating={Boolean(isLive && isActive)}
            renderMode={renderMode}
            showCaret={Boolean(isLive && isActive && isStreaming)}
            readOnly={readOnly}
          />
        );
      })}

      {showUsage ? (
        <UsagePanel usage={round.meta?.usage} contextWindow={usageContextWindow} />
      ) : null}
    </div>
  );
}

export function AssistantBubble(props: {
  rounds: (UiRound & {
    key?: string;
    runningToolCallIds?: string[];
    thinkingOpen?: boolean;
  })[];
  showUsage?: boolean;
  usageContextWindow?: number;
  isLive?: boolean;
  // Whether the stream is actively receiving tokens. Defaults to `isLive` —
  // when the article is in the live snapshot after `done`, set this to `false`
  // so the caret hides while the structural live state (thinking expansion,
  // tool indicators, streaming mode) stays intact and the article does not
  // re-render in static mode.
  isStreaming?: boolean;
  // Fixed Streamdown render mode for every round in this bubble: live-born
  // entries keep "streaming" forever (even after they fold into committed
  // history), history-born entries render "static". Never flips per entry.
  renderMode?: "streaming" | "static";
  toolStatus?: string | null;
  toolStatusVariant?: "default" | "compaction";
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const {
    rounds,
    showUsage,
    usageContextWindow,
    isLive,
    isStreaming = isLive,
    renderMode,
    toolStatus,
    toolStatusVariant,
    readOnly = false,
    redactToolContent = false,
  } = props;
  const showLabels = rounds.length > 1;

  return (
    <div className="assistant-bubble-shell flex w-full max-w-full items-start gap-3">
      <AssistantAvatar className="assistant-bubble-avatar" />
      <div className="assistant-bubble-content min-w-0 flex-1 space-y-3 pt-0.5">
        {rounds.map((round, idx) => (
          <RoundContent
            key={"key" in round && round.key ? round.key : `round-${round.round}`}
            round={round}
            showLabel={showLabels}
            showUsage={showUsage}
            usageContextWindow={usageContextWindow}
            isLive={isLive}
            isStreaming={isStreaming}
            isActive={isLive && idx === rounds.length - 1}
            renderMode={renderMode}
            toolStatus={idx === rounds.length - 1 ? toolStatus : null}
            toolStatusVariant={idx === rounds.length - 1 ? toolStatusVariant : "default"}
            runningToolCallIds={round.runningToolCallIds ?? []}
            thinkingOpen={round.thinkingOpen}
            readOnly={readOnly}
            redactToolContent={redactToolContent}
          />
        ))}
      </div>
    </div>
  );
}
