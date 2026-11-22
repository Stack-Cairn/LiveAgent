import {
  AtSign,
  Check,
  Clock3,
  File as FileIcon,
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
import { Kbd, KbdShortcut } from "@liveagent/ui/components/ui/kbd";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  COMMAND_PALETTE_ACTIONS_PREFIX,
  COMMAND_PALETTE_CONVERSATIONS_PREFIX,
  COMMAND_PALETTE_FILES_PREFIX,
  COMMAND_PALETTE_GROUP_ORDER,
  type CommandPaletteAction,
  type CommandPaletteActionsProvider,
  type CommandPaletteFileSourceProvider,
  type CommandPaletteGroupId,
  type CommandPaletteScope,
  filterCommandPaletteActions,
  parseCommandPaletteQuery,
} from "@liveagent/ui/lib/chat/commandPalette";
import {
  type PersistedConversationSearchResult,
  searchPersistedConversations,
} from "@liveagent/ui/lib/chat/conversationSearch";
import {
  type QuickOpenMatch,
  splitQuickOpenHighlights,
} from "@liveagent/ui/lib/chat/fileQuickOpen";
import { setSearchJumpTarget } from "@liveagent/ui/lib/chat/searchJumpTarget";
import { cachedDateTimeFormat } from "@liveagent/ui/lib/shared/intlFormatters";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationOpenOptions } from "../../lib/sidebar/openController";
import type { SidebarConversation } from "../../lib/sidebar/types";
import { useQuickOpenFiles } from "./useQuickOpenFiles";

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
  /** Workspace for the `@` file scope, read once each time the palette opens. */
  getFileSource?: CommandPaletteFileSourceProvider;
  /**
   * Query the palette starts with (for example `@` to open straight into the
   * file scope). Applied on open and whenever `openRequestKey` changes.
   */
  initialQuery?: string;
  openRequestKey?: number;
};

type SearchStatus = "idle" | "loading" | "ready" | "error";

type PaletteItem =
  | { kind: "conversation"; key: string; item: PersistedConversationSearchResult }
  | { kind: "action"; key: string; action: CommandPaletteAction }
  | { kind: "file"; key: string; match: QuickOpenMatch };

