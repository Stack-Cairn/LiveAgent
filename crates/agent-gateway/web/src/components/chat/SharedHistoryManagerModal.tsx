import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import type { ChatHistorySummary } from "../../lib/chat/chatHistory";
import { cn } from "../../lib/shared/utils";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  Share2,
  X,
} from "../icons";
import { Button } from "../ui/button";

export type ManagedHistoryShareStatus = {
  conversationId?: string;
  conversation_id?: string;
  enabled: boolean;
  token?: string;
  redactToolContent?: boolean;
  redact_tool_content?: boolean;
};

type SharedHistoryManagerModalProps = {
  conversations: ChatHistorySummary[];
  statuses: Readonly<Record<string, ManagedHistoryShareStatus | undefined>>;
  loadingIds: ReadonlySet<string>;
  updatingIds: ReadonlySet<string>;
  errors: Readonly<Record<string, string | undefined>>;
  listError?: string | null;
  shareOrigin?: string;
  shareOriginLoading?: boolean;
  onRefresh: () => void;
  onLoadStatus: (conversation: ChatHistorySummary) => void;
  onDisableShare: (conversation: ChatHistorySummary) => void;
  onSetRedactToolContent: (conversation: ChatHistorySummary, redactToolContent: boolean) => void;
  onClose: () => void;
};

function getBrowserOrigin() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.location.origin;
}

