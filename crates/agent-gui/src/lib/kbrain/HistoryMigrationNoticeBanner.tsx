import { X } from "@liveagent/ui/components/IconSet";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { useLocale } from "@liveagent/ui/i18n";
import { useSyncExternalStore } from "react";
import {
  dismissHistoryMigrationFailures,
  getHistoryMigrationFailures,
  subscribeHistoryMigrationFailures,
} from "./historyMigrationFailures";
import { kBrainStorageScope } from "./mapping";

/** App-level notice for legacy conversations that could not be migrated into K-brain. */
export function HistoryMigrationNoticeBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useLocale();
  const scope = kBrainStorageScope();
  const { undismissed } = useSyncExternalStore(subscribeHistoryMigrationFailures, () =>
    getHistoryMigrationFailures(scope),
  );
  const { confirm, dialog } = useConfirmDialog();
  if (undismissed.length === 0) return dialog;

  async function dismiss() {
    const confirmed = await confirm({
      title: t("historyImport.notice.dismissTitle"),
      description: t("historyImport.notice.dismissDescription"),
      confirmLabel: t("historyImport.notice.dismissConfirm"),
      cancelLabel: t("historyImport.notice.cancel"),
      preferCancel: true,
    });
    if (confirmed) dismissHistoryMigrationFailures(scope, undismissed);
  }

  return (
    <>
      <SettingsNotice
        variant="warning"
        role="status"
        aria-live="polite"
        data-testid="history-migration-notice"
        className="relative m-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 pr-9"
      >
        <div className="min-w-0 flex-1 basis-64 break-words">
          <p className="font-medium">
            {t("historyImport.notice.title").replace("{count}", String(undismissed.length))}
          </p>
          <p>{t("historyImport.notice.description")}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          {t("historyImport.notice.view")}
        </Button>
        <button
          type="button"
          className="absolute top-1.5 right-1.5 rounded p-1 opacity-70 has-hover:hover:bg-amber-500/10 has-hover:hover:opacity-100"
          aria-label={t("historyImport.notice.dismiss")}
          title={t("historyImport.notice.dismiss")}
          onClick={() => void dismiss()}
        >
          <X className="size-3.5" />
        </button>
      </SettingsNotice>
      {dialog}
    </>
  );
}