type SearchGroup = {
  id: "pinned" | "recent" | "results" | "actions" | "files" | CommandPaletteGroupId;
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

function fileItem(match: QuickOpenMatch): PaletteItem {
  return { kind: "file", key: `file:${match.path}`, match };
}

function paletteItemLabel(item: PaletteItem) {
  if (item.kind === "action") return item.action.label;
  if (item.kind === "file") return item.match.path;
  return item.item.title;
}

const SCOPE_HINTS: ReadonlyArray<{
  scope: Exclude<CommandPaletteScope, "all">;
  prefix: string;
  labelKey: string;
}> = [
  {
    scope: "actions",
    prefix: COMMAND_PALETTE_ACTIONS_PREFIX,
    labelKey: "chat.commandPalette.scope.actions",
  },
  {
    scope: "files",
    prefix: COMMAND_PALETTE_FILES_PREFIX,
    labelKey: "chat.commandPalette.scope.files",
  },
  {
    scope: "conversations",
    prefix: COMMAND_PALETTE_CONVERSATIONS_PREFIX,
    labelKey: "chat.commandPalette.scope.conversations",
  },
];

function HighlightedText({
  text,
  positions,
  offset,
}: {
  text: string;
  positions: readonly number[];
  offset: number;
}) {
  return (
    <>
      {splitQuickOpenHighlights(text, positions, offset).map((run, index) =>
        run.highlighted ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
          <mark key={index} className="rounded-sm bg-transparent font-semibold text-foreground">
            {run.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
          <Fragment key={index}>{run.text}</Fragment>
        ),
      )}
    </>
  );
}

function splitFilePath(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { directory: "", name: path, nameOffset: 0 }
    : { directory: path.slice(0, slash), name: path.slice(slash + 1), nameOffset: slash + 1 };
}

function toSearchResult(item: SidebarConversation): PersistedConversationSearchResult {
  return {
    id: item.id,
    title: item.title,
    cwd: item.cwd,
    updatedAt: item.updatedAt,
  };
}

function formatChineseUpdatedAt(date: Date, locale: string, template: string) {
  const parts = cachedDateTimeFormat(locale, "search-updated-at-zh", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: "month" | "day" | "hour" | "minute") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return template
    .replace("{month}", read("month"))
    .replace("{day}", read("day"))
    .replace("{hour}", read("hour"))
    .replace("{minute}", read("minute"));
}

function formatUpdatedAt(value: number | undefined, locale: string, t: (key: string) => string) {
  if (!value || !Number.isFinite(value)) return "";
  const date = new Date(value);
  if (locale.toLowerCase().startsWith("zh")) {
    return formatChineseUpdatedAt(date, locale, t("chat.conversationSearchUpdatedAtZh"));
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
  getFileSource,
  initialQuery = "",
  openRequestKey = 0,
}: ConversationSearchDialogProps) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersistedConversationSearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const requestSequenceRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const paletteMode = mode === "palette" && Boolean(getActions);
  const parsedQuery = paletteMode
    ? parseCommandPaletteQuery(query)
    : { scope: "conversations" as const, actionsOnly: false, query: query.trim() };
  const scope: CommandPaletteScope = parsedQuery.scope;
  const actionsOnly = scope === "actions";
  const filesOnly = scope === "files";
  const showsActions = paletteMode && (scope === "all" || scope === "actions");
  const showsConversations = scope === "all" || scope === "conversations";
  // `>` and `@` limit the palette to one source: no conversation search request is made.
  const normalizedQuery = showsConversations ? parsedQuery.query : "";
  const actionQuery = parsedQuery.query;
  const fileSource = useMemo(
    () => (open && paletteMode && getFileSource ? getFileSource() : null),
    [getFileSource, open, paletteMode],
  );
  const quickOpen = useQuickOpenFiles({
    active: open && paletteMode && filesOnly,
    source: fileSource,
    query: parsedQuery.query,
  });
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

  // Opening (or re-requesting while open) starts from the requested query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: openRequestKey is the request signal.
  useEffect(() => {
    if (open) setQuery(initialQuery);
  }, [open, openRequestKey]);

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
    () => (showsActions ? filterCommandPaletteActions(actions, actionQuery) : NO_ACTIONS),
    [actionQuery, actions, showsActions],
  );

  const fileGroups = useMemo<SearchGroup[]>(
    () =>
      filesOnly && quickOpen.matches.length > 0
        ? [
            {
              id: "files",
              label: t("chat.commandPalette.files"),
              icon: AtSign,
              items: quickOpen.matches.map(fileItem),
            },
          ]
        : [],
    [filesOnly, quickOpen.matches, t],
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
    if (!showsConversations) return [];
    // `#` behaves like the plain conversation search: the full recent list.
    const compactHome = paletteMode && scope === "all";
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
      .slice(0, compactHome ? PALETTE_EMPTY_STATE_RECENT_LIMIT : EMPTY_STATE_RECENT_LIMIT)
      .map(toSearchResult);
    return [
      ...(pinned.length > 0
        ? [
            {
              id: "pinned" as const,
              label: t("chat.pinnedConversations"),
              icon: Pin,
              items: (compactHome ? pinned.slice(0, PALETTE_EMPTY_STATE_RECENT_LIMIT) : pinned).map(
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
  }, [conversations, normalizedQuery, paletteMode, results, scope, showsConversations, t]);

  const groups = useMemo(
    () => [...fileGroups, ...actionGroups, ...conversationGroups],
    [actionGroups, conversationGroups, fileGroups],
  );
  const hasVisibleActions = actionGroups.length > 0;
  const showScopeHints = paletteMode && query.trim() === "";

  const selectableItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  const runAction = (action: CommandPaletteAction) => {
    onOpenChange(false);
    action.run();
  };

  const openFile = (match: QuickOpenMatch) => {
    const source = fileSource;
    onOpenChange(false);
    source?.open(match.path);
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
            ref={inputRef}
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
          {showScopeHints ? (
            <div
              data-command-palette-scope-hints=""
              className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground"
            >
              <span>{t("chat.commandPalette.scopeHintsLabel")}</span>
              {SCOPE_HINTS.map((hint) => (
                <button
                  key={hint.scope}
                  type="button"
                  data-command-palette-scope={hint.scope}
                  onClick={() => {
                    setQuery(hint.prefix);
                    inputRef.current?.focus();
                  }}
                  className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Kbd>{hint.prefix}</Kbd>
                  {t(hint.labelKey)}
                </button>
              ))}
            </div>
          ) : null}
          <CommandPanel
            aria-busy={status === "loading" || (filesOnly && quickOpen.status === "loading")}
          >
            {filesOnly ? (
              fileGroups.length > 0 ? null : quickOpen.status === "error" ? (
                <div
                  role="alert"
                  className="flex min-h-200px flex-col items-center justify-center gap-3 px-8 text-center text-sm"
                >
                  <span className="text-destructive">{t("chat.commandPalette.filesFailed")}</span>
                  <Button variant="outline" size="sm" onClick={quickOpen.retry}>
                    {t("chat.retryConversationSearch")}
                  </Button>
                </div>
              ) : (
                <div
                  role="status"
                  className="flex min-h-200px flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground"
                >
                  <FileIcon className="size-8 opacity-40" />
                  {quickOpen.status === "unavailable"
                    ? t("chat.commandPalette.filesUnavailable")
                    : quickOpen.status === "loading"
                      ? t("chat.commandPalette.filesLoading")
                      : t("chat.commandPalette.noFiles")}
                </div>
              )
            ) : hasVisibleActions ? null : status === "error" ? (
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
                        if (entry.kind === "file") {
                          const { match } = entry;
                          const { directory, name, nameOffset } = splitFilePath(match.path);
                          return (
                            <CommandItem
                              key={entry.key}
                              value={entry}
                              data-command-palette-file={match.path}
                              onClick={() => openFile(match)}
                              className="flex-row items-center gap-3"
                              title={match.path}
                            >
                              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 shrink-0 truncate leading-5">
                                <HighlightedText
                                  text={name}
                                  positions={match.positions}
                                  offset={nameOffset}
                                />
                              </span>
                              {directory ? (
                                <span className="min-w-0 flex-1 truncate text-xs leading-5 text-muted-foreground">
                                  <HighlightedText
                                    text={directory}
                                    positions={match.positions}
                                    offset={0}
                                  />
                                </span>
                              ) : null}
                            </CommandItem>
                          );
                        }
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
                              {action.shortcut ? <Kbd>{action.shortcut}</Kbd> : null}
                            </CommandItem>
                          );
                        }
                        const { item } = entry;
                        const updatedAt = formatUpdatedAt(item.updatedAt, locale, t);
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
              {filesOnly && quickOpen.truncated && fileGroups.length > 0 ? (
                <div role="note" className="px-3 py-2 text-xs text-muted-foreground">
                  {t("chat.commandPalette.filesTruncated")}
                </div>
              ) : null}
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
              <span className="flex items-center">
                <KbdShortcut shortcut="ArrowUp" className="mr-0.5" />
                <KbdShortcut shortcut="ArrowDown" className="mr-1.5" />
                {t("chat.conversationSearchNavigate")}
              </span>
              <span className="flex items-center">
                <KbdShortcut shortcut="Enter" className="mr-1.5" />
                {t("chat.conversationSearchOpen")}
              </span>
              {paletteMode && !showScopeHints ? (
                <span className="flex items-center">
                  <Kbd className="mr-1.5">
                    {SCOPE_HINTS.find((hint) => hint.scope === scope)?.prefix ??
                      COMMAND_PALETTE_ACTIONS_PREFIX}
                  </Kbd>
                  {scope === "all"
                    ? t("chat.commandPalette.actionsOnlyHint")
                    : t(`chat.commandPalette.scope.${scope}`)}
                </span>
              ) : null}
            </div>
            <span className="flex items-center">
              <KbdShortcut shortcut="Escape" className="mr-1.5" />
              {t("chat.conversationSearchClose")}
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
