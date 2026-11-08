import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Loader2,
  RefreshCw,
} from "@liveagent/ui/components/IconSet";
import { Button, RefreshButton } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cachedDateTimeFormat } from "@liveagent/ui/lib/shared/intlFormatters";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SidebarStoreArchive } from "../../lib/sidebar/store";
import type { SidebarConversation } from "../../lib/sidebar/types";

export const ARCHIVED_CONVERSATIONS_PAGE_SIZE = 30;

type ArchivedConversationsModalProps = {
  archive: SidebarStoreArchive;
  onClose: () => void;
};

function formatArchivedTime(timestamp: number, locale: string): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return cachedDateTimeFormat(locale, "archived-history-time", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/** Lists archived conversations and restores them to the sidebar. */
export function ArchivedConversationsModal({ archive, onClose }: ArchivedConversationsModalProps) {
  const { locale, t } = useLocale();
  const [items, setItems] = useState<SidebarConversation[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [restoringIds, setRestoringIds] = useState<ReadonlySet<string>>(() => new Set());
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const requestRef = useRef(0);

  const load = useCallback(
    async (nextPage: number) => {
      const request = ++requestRef.current;
      setLoading(true);
      setListError(null);
      try {
        const result = await archive.listArchived(nextPage, ARCHIVED_CONVERSATIONS_PAGE_SIZE);
        if (request !== requestRef.current) return;
        setItems((current) => {
          if (nextPage === 1) return result.items;
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...result.items.filter((item) => !seen.has(item.id))];
        });
        setTotalCount(result.totalCount);
        setPage(nextPage);
      } catch (error) {
        if (request !== requestRef.current) return;
        setListError(error instanceof Error && error.message ? error.message : String(error));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [archive],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  const handleUnarchive = (id: string) => {
    setRestoringIds((current) => new Set(current).add(id));
    setFailedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    void archive.setArchived(id, false).then((restored) => {
      setRestoringIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      if (restored) {
        setItems((current) => current.filter((item) => item.id !== id));
        setTotalCount((count) => Math.max(0, count - 1));
      } else {
        setFailedIds((current) => new Set(current).add(id));
      }
    });
  };

  const hasMore = items.length < totalCount;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-86dvh max-w-2xl flex-col p-0"
        closeLabel={t("chat.archivedConversations.close")}
        showCloseButton
        data-archived-conversations-modal=""
      >
        <DialogHeader>
          <div className="flex items-start gap-3 pr-8">
            <div
              className={cn(
                "flex size-11 shrink-0 items-center justify-center",
                "rounded-2xl border border-border/60 bg-muted/40 text-muted-foreground",
              )}
            >
              <Archive className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base leading-normal">
                {t("chat.archivedConversations.title")}
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-5">
                {t("chat.archivedConversations.subtitle")}
              </DialogDescription>
            </div>
            <RefreshButton
              aria-busy={loading}
              type="button"
              variant="outline"
              onClick={() => void load(1)}
              size="icon"
              className="shrink-0 rounded-xl border-border/70"
              title={t("chat.archivedConversations.refresh")}
              aria-label={t("chat.archivedConversations.refresh")}
            >
              <RefreshCw data-refresh-icon className="size-4" />
            </RefreshButton>
          </div>
          {listError ? (
            <div
              role="alert"
              className={cn(
                "mt-3 flex items-start gap-2",
                "rounded-2xl border border-destructive/25 bg-destructive/10 px-3 py-2",
                "text-xs leading-5 text-destructive",
              )}
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">
                {t("chat.archivedConversations.loadFailed")} {listError}
              </span>
            </div>
          ) : null}
        </DialogHeader>

        <DialogBody>
          {items.length === 0 ? (
            <div
              className={cn(
                "flex min-h-40 flex-col items-center justify-center gap-2",
                "rounded-2xl border border-dashed border-border/70 bg-muted/20 px-6 py-8 text-center",
                "text-xs text-muted-foreground",
              )}
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <>
                  <Archive className="size-5" />
                  <span>{t("chat.archivedConversations.empty")}</span>
                </>
              )}
            </div>
          ) : (
            <ul className="space-y-2" data-archived-conversations-list="">
              {items.map((item) => {
                const restoring = restoringIds.has(item.id);
                const failed = failedIds.has(item.id);
                const time = formatArchivedTime(item.updatedAt, locale);
                return (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 rounded-2xl border border-border/65 bg-background px-4 py-2.5"
                    data-archived-conversation-id={item.id}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {item.title || t("chat.runNotification.untitled")}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        {time ? <span className="shrink-0">{time}</span> : null}
                        {item.cwd ? <span className="min-w-0 truncate">{item.cwd}</span> : null}
                      </div>
                      {failed ? (
                        <div role="alert" className="mt-1 text-xs text-destructive">
                          {t("chat.history.archiveFailed")}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 rounded-xl"
                      disabled={restoring}
                      onClick={() => handleUnarchive(item.id)}
                      data-unarchive-conversation=""
                    >
                      {restoring ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <ArchiveRestore className="size-3.5" />
                      )}
                      {t("chat.conversationUnarchive")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {hasMore ? (
            <div className="mt-3 flex justify-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={loading}
                onClick={() => void load(page + 1)}
              >
                {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t("chat.archivedConversations.loadMore")}
              </Button>
            </div>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
