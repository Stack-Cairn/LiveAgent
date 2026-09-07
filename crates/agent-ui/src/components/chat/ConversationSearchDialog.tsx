import { Clock3, Loader2, MessageSquareText, Pin, Search } from "@liveagent/ui/components/IconSet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type PersistedConversationSearchResult,
  searchPersistedConversations,
} from "@liveagent/ui/lib/chat/conversationSearch";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationOpenOptions } from "../../lib/sidebar/openController";
import type { SidebarConversation } from "../../lib/sidebar/types";

type ConversationSearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: readonly SidebarConversation[];
  currentWorkdir?: string;
  onSelectConversation: (id: string, options?: ConversationOpenOptions) => void;
};

type SearchStatus = "idle" | "loading" | "ready" | "error";

type SearchGroup = {
  id: "pinned" | "recent" | "results";
  label: string;
  icon: typeof Pin;
  items: readonly PersistedConversationSearchResult[];
};

const SEARCH_DEBOUNCE_MS = 180;
const EMPTY_STATE_RECENT_LIMIT = 12;

function toSearchResult(item: SidebarConversation): PersistedConversationSearchResult {
  return {
    id: item.id,
    title: item.title,
    cwd: item.cwd,
    updatedAt: item.updatedAt,
  };
}

function formatUpdatedAt(value: number | undefined, locale: string) {
  if (!value || !Number.isFinite(value)) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function renderSearchPreview(value: string | undefined): ReactNode {
  if (!value) return null;
  const parts = value.split(/(\[[^\]]+\])/g).filter(Boolean);
  return parts.map((part, index) => {
    const highlighted = part.startsWith("[") && part.endsWith("]");
    return highlighted ? (
      <mark
        // The snippet comes from SQLite FTS and has no stable text identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: duplicate text fragments are valid.
        key={index}
        className="rounded-sm bg-primary/10 px-0.5 text-foreground"
      >
        {part.slice(1, -1)}
      </mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: duplicate text fragments are valid.
      <Fragment key={index}>{part}</Fragment>
    );
  });
}

