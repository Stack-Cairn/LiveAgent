import {
  Check,
  Clock3,
  Loader2,
  MessageSquareText,
  Pin,
  Search,
  Sparkles,
} from "@liveagent/ui/components/IconSet";
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
  COMMAND_PALETTE_GROUP_ORDER,
  type CommandPaletteAction,
  type CommandPaletteActionsProvider,
  type CommandPaletteGroupId,
  filterCommandPaletteActions,
  parseCommandPaletteQuery,
} from "@liveagent/ui/lib/chat/commandPalette";
import {
  type PersistedConversationSearchResult,
  searchPersistedConversations,
} from "@liveagent/ui/lib/chat/conversationSearch";
import { setSearchJumpTarget } from "@liveagent/ui/lib/chat/searchJumpTarget";
import { cachedDateTimeFormat } from "@liveagent/ui/lib/shared/intlFormatters";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationOpenOptions } from "../../lib/sidebar/openController";
import type { SidebarConversation } from "../../lib/sidebar/types";

export type ConversationSearchDialogMode = "search" | "palette";

type ConversationSearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: readonly SidebarConversation[];
  currentWorkdir?: string;
  onSelectConversation: (id: string, options?: ConversationOpenOptions) => void;
  /**
   * "palette" (Cmd/Ctrl+K) lists host actions next to the conversations;
   * "search" (sidebar button / configured search shortcut) stays a pure
   * conversation search.
   */
  mode?: ConversationSearchDialogMode;
  /** Snapshot of host actions, read once each time the palette opens. */
  getActions?: CommandPaletteActionsProvider;
};

type SearchStatus = "idle" | "loading" | "ready" | "error";

type PaletteItem =
  | { kind: "conversation"; key: string; item: PersistedConversationSearchResult }
  | { kind: "action"; key: string; action: CommandPaletteAction };

type SearchGroup = {
  id: "pinned" | "recent" | "results" | "actions" | CommandPaletteGroupId;
  label: string;
  icon: typeof Pin | null;
  items: readonly PaletteItem[];
};

const SEARCH_DEBOUNCE_MS = 180;
const EMPTY_STATE_RECENT_LIMIT = 12;
// The palette home screen leads with actions, so it only previews a few recents.
const PALETTE_EMPTY_STATE_RECENT_LIMIT = 5;
const NO_ACTIONS: readonly CommandPaletteAction[] = [];

function conversationItem(item: PersistedConversationSearchResult): PaletteItem {
  return { kind: "conversation", key: `conversation:${item.id}`, item };
}

function actionItem(action: CommandPaletteAction): PaletteItem {
  return { kind: "action", key: `action:${action.id}`, action };
}

