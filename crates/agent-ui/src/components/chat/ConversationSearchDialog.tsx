import { Clock3, Loader2, MessageSquareText, Pin, Search } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandDialogDescription,
  CommandDialogPopup,
  CommandDialogTitle,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "@liveagent/ui/components/ui/command";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type PersistedConversationSearchResult,
  searchPersistedConversations,
} from "@liveagent/ui/lib/chat/conversationSearch";
import { cachedDateTimeFormat } from "@liveagent/ui/lib/shared/intlFormatters";
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

function formatChineseUpdatedAt(date: Date, locale: string) {
  const parts = cachedDateTimeFormat(locale, "search-updated-at-zh", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: "month" | "day" | "hour" | "minute") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("month")}月${read("day")}日 ${read("hour")}:${read("minute")}`;
}

function formatUpdatedAt(value: number | undefined, locale: string) {
  if (!value || !Number.isFinite(value)) return "";
  const date = new Date(value);
  if (locale.toLowerCase().startsWith("zh")) {
    return formatChineseUpdatedAt(date, locale);
  }
  return cachedDateTimeFormat(locale, "search-updated-at", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
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
  const requestSequenceRef = useRef(0);
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

  const selectConversation = (id: string) => {
    onOpenChange(false);
    const isLocalDraft =
      !normalizedQuery && conversations.some((item) => item.id === id && item.isPending);
    onSelectConversation(id, isLocalDraft ? undefined : { source: "search" });
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup data-conversation-search-dialog="" className="max-h-[min(640px,80dvh)]">
        <CommandDialogTitle className="sr-only">{t("chat.searchConversations")}</CommandDialogTitle>
        <CommandDialogDescription className="sr-only">
          {t("chat.searchConversationsDescription")}
        </CommandDialogDescription>
        <Command
          items={selectableItems}
          value={query}
          onValueChange={setQuery}
          itemToStringValue={(item) => item.title}
          filter={null}
          mode="none"
          loopFocus={false}
        >
          <CommandInput
            onKeyDownCapture={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.keyCode === 229 ||
                event.key === "Home" ||
                event.key === "End"
              )
                event.stopPropagation();
            }}
            aria-label={t("chat.searchConversations")}
            placeholder={t("chat.searchConversationsPlaceholder")}
            startAddon={
              status === "loading" ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
              ) : undefined
            }
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onOpenChange(false);
              }
            }}
          />
          <CommandPanel aria-busy={status === "loading"}>
            {status === "error" ? (
              <div
                role="alert"
                className="flex min-h-200px flex-col items-center justify-center gap-3 px-8 text-center text-sm"
              >
                <span className="text-destructive">{t("chat.conversationSearchFailed")}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void performSearch(normalizedQuery)}
                >
                  {t("chat.retryConversationSearch")}
                </Button>
              </div>
            ) : status === "loading" ? (
              <div
                role="status"
                className="flex min-h-200px items-center justify-center text-sm text-muted-foreground"
              >
                {t("chat.conversationSearchLoading")}
              </div>
            ) : selectableItems.length === 0 ? (
              <div
                role="status"
                className="flex min-h-200px flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground"
              >
                <MessageSquareText className="size-8 opacity-40" />
                {normalizedQuery
                  ? t("chat.noConversationSearchResults")
                  : t("chat.searchConversationsDescription")}
              </div>
            ) : null}
            <CommandList
              aria-label={t("chat.searchConversations")}
              className={cn("max-h-[min(52vh,440px)]", selectableItems.length === 0 && "p-0")}
            >
              {groups
                .filter((group) => group.items.length > 0)
                .map((group) => {
                  const GroupIcon = group.icon;
                  return (
                    <CommandGroup key={group.id} items={group.items}>
                      <CommandGroupLabel>
                        <GroupIcon className="size-3.5" />
                        {group.label}
                      </CommandGroupLabel>
                      {group.items.map((item) => {
                        const updatedAt = formatUpdatedAt(item.updatedAt, locale);
                        const meta = [item.cwd, updatedAt].filter(Boolean).join(" · ");
                        return (
                          <CommandItem
                            key={item.id}
                            value={item}
                            onClick={() => selectConversation(item.id)}
                          >
                            <div className="w-full truncate font-medium leading-5">
                              {item.title}
                            </div>
                            {item.searchPreview ? (
                              <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                {renderSearchPreview(item.searchPreview)}
                              </div>
                            ) : null}
                            {item.cwd || updatedAt ? (
                              <div
                                className="mt-1 flex w-full items-center gap-3 text-xs leading-4 text-muted-foreground"
                                title={meta}
                              >
                                <span className="min-w-0 flex-1 truncate">{item.cwd}</span>
                                <span className="shrink-0 tabular-nums">{updatedAt}</span>
                              </div>
                            ) : null}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  );
                })}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <div className="flex items-center gap-4">
              <span>
                <kbd className="mr-1.5 rounded border border-foreground/10 px-1">↑ ↓</kbd>
                {t("chat.conversationSearchNavigate")}
              </span>
              <span>
                <kbd className="mr-1.5 rounded border border-foreground/10 px-1">↵</kbd>
                {t("chat.conversationSearchOpen")}
              </span>
            </div>
            <span>
              <kbd className="mr-1.5 rounded border border-foreground/10 px-1">Esc</kbd>
              {t("chat.conversationSearchClose")}
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