export function ConversationSearchDialog({
  open,
  onOpenChange,
  conversations,
  currentWorkdir,
  onSelectConversation,
}: ConversationSearchDialogProps) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersistedConversationSearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [activeIndex, setActiveIndex] = useState(0);
  const requestSequenceRef = useRef(0);
  const resultsListRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim();

  const performSearch = useCallback(
    async (searchQuery: string) => {
      const requestSequence = ++requestSequenceRef.current;
      setResults([]);
      setStatus("loading");
      try {
        const nextResults = await searchPersistedConversations({
          query: searchQuery,
          currentWorkdir,
        });
        if (requestSequence !== requestSequenceRef.current) return;
        setResults(nextResults);
        setStatus("ready");
      } catch {
        if (requestSequence !== requestSequenceRef.current) return;
        setResults([]);
        setStatus("error");
      }
    },
    [currentWorkdir],
  );

  useEffect(() => {
    if (open) return;
    requestSequenceRef.current += 1;
    setQuery("");
    setResults([]);
    setStatus("idle");
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    if (!open || !normalizedQuery) {
      setResults([]);
      setStatus("idle");
      return;
    }

    setResults([]);
    setStatus("loading");
    const timer = window.setTimeout(() => {
      void performSearch(normalizedQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, open, performSearch]);

  const groups = useMemo<SearchGroup[]>(() => {
    if (normalizedQuery) {
      return [
        {
          id: "results",
          label: t("chat.conversationSearchResults"),
          icon: Search,
          items: results,
        },
      ];
    }

    const pinned = conversations.filter((item) => item.isPinned).map(toSearchResult);
    const recent = conversations
      .filter((item) => !item.isPinned)
      .slice(0, EMPTY_STATE_RECENT_LIMIT)
      .map(toSearchResult);
    return [
      ...(pinned.length > 0
        ? [
            {
              id: "pinned" as const,
              label: t("chat.pinnedConversations"),
              icon: Pin,
              items: pinned,
            },
          ]
        : []),
      {
        id: "recent",
        label: t("chat.recentConversation"),
        icon: Clock3,
        items: recent,
      },
    ];
  }, [conversations, normalizedQuery, results, t]);

  const selectableItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, selectableItems.length - 1)));
  }, [selectableItems.length]);

  useEffect(() => {
    const active = resultsListRef.current?.querySelector<HTMLElement>(
      `[data-conversation-search-index="${activeIndex}"]`,
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const selectConversation = (id: string) => {
    onOpenChange(false);
    const isLocalDraft =
      !normalizedQuery && conversations.some((item) => item.id === id && item.isPending);
    onSelectConversation(id, isLocalDraft ? undefined : { source: "search" });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-conversation-search-dialog=""
        className="flex max-h-[min(640px,calc(100vh-2rem))] max-w-[600px] flex-col overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{t("chat.searchConversations")}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("chat.searchConversationsDescription")}
        </DialogDescription>

        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4">
          {status === "loading" ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <Input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDownCapture={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) =>
                  Math.min(selectableItems.length - 1, Math.max(0, current + 1)),
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => Math.max(0, current - 1));
              } else if (event.key === "Enter") {
                const selected = selectableItems[activeIndex];
                if (selected) {
                  event.preventDefault();
                  selectConversation(selected.id);
                }
              }
            }}
            placeholder={t("chat.searchConversationsPlaceholder")}
            aria-label={t("chat.searchConversations")}
            className="h-auto flex-1 border-0 bg-transparent px-0 text-[15px] shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
          />
          <kbd className="hidden rounded-md border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-flex">
            Esc
          </kbd>
        </div>

        <div
          ref={resultsListRef}
          className="min-h-[220px] flex-1 overflow-y-auto overscroll-contain p-2"
          role="listbox"
        >
          {status === "error" ? (
            <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 px-8 text-center text-sm text-destructive">
              <span>{t("chat.conversationSearchFailed")}</span>
              <button
                type="button"
                onClick={() => void performSearch(normalizedQuery)}
                className="rounded-lg border border-border/70 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("chat.retryConversationSearch")}
              </button>
            </div>
          ) : normalizedQuery && status === "ready" && results.length === 0 ? (
            <div className="flex min-h-[200px] flex-col items-center justify-center px-8 text-center">
              <MessageSquareText className="mb-3 h-8 w-8 text-muted-foreground/35" />
              <div className="text-sm font-medium text-foreground">
                {t("chat.noConversationSearchResults")}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t("chat.searchConversationsDescription")}
              </div>
            </div>
          ) : !normalizedQuery && selectableItems.length === 0 ? (
            <div className="flex min-h-[200px] flex-col items-center justify-center px-8 text-center">
              <Search className="mb-3 h-8 w-8 text-muted-foreground/35" />
              <div className="text-sm text-muted-foreground">
                {t("chat.searchConversationsDescription")}
              </div>
            </div>
          ) : (
            groups.map((group) => {
              if (group.items.length === 0) return null;
              const GroupIcon = group.icon;
              const groupStartIndex = groups
                .slice(0, groups.indexOf(group))
                .reduce((total, item) => total + item.items.length, 0);
              return (
                <fieldset key={group.id} className="m-0 border-0 p-0 pb-2 last:pb-0">
                  <legend className="sr-only">{group.label}</legend>
                  <div className="flex h-8 items-center gap-2 px-2 text-[11px] font-medium text-muted-foreground/75">
                    <GroupIcon className="h-3.5 w-3.5" />
                    <span>{group.label}</span>
                  </div>
                  <div className="space-y-0.5">
                    {group.items.map((item, itemIndex) => {
                      const index = groupStartIndex + itemIndex;
                      const updatedAt = formatUpdatedAt(item.updatedAt, locale);
                      const meta = [item.cwd, updatedAt].filter(Boolean).join(" · ");
                      return (
                        <button
                          key={item.id}
                          type="button"
                          role="option"
                          aria-selected={index === activeIndex}
                          data-conversation-search-index={index}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => selectConversation(item.id)}
                          className={cn(
                            "w-full rounded-xl px-3 py-2.5 text-left outline-none transition-colors",
                            index === activeIndex
                              ? "bg-foreground/[0.07] text-foreground"
                              : "text-foreground/90 hover:bg-foreground/[0.045]",
                          )}
                        >
                          <div className="truncate text-sm font-medium leading-5">{item.title}</div>
                          {item.searchPreview ? (
                            <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                              {renderSearchPreview(item.searchPreview)}
                            </div>
                          ) : null}
                          {meta ? (
                            <div
                              className="mt-1 truncate text-[11px] leading-4 text-muted-foreground/70"
                              title={meta}
                            >
                              {meta}
                            </div>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