function resolveShareOrigin(explicitOrigin?: string) {
  const rawOrigin = explicitOrigin === undefined ? getBrowserOrigin() : explicitOrigin;
  const trimmed = rawOrigin.trim();
  if (!trimmed) {
    return "";
  }

  const schemeMatch = /^(https?|wss?):(.*)$/i.exec(trimmed);
  const withScheme = schemeMatch
    ? [
        schemeMatch[1].toLowerCase(),
        ":",
        schemeMatch[2].startsWith("//")
          ? schemeMatch[2]
          : `//${schemeMatch[2].replace(/^\/+/, "")}`,
      ].join("")
    : `https://${trimmed}`;
  const httpUrl = withScheme.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");

  try {
    const url = new URL(httpUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.hostname === "http" ||
      url.hostname === "https"
    ) {
      return "";
    }
    return url.origin.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function buildShareUrl(token: string, origin: string) {
  const normalizedToken = token.trim();
  if (!normalizedToken || !origin) {
    return "";
  }
  return `${origin}/share/${encodeURIComponent(normalizedToken)}`;
}

function formatConversationTime(timestamp: number | undefined, locale: string, fallback: string) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return fallback;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function ShareSwitch(props: { disabled: boolean; onDisable: () => void }) {
  const { disabled, onDisable } = props;
  const { t } = useLocale();
  return (
    <button
      type="button"
      role="switch"
      aria-checked="true"
      aria-label={t("sharedHistory.disableShare")}
      title={t("sharedHistory.disableShare")}
      disabled={disabled}
      onClick={onDisable}
      className="relative h-6 w-11 shrink-0 rounded-full bg-sky-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="absolute left-0.5 top-0.5 h-5 w-5 translate-x-5 rounded-full bg-white shadow-sm transition-transform" />
    </button>
  );
}

function RedactionPicker(props: {
  value: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const { value, disabled, onChange } = props;
  const { t } = useLocale();
  return (
    <div
      role="radiogroup"
      aria-label={t("sharedHistory.redactionTitle")}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-border/60 bg-muted/40 p-0.5",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={value}
        disabled={disabled}
        onClick={() => onChange(true)}
        className={cn(
          "relative rounded-full px-2.5 py-0.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/35 disabled:cursor-not-allowed",
          value
            ? "bg-emerald-500 text-white shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {t("settings.enable")}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={!value}
        disabled={disabled}
        onClick={() => onChange(false)}
        className={cn(
          "relative rounded-full px-2.5 py-0.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35 disabled:cursor-not-allowed",
          !value
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {t("settings.disable")}
      </button>
    </div>
  );
}

function isShareStatusRedacted(status: ManagedHistoryShareStatus | undefined) {
  return status?.redactToolContent === true || status?.redact_tool_content === true;
}

function EmptyState(props: { isFiltered: boolean }) {
  const { isFiltered } = props;
  const { t } = useLocale();
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-muted/20 px-6 py-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-500/15 bg-sky-500/10 text-sky-500">
        <Share2 className="h-5 w-5" />
      </div>
      <div className="mt-4 text-sm font-semibold text-foreground">
        {isFiltered ? t("sharedHistory.emptyFilteredTitle") : t("sharedHistory.emptyTitle")}
      </div>
      <div className="mt-1 max-w-[22rem] text-xs leading-5 text-muted-foreground">
        {isFiltered ? t("sharedHistory.emptyFilteredDesc") : t("sharedHistory.emptyDesc")}
      </div>
    </div>
  );
}

export function SharedHistoryManagerModal({
  conversations,
  statuses,
  loadingIds,
  updatingIds,
  errors,
  listError,
  shareOrigin,
  shareOriginLoading = false,
  onRefresh,
  onLoadStatus,
  onDisableShare,
  onSetRedactToolContent,
  onClose,
}: SharedHistoryManagerModalProps) {
  const { locale, t } = useLocale();
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const publicOrigin = resolveShareOrigin(shareOrigin);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredConversations = useMemo(
    () =>
      conversations.filter((conversation) => {
        if (!normalizedQuery) {
          return true;
        }
        return [
          conversation.title,
          conversation.model,
          conversation.providerId,
          conversation.cwd ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      }),
    [conversations, normalizedQuery],
  );
  const readyCount = conversations.filter((conversation) => {
    const status = statuses[conversation.id];
    return status?.enabled === true && Boolean(status.token?.trim());
  }).length;
  const hasLoading = conversations.some((conversation) => loadingIds.has(conversation.id));
  const copyableCount = publicOrigin ? readyCount : 0;

  function handleCopy(conversationId: string, url: string) {
    if (!url || !navigator.clipboard?.writeText) {
      return;
    }
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopiedId(conversationId);
        window.setTimeout(() => setCopiedId(null), 1500);
      })
      .catch(() => setCopiedId(null));
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("sharedHistory.managerLabel")}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl">
        <div className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-sky-500/20 bg-sky-500/10 text-sky-500">
                <Share2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="text-base font-semibold text-foreground">
                  {t("sharedHistory.title")}
                </div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("sharedHistory.subtitle")}
                </div>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8 shrink-0 rounded-xl text-muted-foreground hover:text-foreground"
              title={t("sharedHistory.close")}
              aria-label={t("sharedHistory.close")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <div className="min-w-0 rounded-2xl border border-border/60 bg-muted/25 px-2.5 py-2 sm:px-3">
              <div className="truncate text-[calc(10px*var(--zone-font-scale,1))] font-medium uppercase leading-4 text-muted-foreground sm:text-[calc(11px*var(--zone-font-scale,1))]">
                {t("sharedHistory.summaryShared")}
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground">
                {conversations.length}
              </div>
            </div>
            <div className="min-w-0 rounded-2xl border border-border/60 bg-muted/25 px-2.5 py-2 sm:px-3">
              <div className="truncate text-[calc(10px*var(--zone-font-scale,1))] font-medium uppercase leading-4 text-muted-foreground sm:text-[calc(11px*var(--zone-font-scale,1))]">
                {t("sharedHistory.summaryCopyable")}
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground">{copyableCount}</div>
            </div>
            <div className="min-w-0 rounded-2xl border border-border/60 bg-muted/25 px-2.5 py-2 sm:px-3">
              <div className="truncate text-[calc(10px*var(--zone-font-scale,1))] font-medium uppercase leading-4 text-muted-foreground sm:text-[calc(11px*var(--zone-font-scale,1))]">
                {t("sharedHistory.summaryStatus")}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground sm:gap-2">
                {hasLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" /> : null}
                <span className="truncate">
                  {hasLoading ? t("sharedHistory.syncing") : t("sharedHistory.synced")}
                </span>
              </div>
            </div>
          </div>

          {!shareOriginLoading && !publicOrigin ? (
            <div className="mt-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
              {t("sharedHistory.originUnavailable")}
            </div>
          ) : shareOriginLoading && !publicOrigin ? (
            <div className="mt-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs leading-5 text-sky-700 dark:text-sky-300">
              {t("sharedHistory.originLoading")}
            </div>
          ) : null}

          {listError ? (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 rounded-2xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{listError}</span>
            </div>
          ) : null}

          <div className="mt-4 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t("sharedHistory.searchPlaceholder")}
                className="h-9 w-full rounded-xl border border-border/70 bg-background px-9 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-sky-500/45 focus:ring-2 focus:ring-sky-500/15"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={onRefresh}
              size="icon"
              className="h-9 w-9 shrink-0 rounded-xl border-border/70"
              title={t("sharedHistory.refresh")}
              aria-label={t("sharedHistory.refresh")}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {filteredConversations.length === 0 ? (
            <EmptyState isFiltered={conversations.length > 0 && Boolean(normalizedQuery)} />
          ) : (
            <div className="space-y-2.5">
              {filteredConversations.map((conversation) => {
                const status = statuses[conversation.id];
                const token = status?.enabled === true ? (status.token?.trim() ?? "") : "";
                const redactToolContent = isShareStatusRedacted(status);
                const shareUrl = buildShareUrl(token, publicOrigin);
                const isLoading = loadingIds.has(conversation.id);
                const isUpdating = updatingIds.has(conversation.id);
                const error = errors[conversation.id];
                const messageCount =
                  typeof conversation.messageCount === "number"
                    ? t("sharedHistory.messageCount").replace(
                        "{count}",
                        String(conversation.messageCount),
                      )
                    : t("sharedHistory.messageCountUnknown");

                return (
                  <div
                    key={conversation.id}
                    className="rounded-2xl border border-border/65 bg-background px-4 py-3 shadow-xs shadow-black/5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                            {conversation.title}
                          </span>
                          <span className="shrink-0 rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-sky-600 dark:text-sky-400">
                            {t("sharedHistory.publicBadge")}
                          </span>
                          {redactToolContent ? (
                            <span className="shrink-0 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium text-emerald-600 dark:text-emerald-400">
                              {t("sharedHistory.redactedBadge")}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[calc(11px*var(--zone-font-scale,1))] text-muted-foreground">
                          <span>{messageCount}</span>
                          <span>
                            {t("sharedHistory.updatedAt").replace(
                              "{time}",
                              formatConversationTime(
                                conversation.updatedAt,
                                locale,
                                t("sharedHistory.timeUnknown"),
                              ),
                            )}
                          </span>
                          <span className="max-w-[18rem] truncate">{conversation.model}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {isLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
                        ) : null}
                        <ShareSwitch
                          disabled={isUpdating}
                          onDisable={() => onDisableShare(conversation)}
                        />
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2">
                      <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {shareUrl ? (
                        <a
                          href={shareUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 truncate font-mono text-xs text-sky-600 underline-offset-4 hover:underline dark:text-sky-400"
                          title={shareUrl}
                        >
                          {shareUrl}
                        </a>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {isLoading
                            ? t("sharedHistory.loadingLink")
                            : shareOriginLoading && token
                              ? t("sharedHistory.loadingGateway")
                              : token
                                ? token
                                : t("sharedHistory.linkPending")}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleCopy(conversation.id, shareUrl)}
                        disabled={!shareUrl}
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors",
                          shareUrl
                            ? "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                            : "cursor-not-allowed text-muted-foreground/40",
                        )}
                        title={t("sharedHistory.copyLink")}
                        aria-label={t("sharedHistory.copyLink")}
                      >
                        {copiedId === conversation.id ? (
                          <Check className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </button>
                      <a
                        href={shareUrl || undefined}
                        target="_blank"
                        rel="noreferrer"
                        aria-disabled={!shareUrl}
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors",
                          shareUrl
                            ? "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                            : "pointer-events-none text-muted-foreground/40",
                        )}
                        title={t("sharedHistory.openLink")}
                        aria-label={t("sharedHistory.openLink")}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>

                    <div
                      className={cn(
                        "mt-2 flex items-center justify-between gap-3 rounded-xl border px-3 py-2 transition-colors",
                        redactToolContent
                          ? "border-emerald-500/25 bg-emerald-500/5"
                          : "border-border/60 bg-muted/20",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors",
                            redactToolContent
                              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "border-border/60 bg-background text-muted-foreground",
                          )}
                        >
                          {redactToolContent ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-foreground">
                            {t("sharedHistory.redactionTitle")}
                          </div>
                          <div
                            className="mt-0.5 truncate text-[calc(11px*var(--zone-font-scale,1))] leading-4 text-muted-foreground"
                            title={t("sharedHistory.redactionDescriptionTitle")}
                          >
                            {t("sharedHistory.redactionDescription")}
                          </div>
                        </div>
                      </div>
                      <RedactionPicker
                        value={redactToolContent}
                        disabled={isLoading || isUpdating || status?.enabled !== true}
                        onChange={(next) => {
                          if (next === redactToolContent) return;
                          onSetRedactToolContent(conversation, next);
                        }}
                      />
                    </div>

                    {error ? (
                      <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        <span className="min-w-0">{error}</span>
                        <button
                          type="button"
                          onClick={() => onLoadStatus(conversation)}
                          className="shrink-0 font-medium underline-offset-4 hover:underline"
                        >
                          {t("sharedHistory.retry")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