function paletteItemLabel(item: PaletteItem) {
  return item.kind === "action" ? item.action.label : item.item.title;
}

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
  mode = "search",
  getActions,
}: ConversationSearchDialogProps) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersistedConversationSearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const requestSequenceRef = useRef(0);
  const paletteMode = mode === "palette" && Boolean(getActions);
  const parsedQuery = paletteMode
    ? parseCommandPaletteQuery(query)
    : { actionsOnly: false, query: query.trim() };
  const actionsOnly = parsedQuery.actionsOnly;
  // `>` limits the palette to actions: no conversation search request is made.
  const normalizedQuery = actionsOnly ? "" : parsedQuery.query;
  const actionQuery = parsedQuery.query;
  // Labels such as "Close sidebar" depend on host state, so read a fresh
  // snapshot every time the palette opens instead of subscribing to it.
  const actions = useMemo(
    () => (open && paletteMode && getActions ? getActions() : NO_ACTIONS),
    [getActions, open, paletteMode],
  );

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

  const matchedActions = useMemo(
    () => (paletteMode ? filterCommandPaletteActions(actions, actionQuery) : NO_ACTIONS),
    [actionQuery, actions, paletteMode],
  );

  const actionGroups = useMemo<SearchGroup[]>(() => {
    if (matchedActions.length === 0) return [];
    if (actionQuery) {
      return [
        {
          id: "actions",
          label: t("chat.commandPalette.actions"),
          icon: Sparkles,
          items: matchedActions.map(actionItem),
        },
      ];
    }
    return COMMAND_PALETTE_GROUP_ORDER.flatMap((groupId) => {
      const items = matchedActions.filter((action) => action.group === groupId);
      return items.length > 0
        ? [
            {
              id: groupId,
              label: t(`chat.commandPalette.group.${groupId}`),
              icon: null,
              items: items.map(actionItem),
            },
          ]
        : [];
    });
  }, [actionQuery, matchedActions, t]);

  const conversationGroups = useMemo<SearchGroup[]>(() => {
    if (actionsOnly) return [];
    if (normalizedQuery) {
      return [
        {
          id: "results",
          label: t("chat.conversationSearchResults"),
          icon: Search,
          items: results.map(conversationItem),
        },
      ];
    }

    const pinned = conversations.filter((item) => item.isPinned).map(toSearchResult);
    const recent = conversations
      .filter((item) => !item.isPinned)
      .slice(0, paletteMode ? PALETTE_EMPTY_STATE_RECENT_LIMIT : EMPTY_STATE_RECENT_LIMIT)
      .map(toSearchResult);
    return [
      ...(pinned.length > 0
        ? [
            {
              id: "pinned" as const,
              label: t("chat.pinnedConversations"),
              icon: Pin,
              items: (paletteMode ? pinned.slice(0, PALETTE_EMPTY_STATE_RECENT_LIMIT) : pinned).map(
                conversationItem,
              ),
            },
          ]
        : []),
      {
        id: "recent",
        label: t("chat.recentConversation"),
        icon: Clock3,
        items: recent.map(conversationItem),
      },
    ];
  }, [actionsOnly, conversations, normalizedQuery, paletteMode, results, t]);

  const groups = useMemo(
    () => [...actionGroups, ...conversationGroups],
    [actionGroups, conversationGroups],
  );
  const hasVisibleActions = actionGroups.length > 0;

  const selectableItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  const runAction = (action: CommandPaletteAction) => {
    onOpenChange(false);
    action.run();
  };

  const selectConversation = (item: PersistedConversationSearchResult) => {
    const { id } = item;
    onOpenChange(false);
    setSearchJumpTarget(
      normalizedQuery
        ? { conversationId: id, messageId: item.messageId, messageIndex: item.messageIndex }
        : null,
    );
    const isLocalDraft =
      !normalizedQuery && conversations.some((item) => item.id === id && item.isPending);
    onSelectConversation(id, isLocalDraft ? undefined : { source: "search" });
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup
        data-conversation-search-dialog=""
        data-command-palette={paletteMode ? "" : undefined}
        className="max-h-[min(640px,80dvh)]"
      >
        <CommandDialogTitle className="sr-only">
          {paletteMode ? t("chat.commandPalette.title") : t("chat.searchConversations")}
        </CommandDialogTitle>
        <CommandDialogDescription className="sr-only">
          {paletteMode
            ? t("chat.commandPalette.description")
            : t("chat.searchConversationsDescription")}
        </CommandDialogDescription>
        <Command
          items={selectableItems}
          value={query}
          onValueChange={setQuery}
          itemToStringValue={paletteItemLabel}
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
            aria-label={
              paletteMode ? t("chat.commandPalette.title") : t("chat.searchConversations")
            }
            placeholder={
              paletteMode
                ? t("chat.commandPalette.placeholder")
                : t("chat.searchConversationsPlaceholder")
            }
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
            {hasVisibleActions ? null : status === "error" ? (
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
                {actionsOnly
                  ? t("chat.commandPalette.noActions")
                  : normalizedQuery
                    ? t("chat.noConversationSearchResults")
                    : t("chat.searchConversationsDescription")}
              </div>
            ) : null}
            <CommandList
              aria-label={
                paletteMode ? t("chat.commandPalette.title") : t("chat.searchConversations")
              }
              className={cn("max-h-[min(52vh,440px)]", selectableItems.length === 0 && "p-0")}
            >
              {groups
                .filter((group) => group.items.length > 0)
                .map((group) => {
                  const GroupIcon = group.icon;
                  return (
                    <CommandGroup key={group.id} items={group.items}>
                      <CommandGroupLabel>
                        {GroupIcon ? <GroupIcon className="size-3.5" /> : null}
                        {group.label}
                      </CommandGroupLabel>
                      {group.items.map((entry) => {
                        if (entry.kind === "action") {
                          const { action } = entry;
                          const ActionIcon = action.icon;
                          return (
                            <CommandItem
                              key={entry.key}
                              value={entry}
                              data-command-palette-action={action.id}
                              onClick={() => runAction(action)}
                              className="flex-row items-center gap-3"
                            >
                              {ActionIcon ? (
                                <ActionIcon className="size-4 shrink-0 text-muted-foreground" />
                              ) : (
                                <span aria-hidden="true" className="size-4 shrink-0" />
                              )}
                              <span className="min-w-0 flex-1 truncate leading-5">
                                {action.label}
                              </span>
                              {action.active ? (
                                <Check
                                  aria-label={t("chat.commandPalette.current")}
                                  className="size-3.5 shrink-0 text-primary"
                                />
                              ) : null}
                              {action.shortcut ? (
                                <kbd className="shrink-0 rounded border border-foreground/10 px-1 text-xs text-muted-foreground">
                                  {action.shortcut}
                                </kbd>
                              ) : null}
                            </CommandItem>
                          );
                        }
                        const { item } = entry;
                        const updatedAt = formatUpdatedAt(item.updatedAt, locale);
                        const meta = [item.cwd, updatedAt].filter(Boolean).join(" · ");
                        return (
                          <CommandItem
                            key={entry.key}
                            value={entry}
                            onClick={() => selectConversation(item)}
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
              {hasVisibleActions && status === "error" ? (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
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
              ) : null}
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
              {paletteMode ? (
                <span>
                  <kbd className="mr-1.5 rounded border border-foreground/10 px-1">&gt;</kbd>
                  {t("chat.commandPalette.actionsOnlyHint")}
                </span>
              ) : null}
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
